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
// Pennylane "Use Cursor-Based Pagination").
async function getAllPaginated(endpoint) {
  const items = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams({ per_page: '100' });
    if (cursor) params.set('cursor', cursor);
    const json = await pennylaneFetch(`/${endpoint}?${params.toString()}`);
    const batch = Array.isArray(json) ? json : (json.items || []);
    items.push(...batch);
    cursor = (json.meta && json.meta.next_cursor) || null;
    if (!cursor || !batch.length) break;
  }
  return items;
}

function customerIdOf(invoice) {
  const id = (invoice.customer && invoice.customer.id) ?? invoice.customer_id ?? null;
  return id != null ? String(id) : null;
}

function remainingAmountOf(invoice) {
  const v = invoice.remaining_amount_with_tax ?? invoice.remaining_amount ?? 0;
  return Number(v) || 0;
}

function amountOf(invoice) {
  const v = invoice.amount_with_tax ?? invoice.total_with_tax ?? invoice.amount ?? 0;
  return Number(v) || 0;
}

// Synchro COMPLÈTE à chaque appel (V1) : au volume annoncé (quelques
// centaines à ~1-2 milliers de factures/an pour 4-5M€ de CA), rester simple
// l'emporte sur une synchro incrémentale via /customer_invoices/changes —
// qui de toute façon ne conserve que 4 semaines d'historique et ne suffirait
// pas seule à un tout premier chargement. À revisiter si le volume grossit
// au point de rendre une synchro complète trop lente/coûteuse en requêtes.
async function syncFinance(db) {
  const invoices = await getAllPaginated('customer_invoices');
  const customers = await getAllPaginated('customers');

  if (process.env.PENNYLANE_DEBUG_RAW === '1') {
    if (invoices[0]) console.log('[PENNYLANE_DEBUG_RAW] exemple de facture brute :', JSON.stringify(invoices[0], null, 2));
    if (customers[0]) console.log('[PENNYLANE_DEBUG_RAW] exemple de client brut :', JSON.stringify(customers[0], null, 2));
  }

  const upsertCustomer = db.prepare(`
    INSERT INTO pennylane_customers (id, name, email, phone, synced_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, email=excluded.email, phone=excluded.phone, synced_at=excluded.synced_at
  `);
  const upsertInvoice = db.prepare(`
    INSERT INTO pennylane_invoices (id, invoice_number, customer_id, date_emission, deadline, amount, remaining_amount, status, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      invoice_number=excluded.invoice_number, customer_id=excluded.customer_id,
      date_emission=excluded.date_emission, deadline=excluded.deadline,
      amount=excluded.amount, remaining_amount=excluded.remaining_amount,
      status=excluded.status, synced_at=excluded.synced_at
  `);

  const runAll = db.transaction(() => {
    for (const c of customers) {
      upsertCustomer.run(
        String(c.id),
        c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
        c.email || c.billing_email || '',
        c.phone_number || c.phone || ''
      );
    }
    for (const inv of invoices) {
      // Brouillons/avoirs exclus : rien à recouvrer dessus (pas de deadline
      // de paiement exploitable) — inutile de polluer le cache avec.
      if (inv.draft || inv.credit_note) continue;
      upsertInvoice.run(
        String(inv.id),
        inv.invoice_number || null,
        customerIdOf(inv),
        inv.date || null,
        inv.deadline || null,
        amountOf(inv),
        remainingAmountOf(inv),
        inv.status || null
      );
    }
  });
  runAll();

  return { invoicesSynced: invoices.length, customersSynced: customers.length, syncedAt: new Date().toISOString() };
}

module.exports = { syncFinance, getAllPaginated, pennylaneFetch };
