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
// PENNYLANE_API_TOKEN
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

// Statut par défaut de l'échéance 1 (deadline_status_id) pour une facture
// nouvellement synchronisée (09/2026) : "Sans statut" (NULL) a été retiré
// comme état possible côté recouvrement, remplacé par "Douteux" — voir
// financeRoutes.js, defaultInstallmentStatusId() (même logique, dupliquée
// ici faute de dépendance directe entre les deux fichiers). Calculé une
// seule fois par appel de syncFinance/syncInvoiceChanges (pas une fois par
// facture) : avant, deadline_status_id était totalement absent du INSERT,
// donc toute nouvelle facture démarrait à NULL = "Sans statut" — c'était la
// cause la plus fréquente du problème remonté par Lina.
function defaultDeadlineStatusId(db) {
const row = db.prepare("SELECT id FROM finance_installment_statuses WHERE label='Douteux' ORDER BY sort_order ASC LIMIT 1").get();
return row ? row.id : null;
}

// Statuts Pennylane BRUTS qui veulent dire "il n'y a plus rien à relancer" —
// partagé par syncFinance (relecture complète) ET syncInvoiceChanges (check
// rapide, voir plus bas) : une seule liste, jamais deux copies qui pourraient
// diverger silencieusement (cf. le même souci documenté dans reports.js pour
// REPORTS_PENNYLANE_HORS_RECOUVREMENT).
const PENNYLANE_STATUSES_SOLDEES = ['paid', 'cancelled', 'partially_cancelled', 'credit_note'];

// Prepared statement partagé (client) — mêmes protections dans les deux sens
// d'appel (synchro complète ET check rapide) : COALESCE (09/2026, demande
// Lina "0 risque de suppression") — si l'appel en cours n'a pas pu récupérer
// le contact d'un client (échec réseau, lot interrompu...), on GARDE le
// contact déjà en base plutôt que de l'écraser par NULL. Avant ce fix, un
// simple échec ponctuel de récupération effaçait un contact valide enregistré
// lors d'un sync précédent. Contrepartie acceptée : si un contact est un jour
// réellement supprimé côté Pennylane (cas très rare), l'ancienne valeur reste
// affichée jusqu'à ce qu'un contact différent soit resynchronisé avec succès.
function buildUpsertCustomer(db) {
return db.prepare(`
INSERT INTO pennylane_customers (id, name, email, phone, contact_name, contact_email, contact_phone, synced_at)
VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(id) DO UPDATE SET
name=excluded.name, email=excluded.email, phone=excluded.phone,
contact_name=COALESCE(excluded.contact_name, pennylane_customers.contact_name),
contact_email=COALESCE(excluded.contact_email, pennylane_customers.contact_email),
contact_phone=COALESCE(excluded.contact_phone, pennylane_customers.contact_phone),
synced_at=excluded.synced_at
`);
}

// Prepared statement partagé (facture) — même logique d'alignement du statut
// interne sur le statut BRUT Pennylane dans les deux sens d'appel : dès
// qu'une facture est encaissée/annulée/devient un avoir côté Pennylane
// (PENNYLANE_STATUSES_SOLDEES), on la bascule automatiquement sur `solde`.
// On ne touche PAS aux autres statuts internes déjà choisis à la main
// (litige/promesse_paiement/en_cours...), ce recalcul ne les écrase jamais
// tant que la facture n'est pas définitivement soldée/annulée. Une échéance
// corrigée à la main (deadline_manual=1) n'est jamais réécrasée non plus.
// deadline_status_id volontairement ABSENT du SET : seul le INSERT initial
// le renseigne, jamais réécrasé ensuite (choisi à la main ou resté sur le
// défaut "Douteux").
function buildUpsertInvoice(db) {
const soldeesSqlList = PENNYLANE_STATUSES_SOLDEES.map((s) => `'${s}'`).join(',');
return db.prepare(`
INSERT INTO pennylane_invoices (id, invoice_number, customer_id, date_emission, deadline, amount, amount_ht, remaining_amount, remaining_amount_ht, status, internal_status, deadline_status_id, synced_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(id) DO UPDATE SET
invoice_number=excluded.invoice_number, customer_id=excluded.customer_id,
date_emission=excluded.date_emission,
deadline = CASE WHEN pennylane_invoices.deadline_manual=1 THEN pennylane_invoices.deadline ELSE excluded.deadline END,
amount=excluded.amount, amount_ht=excluded.amount_ht,
remaining_amount=excluded.remaining_amount, remaining_amount_ht=excluded.remaining_amount_ht,
status=excluded.status,
internal_status = CASE WHEN excluded.status IN (${soldeesSqlList})
THEN 'solde' ELSE pennylane_invoices.internal_status END,
synced_at=excluded.synced_at
`);
}

// Synchro COMPLÈTE (pas incrémentale) à chaque appel, SANS filtre de date :
// on importe tout, à plat, tel que renvoyé par Pennylane — c'est la seule
// source de vérité. Un filtre personnalisé (ex. "depuis telle date") a été
// essayé puis abandonné : une facture qui sort du champ du filtre n'est
// plus jamais rafraîchie, donc sa copie locale se fige et part en décalage
// avec Pennylane (ex. facture marquée payée là-bas, encore "en retard" ici)
// — un import plat évite structurellement ce genre d'incohérence.
// NB : un appel /contacts par client s'ajoute à chaque synchro (voir
// fetchPrimaryContact) — plus lent, mais c'est le seul moyen d'obtenir un
// nom/mail/tel de contact réel plutôt que la seule société.
//
// NB (09/2026) : depuis financeRoutes.js, GET /api/finance/invoices filtre
// désormais l'AFFICHAGE sur date_emission >= 2025-01-01 (demande Lina, perf)
// — volontairement PAS ici, pour les mêmes raisons que ci-dessus : la
// synchro doit rester complète, seule la vue quotidienne réduit le volume.
//
// NB (09/2026, deuxième volet perf) : cette synchro complète reste lente
// (plusieurs minutes) mais n'est plus l'outil du quotidien — elle sert
// désormais de filet de sécurité, déclenché automatiquement toutes les 2
// semaines le dimanche (voir router.js) pendant que syncInvoiceChanges
// (plus bas) couvre le quotidien en quelques secondes. Le bouton manuel
// "Synchroniser Pennylane" continue d'appeler syncFinance directement, en
// filet de secours manuel si jamais l'automatisation du dimanche échoue.
async function syncFinance(db) {
// Perf 09/2026 (demande Lina) : ces deux récupérations paginées sont
// indépendantes l'une de l'autre (aucune ne dépend du résultat de l'autre) —
// on les lance donc en parallèle plutôt qu'en série. getAllPaginated est une
// fonction pure (accumule dans un tableau local, ne partage aucun état entre
// deux appels), donc aucun risque de mélange entre les deux flux.
const [invoices, customers] = await Promise.all([
getAllPaginated('customer_invoices'),
getAllPaginated('customers'),
]);

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
// Perf 09/2026 (demande Lina) : au lieu d'un appel Pennylane séquentiel par
// client dû (potentiellement 150-300+ clients, donc l'essentiel du temps de
// synchro), on les regroupe par lots de CONTACT_BATCH_SIZE en parallèle —
// grande marge sous le quota Pennylane documenté (25 requêtes/5s, cf. en-tête
// de fichier). Promise.allSettled (pas Promise.all) + le try/catch englobant :
// si un appel ou un lot échoue, la synchro continue quand même avec les
// contacts déjà récupérés plutôt que de tout faire échouer. Cette étape ne
// fait QUE lire l'API et remplir contactsById en mémoire — aucune écriture en
// base ici (voir runAll plus bas) : au pire un échec donne un contact manquant
// pour ce sync, jamais une donnée fausse. Combiné avec le COALESCE sur
// contact_name/email/phone dans buildUpsertCustomer ci-dessus (même demande,
// "0 risque de suppression") : un contact manquant cette fois-ci N'EFFACE
// PLUS la valeur déjà en base d'un sync précédent réussi.
const CONTACT_BATCH_SIZE = 10;
const contactsById = new Map();
const dueCustomers = customers.filter((c) => dueCustomerIds.has(String(c.id)));
try {
for (let i = 0; i < dueCustomers.length; i += CONTACT_BATCH_SIZE) {
const batch = dueCustomers.slice(i, i + CONTACT_BATCH_SIZE);
const results = await Promise.allSettled(
batch.map((c) => fetchPrimaryContact(c.contacts && c.contacts.url))
);
results.forEach((result, idx) => {
const c = batch[idx];
const contact = result.status === 'fulfilled' ? result.value : null;
if (contact) contactsById.set(String(c.id), contact);
if (process.env.PENNYLANE_DEBUG_RAW === '1' && contact) {
console.log(`[PENNYLANE_DEBUG_RAW] contact client ${c.id} :`, JSON.stringify(contact));
}
});
}
} catch (e) {
console.warn('[PENNYLANE] récupération des contacts clients interrompue, synchro poursuivie sans les contacts manquants :', e.message);
}

const upsertCustomer = buildUpsertCustomer(db);
const upsertInvoice = buildUpsertInvoice(db);
const defaultStatusId = defaultDeadlineStatusId(db);

const runAll = db.transaction(() => {
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
// Brouillons/avoirs/annulées sont enregistrés avec leur statut Pennylane
// d'origine (jamais sautés) : /api/finance/invoices renvoie tout (le
// front filtre lui-même par onglet, calqué sur ces statuts bruts), et
// /api/finance/kpis reste lui borné aux factures encore dues pour le
// calcul d'encours (voir router.js).
const a = amountsOf(inv);
const status = computedStatus(inv);
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
status,
PENNYLANE_STATUSES_SOLDEES.includes(status) ? 'solde' : 'a_relancer',
defaultStatusId
);
}
// Horodatage de la dernière synchro COMPLÈTE réussie (manuelle OU
// automatique, peu importe qui l'a déclenchée) — sert uniquement de repère
// au job planifié du dimanche (voir router.js) pour savoir s'il doit
// vraiment tourner ou si une synchro complète (même manuelle) a déjà eu
// lieu récemment. Pure bookkeeping : ne change rien à quelles données sont
// lues ni comment (Règle absolue N°2 du prompt de demande synchro).
// Format ISO (avec T/Z) stocké directement en JS plutôt que via datetime('now')
// SQLite (qui produit "YYYY-MM-DD HH:MM:SS" sans timezone) — évite le même
// piège de parsing déjà rencontré et documenté ailleurs dans ce projet
// (cf. financeCommentsListHtml, correctif UTC sur created_at).
db.prepare(`
INSERT INTO config (key,value) VALUES ('pennylane_last_full_sync_at', ?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value
`).run(new Date().toISOString());
});
runAll();

return {
invoicesSynced: invoices.length,
customersSynced: customers.length,
syncedAt: new Date().toISOString(),
};
}

// ── SUIVI RAPIDE DES CHANGEMENTS (check ~20s, complète syncFinance) ─────────
// Contrairement à syncFinance (relecture complète, TOUTES les factures), ce
// mécanisme n'interroge que ce qui a CHANGÉ depuis le dernier appel réussi,
// via le changelog dédié de Pennylane. Objectif (demande Lina) : qu'une
// facture tout juste entrée/réglée sur Pennylane apparaisse sur le dashboard
// en quelques secondes, sans attendre la prochaine synchro complète
// (programmée toutes les ~2 semaines, voir router.js).
//
// Endpoint vérifié sur la doc officielle Pennylane (09/2026) :
// GET /changelogs/customer_invoices. Important : il NE renvoie PAS la
// facture elle-même, seulement { id, operation: insert|update|delete,
// processed_at, updated_at, created_at } — il faut donc, pour chaque id
// renvoyé, aller rechercher la facture à jour via GET /customer_invoices/:id
// (même endpoint que getInvoicePdfUrl plus bas) avant de pouvoir
// l'enregistrer en base.
//
// CORRECTIF 24/09/2026 (bug identifié le jour même par Lina : les factures
// du matin ne remontaient pas sur le dashboard). Cause : la première version
// mémorisait `next_cursor` comme point de reprise, mais la doc Pennylane le
// précise explicitement — « next_cursor... null when you've reached the
// end » et « cursors are temporary and should not be stored for long-term
// use ». Or `next_cursor` est justement `null` à chaque tick où rien n'a
// changé, c'est-à-dire quasiment tout le temps vu le volume quotidien : le
// point de reprise n'était donc jamais mémorisé, et CHAQUE tick repartait de
// « maintenant » — ratant systématiquement et définitivement tout ce qui
// s'était passé dans les 20 secondes précédentes. Le check tournait bien
// toutes les 20s, mais ne rattrapait jamais rien.
//
// Corrigé en suivant la méthode officiellement recommandée par Pennylane
// (doc « Tracking Data Changes ») : mémoriser le `processed_at` du dernier
// changement traité et le redonner en `start_date` au tick suivant — jamais
// de `cursor` d'un tick à l'autre (uniquement `start_date`). Tant qu'un tick
// ne voit rien de neuf, le point de départ mémorisé NE BOUGE PAS (on retente
// exactement le même point de départ au tick suivant, comme demandé par la
// doc) ; il n'avance que lorsqu'un tick a effectivement traité au moins un
// changement ET entièrement vidé la page reçue (`has_more: false`). Un point
// de départ est mémorisé IMMÉDIATEMENT au tout premier démarrage (avant même
// le premier appel), pour ne jamais dériver vers « maintenant » à chaque
// tick suivant comme le faisait l'ancienne version.
//
// Pagination : `cursor` (reprend exactement après le dernier appel, valable
// UNIQUEMENT pour vider plusieurs pages d'un même burst, jamais stocké d'un
// tick à l'autre) OU `start_date` (repart d'une date — c'est notre seul
// point de reprise persistant) — jamais les deux ensemble (l'API renvoie une
// erreur 400 sinon). Le point de départ est mémorisé dans la table générique
// `config` plutôt que dans une nouvelle table dédiée, pour rester cohérent
// avec le reste de la base (voir reports.js, claimReportOnce, même table).
//
// Limite documentée par Pennylane : le changelog ne garde que 4 semaines
// d'historique — une requête portant sur une date trop ancienne renvoie une
// erreur (422). Si ça arrive (ex. ce job est resté arrêté très longtemps),
// on ne devine rien : on réinitialise sur "maintenant" et on compte sur la
// synchro complète de secours (voir router.js) pour rattraper l'écart,
// plutôt que de risquer un import partiel ou faux (Règle absolue N°1,
// prompt de demande synchro).
//
// Suppression (operation='delete') : ignorée volontairement, comme partout
// ailleurs dans ce fichier — ce module n'efface jamais une ligne locale,
// quoi qu'il arrive côté Pennylane.
//
// Un seul appel = une seule page (jusqu'à 1000 changements, le maximum
// autorisé par Pennylane — largement au-dessus du volume quotidien réel de
// l'entreprise, pour éviter en pratique le cas `has_more: true`). S'il y a
// malgré tout plus d'une page en attente (ex. après une très longue
// coupure), le point de départ n'avance pas tant que la page n'est pas
// entièrement vidée — les ticks suivants (toutes les ~20s) retentent avec le
// même point de départ jusqu'à rattraper tout le retard, sans jamais sauter
// un changement (au prix, dans ce cas rare, de retraiter parfois deux fois
// le même changement déjà vu — sans risque, un upsert est idempotent).
const PENNYLANE_SYNC_CHECKPOINT_KEY = 'pennylane_changes_start_date';

function getStoredCheckpoint(db) {
const row = db.prepare('SELECT value FROM config WHERE key=?').get(PENNYLANE_SYNC_CHECKPOINT_KEY);
return row && row.value ? row.value : null;
}

function storeCheckpoint(db, isoDate) {
db.prepare(`
INSERT INTO config (key,value) VALUES (?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value
`).run(PENNYLANE_SYNC_CHECKPOINT_KEY, isoDate);
}

async function fetchChangesPage(startDate) {
const params = new URLSearchParams({ limit: '1000', start_date: startDate });
return pennylaneFetch(`/changelogs/customer_invoices?${params.toString()}`);
}

// Un seul "tick" — à appeler toutes les ~20 secondes par le job planifié
// (voir router.js). Ne relit JAMAIS l'ensemble des factures.
async function syncInvoiceChanges(db) {
let startDate = getStoredCheckpoint(db);
if (!startDate) {
// Tout premier démarrage (ou après un reset 422) : ancre le point de
// départ sur "maintenant" et le MÉMORISE IMMÉDIATEMENT, avant même le
// premier appel réseau — sinon, tant qu'aucun changement n'a encore été
// vu, ce point de départ dériverait vers "maintenant" à CHAQUE tick
// suivant (c'était exactement le bug du 24/09/2026, voir plus haut) : un
// changement survenu entre deux ticks serait alors raté pour toujours.
startDate = new Date().toISOString();
storeCheckpoint(db, startDate);
}

let page;
try {
page = await fetchChangesPage(startDate);
} catch (e) {
if (String(e.message).includes('(422)')) {
console.warn('[PENNYLANE][CHANGES] point de départ expiré/invalide (plus de 4 semaines), réinitialisé sur "maintenant" — la synchro complète programmée rattrapera l\'écart :', e.message);
storeCheckpoint(db, new Date().toISOString());
return { checked: 0, applied: 0, reset: true };
}
throw e;
}

const items = Array.isArray(page.items) ? page.items : [];
if (items.length === 0) {
// Rien de neuf : le point de départ N'AVANCE PAS (recommandation
// officielle Pennylane — voir commentaire au-dessus). On retentera
// exactement le même point de départ au prochain tick.
return { checked: 0, applied: 0 };
}

const changedIds = [...new Set(items.filter((it) => it.operation !== 'delete').map((it) => String(it.id)))];
// Le plus récent `processed_at` vu dans cette page (tous types d'opération
// confondus, delete compris) — sert de nouveau point de départ une fois la
// page entièrement traitée, voir plus bas.
const maxProcessedAt = items.reduce((max, it) => (it.processed_at && (!max || it.processed_at > max) ? it.processed_at : max), null);

if (changedIds.length === 0) {
// Cette page ne contient que des suppressions (ignorées, voir plus haut) —
// rien à écrire en base, mais la fenêtre a bien été vérifiée : on avance
// quand même le point de départ (seulement si la page est entièrement
// vidée) pour ne pas la revérifier indéfiniment.
if (!page.has_more && maxProcessedAt) storeCheckpoint(db, maxProcessedAt);
return { checked: items.length, applied: 0 };
}

// Phase 1 (async) : récupérer l'état à jour de chaque facture changée, et
// le client s'il n'est pas encore connu localement (cas rare : client tout
// juste créé entre deux synchros complètes). Rien n'est écrit en base ici,
// comme dans syncFinance — en cas d'échec en cours de route, ce tick est
// abandonné SANS avancer le point de départ : le prochain passage (~20s
// plus tard) repartira du même point de départ et retentera, aucune perte
// possible.
const fetchedInvoices = [];
const fetchedCustomers = [];
try {
for (const id of changedIds) {
const inv = await pennylaneFetch(`/customer_invoices/${encodeURIComponent(id)}`);
fetchedInvoices.push(inv);
const custId = customerIdOf(inv);
if (custId && !db.prepare('SELECT 1 FROM pennylane_customers WHERE id=?').get(custId)) {
try {
const c = await pennylaneFetch(`/customers/${encodeURIComponent(custId)}`);
fetchedCustomers.push(c);
} catch (e) {
// Best-effort : la facture sera quand même enregistrée (customer_id
// pointera vers un client pas encore en base — rare, se corrigera
// tout seul à la prochaine synchro complète ou au prochain tick où
// ce client réapparaît).
console.warn(`[PENNYLANE][CHANGES] client ${custId} introuvable pour la facture ${id} :`, e.message);
}
}
}
} catch (e) {
console.warn('[PENNYLANE][CHANGES] échec en cours de récupération, tick abandonné — retentera au prochain passage avec le même point de départ :', e.message);
return { checked: items.length, applied: 0, error: e.message };
}

// Phase 2 (sync, transaction atomique) : écriture des factures/clients +
// avancement du point de départ DANS LA MÊME transaction — si l'écriture
// échoue pour une raison quelconque, le point de départ n'avance pas non
// plus, donc rien n'est perdu (comportement identique à syncFinance : tout
// ou rien).
const upsertCustomer = buildUpsertCustomer(db);
const upsertInvoice = buildUpsertInvoice(db);
const defaultStatusId = defaultDeadlineStatusId(db);

const runAll = db.transaction(() => {
for (const c of fetchedCustomers) {
upsertCustomer.run(
String(c.id),
c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
(Array.isArray(c.emails) ? c.emails[0] : c.email) || '',
c.phone || c.phone_number || '',
null, null, null
);
}
for (const inv of fetchedInvoices) {
const a = amountsOf(inv);
const status = computedStatus(inv);
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
status,
PENNYLANE_STATUSES_SOLDEES.includes(status) ? 'solde' : 'a_relancer',
defaultStatusId
);
}
// Le point de départ n'avance QUE si cette page a été entièrement vidée
// (has_more: false) — s'il reste d'autres pages (rare, gros volume ponctuel),
// on le laisse en l'état : le prochain tick relira depuis le même point,
// verra à nouveau ces changements (upsert = sans risque) et progressera
// page par page jusqu'à rattraper tout le retard.
if (!page.has_more && maxProcessedAt) storeCheckpoint(db, maxProcessedAt);
});
runAll();

return { checked: items.length, applied: fetchedInvoices.length };
}

// Un lien PDF public (`public_file_url`) est bien renvoyé par Pennylane, mais
// n'est valable que 30 minutes — on ne le met donc JAMAIS en cache, on le
// redemande à la demande (clic sur "Voir le PDF" côté app) via cet appel.
async function getInvoicePdfUrl(id) {
const json = await pennylaneFetch(`/customer_invoices/${encodeURIComponent(id)}`);
if (!json.public_file_url) throw new Error("Pennylane n'a renvoyé aucun PDF pour cette facture");
return { url: json.public_file_url, filename: json.filename || null };
}

module.exports = { syncFinance, syncInvoiceChanges, getInvoicePdfUrl, getAllPaginated, pennylaneFetch };
