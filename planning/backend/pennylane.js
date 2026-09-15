// ── CONNECTEUR PENNYLANE (recouvrement) ──────────────────────────────────────
// Pennylane reste la SOURCE DE VÉRITÉ de la facturation : ce module ne fait
// que LIRE l'API (jamais d'écriture côté Pennylane) et recopier ce qui nous
// intéresse dans un cache local (pennylane_invoices / pennylane_customers,
// voir ./db.js), pour construire notre propre outil de suivi des relances
// par-dessus (statut interne, attribution, historique — rien de tout ça
// n'existe côté Pennylane).
//
// Auth : token API simple (Pennylane > Paramètres > Connectivité >
// Développeurs), pas OAuth2 — un seul token pour une seule société, pas
// besoin du flux d'autorisation complet. Variable attendue :
//   PENNYLANE_API_TOKEN
//
// Rate limit : la doc publique Pennylane (v2) annonce 25 requêtes / 5
// secondes TOUS endpoints confondus (pas de palier plus strict documenté
// spécifiquement sur /customer_invoices, malgré une info contraire qu'on
// nous avait transmise) — on ne parie sur aucun chiffre précis : on
// intercepte les 429 et on respecte l'en-tête retry-after renvoyé par
// l'API, ce qui reste correct quel que soit le vrai palier.
//
// Noms de champs : ceux ci-dessous (deadline, remaining_amount_with_tax,
// customer.id...) sont ceux documentés par Pennylane, mais comme pour tout
// connecteur API externe, à reconfirmer sur un premier sync réel — mettez
// PENNYLANE_DEBUG_RAW=1 dans l'environnement pour faire logguer une facture
// et un client bruts (JSON complet) lors du prochain syncFinance().

const API_BASE = 'https://app.pennylane.com/api/external/v2';

function apiToken() {
  const t = process.env.PENNYLANE_API_TOKEN;
  if (!t) throw new Error('Pennylane non configuré (variable PENNYLANE_API_TOKEN manquante)');
  return t;
}

// Un seul point d'appel API, avec gestion du 429 par attente + nouvelle
// tentative (respecte l'en-tête retry-after plutôt que de deviner un délai).
async function pennylaneFetch(pathAndQuery, attempt = 1) {
  const res = await fetch(`${API_BASE}${pathAndQuery}`, {
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 429) {
    if (attempt > 5) throw new Error('Pennylane : limite de débit dépassée de façon persistante (429 répétés)');
    const retryAfter = Number(res.headers.get('retry-after')) || 2;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return pennylaneFetch(pathAndQuery, attempt + 1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pennylane API (${res.status}) sur ${pathAndQuery} : ${JSON.stringify(json)}`);
  return json;
}

// Récupère toutes les pages d'un endpoint (pagination par curseur — cf. doc
// Pennylane "Use Cursor-Based Pagination"). Le paramètre de taille de page
// documenté (v2) est `limit` (1-100) — PAS `per_page` (nom v1) : avec le
// mauvais nom, Pennylane l'ignore silencieusement et retombe sur son défaut
// de 20/page.
// `filter`, si fourni, est un objet/tableau passé tel quel en JSON dans le
// paramètre `filter` documenté par Pennylane (ex. filtrer les factures par
// date : cf. syncFinance ci-dessous).
//
// BUG CORRIGÉ : le curseur de page suivante est renvoyé par Pennylane au
// niveau RACINE de la réponse (`next_cursor`, à côté de `items`/`has_more`),
// PAS sous un objet `meta` (confirmé sur la doc officielle des deux
// endpoints utilisés ici, getcustomerinvoices et getcustomers — aucun des
// deux ne renvoie de `meta`). Le code précédent lisait `json.meta.next_cursor`,
// qui n'existe jamais : la pagination s'arrêtait donc TOUJOURS après la
// première page (100 éléments), quel que soit le volume réel côté Pennylane —
// d'où des factures manquantes en masse ET des clients manquants (donc des
// noms d'entreprise vides dès qu'un client n'était pas dans ce premier lot
// de 100). On garde un repli sur `meta.next_cursor` par prudence si jamais
// un endpoint futur l'utilise, mais `next_cursor` racine est prioritaire.
async function getAllPaginated(endpoint, filter) {
  const items = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    if (filter) params.set('filter', JSON.stringify(filter));
    const json = await pennylaneFetch(`/${endpoint}?${params.toString()}`);
    const batch = Array.isArray(json) ? json : (json.items || []);
    items.push(...batch);
    cursor = json.next_cursor ?? (json.meta && json.meta.next_cursor) ?? null;
    if (!cursor || !batch.length) break;
  }
  return items;
}

// Le `status` documenté par Pennylane inclut déjà 'draft'/'credit_note' comme
// valeurs possibles (pas seulement les statuts de paiement 'paid'/'late'/...),
// mais on ne parie pas dessus : si jamais `status` manque, on retombe sur les
// booléens dédiés `draft`/`credit_note` qui eux sont garantis par la doc.
function computedStatus(invoice) {
  if (invoice.status) return invoice.status;
  if (invoice.draft) return 'draft';
  if (invoice.credit_note) return 'credit_note';
  return null;
}

function customerIdOf(invoice) {
  const id = (invoice.customer && invoice.customer.id) ?? invoice.customer_id ?? null;
  return id != null ? String(id) : null;
}

// Champs confirmés sur le schéma réel d'une facture Pennylane (v2) :
// `amount` = total TTC converti en EUR, `tax` = TVA en EUR (donc
// HT = amount - tax), `remaining_amount_with_tax` / `remaining_amount_without_tax`
// = restant dû TTC/HT. Pas de champ `amount_with_tax` ni `remaining_amount`
// tout court (contrairement à une hypothèse de départ) — les .0 de secours
// ci-dessous ne servent qu'à encaisser une valeur manquante/nulle, pas un nom
// de champ différent.
function amountsOf(invoice) {
  const ttc = Number(invoice.amount) || 0;
  const tax = Number(invoice.tax) || 0;
  return {
    ht: Number((ttc - tax).toFixed(2)),
    ttc,
    remainingHt: Number(invoice.remaining_amount_without_tax) || 0,
    remainingTtc: Number(invoice.remaining_amount_with_tax) || 0,
  };
}

// Le contact (nom/mail/tel d'une VRAIE personne, pas juste la société) n'est
// pas embarqué dans la fiche client Pennylane : celle-ci ne fournit qu'une
// URL vers un sous-endpoint `/customers/{id}/contacts` (cf. doc Pennylane,
// champ `contacts.url`). On prend le premier contact renvoyé — Pennylane ne
// distingue pas de contact "principal" dans son modèle, donc c'est la
// meilleure approximation disponible sans configuration supplémentaire.
async function fetchPrimaryContact(contactsUrl) {
  if (!contactsUrl) return null;
  try {
    const path = contactsUrl.replace(API_BASE, '');
    const json = await pennylaneFetch(path);
    const list = Array.isArray(json) ? json : (json.items || []);
    const c = list[0];
    if (!c) return null;
    return {
      name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
      email: c.email || (Array.isArray(c.emails) ? c.emails[0] : '') || '',
      phone: c.phone || c.phone_number || '',
    };
  } catch (e) {
    console.warn(`[PENNYLANE] contact introuvable sur ${contactsUrl} :`, e.message);
    return null;
  }
}

// Synchro COMPLÈTE (pas incrémentale) à chaque appel, mais bornée à
// SYNC_SINCE (V1) : au volume annoncé (quelques centaines à ~1-2 milliers de
// factures/an pour 4-5M€ de CA) et sur la seule fenêtre pertinente pour le
// recouvrement, rester simple l'emporte sur une synchro incrémentale via
// /customer_invoices/changes — qui de toute façon ne conserve que 4 semaines
// d'historique et ne suffirait pas seule à un tout premier chargement. À
// revisiter si le volume grossit au point de rendre ça trop lent/coûteux.
// NB : un appel /contacts par client s'ajoute désormais à chaque synchro
// (voir fetchPrimaryContact) — plus lent qu'avant, mais c'est le seul moyen
// d'obtenir un nom/mail/tel de contact réel plutôt que la seule société.
// Point de départ de l'historique importé : les factures antérieures à cette
// date ne sont plus pertinentes pour le recouvrement (avant la mise en place
// de l'outil) et les exclure réduit d'autant le nombre de pages/appels API à
// chaque synchro. Ajustable sans redéploiement via PENNYLANE_SYNC_SINCE (ex.
// "2025-01-01") si le besoin change.
const SYNC_SINCE = process.env.PENNYLANE_SYNC_SINCE || '2025-09-01';

async function syncFinance(db) {
  const invoiceFilter = [{ field: 'date', operator: 'gteq', value: SYNC_SINCE }];
  const invoices = await getAllPaginated('customer_invoices', invoiceFilter);
  const customers = await getAllPaginated('customers');

  if (process.env.PENNYLANE_DEBUG_RAW === '1') {
    if (invoices[0]) console.log('[PENNYLANE_DEBUG_RAW] exemple de facture brute :', JSON.stringify(invoices[0], null, 2));
    if (customers[0]) console.log('[PENNYLANE_DEBUG_RAW] exemple de client brut :', JSON.stringify(customers[0], null, 2));
  }

  // Ne va chercher les contacts QUE pour les clients qui ont au moins une
  // facture encore due dans ce sync (inutile de multiplier les appels API
  // pour des clients soldés depuis longtemps qui n'apparaîtront nulle part
  // dans l'outil de recouvrement).
  const dueCustomerIds = new Set(
    invoices
      .filter((inv) => !inv.draft && !inv.credit_note && (Number(inv.remaining_amount_with_tax) || 0) > 0)
      .map((inv) => customerIdOf(inv))
      .filter(Boolean)
  );
  const contactsById = new Map();
  for (const c of customers) {
    if (!dueCustomerIds.has(String(c.id))) continue;
    const contact = await fetchPrimaryContact(c.contacts && c.contacts.url);
    if (contact) contactsById.set(String(c.id), contact);
    if (process.env.PENNYLANE_DEBUG_RAW === '1' && contact) {
      console.log(`[PENNYLANE_DEBUG_RAW] contact client ${c.id} :`, JSON.stringify(contact));
    }
  }

  const upsertCustomer = db.prepare(`
    INSERT INTO pennylane_customers (id, name, email, phone, contact_name, contact_email, contact_phone, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, email=excluded.email, phone=excluded.phone,
      contact_name=excluded.contact_name, contact_email=excluded.contact_email, contact_phone=excluded.contact_phone,
      synced_at=excluded.synced_at
  `);
  const upsertInvoice = db.prepare(`
    INSERT INTO pennylane_invoices (id, invoice_number, customer_id, date_emission, deadline, amount, amount_ht, remaining_amount, remaining_amount_ht, status, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      invoice_number=excluded.invoice_number, customer_id=excluded.customer_id,
      date_emission=excluded.date_emission, deadline=excluded.deadline,
      amount=excluded.amount, amount_ht=excluded.amount_ht,
      remaining_amount=excluded.remaining_amount, remaining_amount_ht=excluded.remaining_amount_ht,
      status=excluded.status, synced_at=excluded.synced_at
  `);

  // BUG CORRIGÉ : une facture déjà en base (importée avant l'ajout de
  // SYNC_SINCE, ou lors d'un test avec une valeur différente) mais dont la
  // date tombe désormais AVANT SYNC_SINCE n'est plus jamais re-demandée à
  // Pennylane (le filtre `date gteq SYNC_SINCE` l'exclut du fetch) — sa copie
  // locale restait donc figée pour toujours, avec un statut/reste-dû périmé.
  // C'est ce qui provoquait des incohérences du type "payée sur Pennylane
  // mais encore affichée en retard chez nous" (ex. Betao AB). On purge donc
  // à chaque synchro tout ce qui est hors de la fenêtre suivie — cohérent
  // avec la demande initiale ("importer depuis septembre 2025") : une facture
  // plus ancienne n'a de toute façon plus sa place dans l'outil.
  const purgeOldInvoices = db.prepare('DELETE FROM pennylane_invoices WHERE date_emission < ?');

  const runAll = db.transaction(() => {
    const purged = purgeOldInvoices.run(SYNC_SINCE).changes;
    for (const c of customers) {
      const contact = contactsById.get(String(c.id));
      upsertCustomer.run(
        String(c.id),
        c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
        (Array.isArray(c.emails) ? c.emails[0] : c.email) || '',
        c.phone || c.phone_number || '',
        contact ? contact.name : null,
        contact ? contact.email : null,
        contact ? contact.phone : null
      );
    }
    for (const inv of invoices) {
      // Brouillons/avoirs/annulées sont désormais bien enregistrés (avec leur
      // statut Pennylane d'origine) plutôt que sautés : ils n'ont rien à voir
      // avec le recouvrement (exclus de /api/finance/invoices et /kpis via le
      // filtre sur `status`, voir router.js), mais les compter permet de
      // vérifier d'un coup d'œil que la synchro a bien ramené tout ce que
      // Pennylane annonce dans son propre tableau de bord (Toutes/Brouillon/
      // Encaissée/Annulée/Avoir…), pas seulement les factures encore dues.
      const a = amountsOf(inv);
      upsertInvoice.run(
        String(inv.id),
        inv.invoice_number || null,
        customerIdOf(inv),
        inv.date || null,
        inv.deadline || null,
        a.ttc,
        a.ht,
        a.remainingTtc,
        a.remainingHt,
        computedStatus(inv)
      );
    }
    return purged;
  });
  const invoicesPurged = runAll();

  return {
    invoicesSynced: invoices.length,
    customersSynced: customers.length,
    invoicesPurged,
    syncedAt: new Date().toISOString(),
  };
}

// Un lien PDF public (`public_file_url`) est bien renvoyé par Pennylane, mais
// n'est valable que 30 minutes — on ne le met donc JAMAIS en cache, on le
// redemande à la demande (clic sur "Voir le PDF" côté app) via cet appel.
async function getInvoicePdfUrl(id) {
  const json = await pennylaneFetch(`/customer_invoices/${encodeURIComponent(id)}`);
  if (!json.public_file_url) throw new Error("Pennylane n'a renvoyé aucun PDF pour cette facture");
  return { url: json.public_file_url, filename: json.filename || null };
}

module.exports = { syncFinance, getInvoicePdfUrl, getAllPaginated, pennylaneFetch };
