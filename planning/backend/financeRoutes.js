module.exports = function registerFinanceRoutes(app, { db, pennylane, requireFinance, FINANCE_INTERNAL_STATUSES }) {
// ── RECOUVREMENT / PENNYLANE (nouveau projet) ────────────────────────────────
// Outil interne de suivi des impayés : Pennylane reste la source de vérité
// facturation (voir ./pennylane.js), ce module ajoute juste par-dessus ce
// que Pennylane ne fait pas nativement — statut de recouvrement, attribution
// par collaborateur, historique de relances multi-canal, KPI (DSO, taux de
// retard, aging) — jusqu'ici suivis à la main (Excel + Trello).
function joursDeRetard(deadline) {
if (!deadline) return null;
const d = new Date(`${deadline}T00:00:00`);
if (Number.isNaN(d.getTime())) return null;
const today = new Date();
today.setHours(0, 0, 0, 0);
return Math.round((today - d) / 86400000);
}

// Un statut d'échéance "compte comme réglée" quand la case cochée en
// Paramètres (compte_regle) le dit — pas quand son libellé vaut "Soldée" en
// dur, pour que l'équipe puisse renommer/dupliquer ce comportement sur un
// autre statut sans toucher au code.
function isStatusReglee(statusId) {
if (statusId == null) return false;
const s = db.prepare('SELECT compte_regle FROM finance_installment_statuses WHERE id=?').get(statusId);
return !!(s && s.compte_regle);
}
// Chaîne de validation d'une facture : échéance 1 (= la deadline principale,
// avec son propre statut deadline_status_id — même pastille que 2/3/4) puis
// les échéances suivantes dans l'ordre de leur date. `installmentItems` peut
// être des lignes SQL brutes (due_date/status_id) ou déjà mises en forme
// (dueDate/statusId) — les deux formes sont acceptées.
function buildEcheanceChain(invoiceRow, installmentItems) {
const chain = [{
num: 1,
due: invoiceRow.deadline,
statusId: invoiceRow.deadline_status_id !== undefined ? invoiceRow.deadline_status_id : invoiceRow.deadlineStatusId,
}];
(installmentItems || []).forEach((inst, i) => {
chain.push({
num: i + 2,
due: inst.due_date !== undefined ? inst.due_date : inst.dueDate,
statusId: inst.status_id !== undefined ? inst.status_id : inst.statusId,
});
});
return chain;
}
// Référence de retard : la 1ère échéance de la chaîne qui n'est PAS encore à
// un statut "compte comme réglée" (dans l'ordre 1→2→3→4, jamais la plus
// tardive parmi les non réglées) — c'est sa date qui sert au calcul de
// "jours de retard". Si tout est réglé, allReglees=true (déclenche le passage
// auto de la facture en "Soldée", cf. maybeAutoSolde).
function computeEcheanceReference(chain) {
for (const item of chain) {
if (!isStatusReglee(item.statusId)) return { due: item.due, num: item.num, allReglees: false };
}
const last = chain[chain.length - 1];
return { due: last.due, num: last.num, allReglees: true };
}
// Si la chaîne d'échéances d'une facture est intégralement réglée, on la fait
// basculer en statut "Soldée" — même esprit que le passage auto "à relancer"
// -> "en cours" à la première relance : un signal automatique, mais qui ne
// vient jamais écraser un litige ou une promesse de paiement posés à la main.
function maybeAutoSolde(invoiceId) {
const invoice = db.prepare('SELECT * FROM pennylane_invoices WHERE id=?').get(invoiceId);
if (!invoice) return;
const installments = db.prepare('SELECT * FROM finance_invoice_installments WHERE invoice_id=? ORDER BY due_date ASC').all(invoiceId);
const ref = computeEcheanceReference(buildEcheanceChain(invoice, installments));
if (ref.allReglees && !['litige', 'promesse_paiement', 'solde'].includes(invoice.internal_status)) {
db.prepare("UPDATE pennylane_invoices SET internal_status='solde' WHERE id=?").run(invoiceId);
}
}

app.post('/api/finance/sync', requireFinance, async (req, res) => {
try {
const result = await pennylane.syncFinance(db);
console.log(`[FINANCE] sync Pennylane OK — ${result.invoicesSynced} facture(s), ${result.customersSynced} client(s)`);
res.json({ ok: true, ...result });
} catch (e) {
console.error('[FINANCE] sync Pennylane KO :', e.message);
res.status(500).json({ error: e.message });
}
});

// Statuts Pennylane NATIFS (colonne `status`, le statut brut renvoyé par
// Pennylane — à ne pas confondre avec `internal_status`, notre propre suivi
// de recouvrement) qui ne représentent pas une facture à recouvrer : un
// brouillon n'a pas été envoyé, un avoir/une annulation n'est pas une dette.
// On les synchronise quand même (voir pennylane.js) pour pouvoir en afficher
// le compte — cf. /api/finance/kpis, syncOverview — mais ils ne doivent
// jamais apparaître dans la liste de travail ni fausser les KPI d'encours.
// `paid` en fait partie aussi : certaines factures encaissées gardent un
// remaining_amount non nul côté Pennylane (le champ ne retombe pas toujours
// à 0 à l'encaissement) — sans cette exclusion, elles pouvaient être comptées
// comme de l'encours en retard alors qu'elles sont soldées (bug remonté :
// onglet "Encaissée" affichant des factures "Xj de retard").
const PENNYLANE_HORS_RECOUVREMENT = ['draft', 'credit_note', 'cancelled', 'partially_cancelled', 'archived', 'incomplete', 'paid'];
const HORS_RECOUVREMENT_PLACEHOLDERS = PENNYLANE_HORS_RECOUVREMENT.map(() => '?').join(',');

// Liste de TOUTES les factures synchronisées, sans filtre par défaut — la
// barre d'onglets du front reproduit le classement Pennylane lui-même
// (Toutes/Brouillon/À traiter/À venir/En retard/Encaissée/Partiellement
// encaissée/Annulée/Avoir), qui a besoin de voir toute facture quel que soit
// son statut ou son reste-dû (pas seulement celles encore à recouvrer) pour
// que les compteurs collent à ce qu'affiche Pennylane. Jours de retard
// calculés à la volée (jamais stockés : sinon désynchronisé dès le
// lendemain). NB : les KPI de recouvrement (/api/finance/kpis) restent eux
// bornés aux factures encore dues et pertinentes — cette route-ci sert la
// vue "annuaire complet", pas le calcul d'encours.
//
// Filtre de performance (09/2026, demande Lina) : on ne charge plus au
// quotidien les factures ÉMISES avant le 01/01/2025 — la base continue de
// TOUT stocker/synchroniser (voir pennylane.js, syncFinance, volontairement
// SANS filtre de date, cf. commentaire dans ce fichier), seule cette route
// d'AFFICHAGE réduit le volume renvoyé au front. Effet accepté par Lina :
// une très vieille facture encore due aujourd'hui sort de cette vue
// quotidienne (donc aussi des compteurs d'onglets, qui ne collent plus à
// 100% avec Pennylane dans ce cas rare) — voir le prompt de dev, point 6.
// Mise en forme d'une ligne facture (jointures SQL -> objet exposé au front)
// — extraite en fonction nommée le 23/09/2026 (demande Lina, perf) pour être
// réutilisée par la route détail ci-dessous (GET /api/finance/invoices/:id) :
// après l'édition d'UNE SEULE facture, le front n'a plus besoin de refaire un
// fetch complet de toutes les factures + KPI juste pour rafraîchir cette
// ligne-là (cf. patchFinanceInvoice côté recouvrement/frontend/app.js).
function shapeInvoiceRow(r, installments) {
// Référence de retard : la 1ère échéance (1, puis 2/3/4...) pas encore à
// un statut "compte comme réglée" — remplace le calcul figé sur la seule
// deadline principale, pour que valider l'échéance 1 fasse glisser le
// repère de retard sur l'échéance 2, etc.
const echRef = computeEcheanceReference(buildEcheanceChain(r, installments));
return {
id: r.id,
invoiceNumber: r.invoice_number,
customerId: r.customer_id,
customerName: r.customer_name || '',
customerEmail: r.customer_email || '',
customerPhone: r.customer_phone || '',
contactName: r.contact_name || '',
contactEmail: r.contact_email || '',
contactPhone: r.contact_phone || '',
dateEmission: r.date_emission,
deadline: r.deadline,
deadlineManual: !!r.deadline_manual,
// Statut de l'échéance 1, même pastille personnalisable que 2/3/4.
deadlineStatusId: r.deadline_status_id,
deadlineStatusLabel: r.deadline_status_label || null,
deadlineStatusColor: r.deadline_status_color || null,
amountHt: r.amount_ht,
amountTtc: r.amount,
remainingAmountHt: r.remaining_amount_ht,
remainingAmountTtc: r.remaining_amount,
// Alias conservés pour compat avec un ancien code éventuel côté front.
amount: r.amount,
remainingAmount: r.remaining_amount,
status: r.status,
internalStatus: r.internal_status,
daysLate: joursDeRetard(echRef.due),
// Numéro de l'échéance actuellement de référence pour le retard (1 par
// défaut) — sert le front à afficher "Éch. 2 — 5j de retard" plutôt
// qu'un nombre de jours qui change sans que la date affichée en Éch. 1
// n'ait bougé.
retardEcheanceNum: echRef.num,
retardEcheanceDue: echRef.due,
allEcheancesReglees: echRef.allReglees,
lastRelanceAt: r.last_relance_at || null,
// Échéances 2, 3, 4... (triées par date) — l'échéance 1 reste `deadline`
// ci-dessus, éditable directement, comme avant cette fonctionnalité.
installments,
};
}
app.get('/api/finance/invoices', requireFinance, (req, res) => {
const rows = db.prepare(`
SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
c.contact_name AS contact_name, c.contact_email AS contact_email, c.contact_phone AS contact_phone,
lr.last_relance_at AS last_relance_at,
ds.label AS deadline_status_label, ds.color AS deadline_status_color
FROM pennylane_invoices i
LEFT JOIN pennylane_customers c ON c.id = i.customer_id
-- Dernière relance par facture (toutes canaux confondus) — sert le badge
-- "Dernière relance il y a Xj" côté front (audit UX v2, B4) : sans ça,
-- il fallait ouvrir la fiche détail de chaque facture pour savoir si
-- quelqu'un avait déjà relancé récemment.
LEFT JOIN (
SELECT invoice_id, MAX(created_at) AS last_relance_at
FROM finance_relances
GROUP BY invoice_id
) lr ON lr.invoice_id = i.id
-- Statut de l'échéance 1 (= la deadline principale) — même pastille
-- personnalisable que les échéances 2/3/4 ci-dessous.
LEFT JOIN finance_installment_statuses ds ON ds.id = i.deadline_status_id
WHERE i.date_emission >= '2025-01-01'
`).all();
// Échéances de paiement (2e/3e/4e tranche...) de TOUTES les factures, en une
// seule requête plutôt qu'une par facture (évite un N+1 sur plusieurs
// milliers de lignes) — regroupées ensuite par invoice_id ci-dessous. Sert
// les colonnes Éch. 2/3/4 du tableau (échéance 1 = la deadline ci-dessus).
const instRows = db.prepare(`
SELECT fi.*, s.label AS status_label, s.color AS status_color
FROM finance_invoice_installments fi
LEFT JOIN finance_installment_statuses s ON s.id = fi.status_id
ORDER BY fi.invoice_id, fi.due_date ASC
`).all();
const installmentsByInvoice = {};
for (const row of instRows) {
(installmentsByInvoice[row.invoice_id] || (installmentsByInvoice[row.invoice_id] = [])).push({
id: row.id,
label: row.label,
dueDate: row.due_date,
amount: row.amount,
paidAmount: row.paid_amount || 0,
solde: Math.max(0, (row.amount || 0) - (row.paid_amount || 0)),
statusId: row.status_id,
statusLabel: row.status_label || null,
statusColor: row.status_color || null,
});
}
const { statut, q, retard_only } = req.query;
const qLower = q ? String(q).trim().toLowerCase() : '';
let list = rows.map((r) => shapeInvoiceRow(r, installmentsByInvoice[r.id] || []));
if (statut) list = list.filter((r) => r.internalStatus === statut);
if (retard_only === '1') list = list.filter((r) => (r.daysLate || 0) > 0);
if (qLower) {
list = list.filter(
(r) => (r.invoiceNumber || '').toLowerCase().includes(qLower) || r.customerName.toLowerCase().includes(qLower)
);
}
list.sort((a, b) => (b.daysLate ?? -9999) - (a.daysLate ?? -9999));
res.json(list);
});

// Une seule facture, déjà mise en forme comme dans la liste ci-dessus
// (mêmes champs, y compris installments) — ajoutée le 23/09/2026 (demande
// Lina, perf) pour que le front puisse rafraîchir UNE ligne après un edit
// (statut, échéance, commentaire, échéance de paiement...) sans refaire un
// fetch complet de toutes les factures + KPI à chaque fois (cf.
// patchFinanceInvoice côté recouvrement/frontend/app.js — c'était `trop
// trop long` d'après Lina).
app.get('/api/finance/invoices/:id', requireFinance, (req, res) => {
const r = db.prepare(`
SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
c.contact_name AS contact_name, c.contact_email AS contact_email, c.contact_phone AS contact_phone,
lr.last_relance_at AS last_relance_at,
ds.label AS deadline_status_label, ds.color AS deadline_status_color
FROM pennylane_invoices i
LEFT JOIN pennylane_customers c ON c.id = i.customer_id
LEFT JOIN (
SELECT invoice_id, MAX(created_at) AS last_relance_at
FROM finance_relances
GROUP BY invoice_id
) lr ON lr.invoice_id = i.id
LEFT JOIN finance_installment_statuses ds ON ds.id = i.deadline_status_id
WHERE i.id = ?
`).get(req.params.id);
if (!r) return res.status(404).json({ error: 'Facture introuvable' });
const instRows = db.prepare(`
SELECT fi.*, s.label AS status_label, s.color AS status_color
FROM finance_invoice_installments fi
LEFT JOIN finance_installment_statuses s ON s.id = fi.status_id
WHERE fi.invoice_id = ? ORDER BY fi.due_date ASC
`).all(r.id);
const installments = instRows.map((row) => ({
id: row.id,
label: row.label,
dueDate: row.due_date,
amount: row.amount,
paidAmount: row.paid_amount || 0,
solde: Math.max(0, (row.amount || 0) - (row.paid_amount || 0)),
statusId: row.status_id,
statusLabel: row.status_label || null,
statusColor: row.status_color || null,
}));
res.json(shapeInvoiceRow(r, installments));
});

// KPI de recouvrement : encours total, montant/nombre en retard, taux de
// retard, aging (répartition de l'encours par tranche de retard) et DSO
// (Days Sales Outstanding — formule classique : encours clients TTC / CA TTC
// facturé sur la période × nb de jours de la période ; période glissante de
// 90 jours, assez large pour lisser un mois calme, assez courte pour rester réactive).
// Statuts qu'on considère déjà "pris en charge" autrement qu'en relance
// active (un litige en cours ou une promesse de paiement obtenue n'attend pas
// une relance du jour) — même exclusion que le digest mail quotidien
// (reports.js/reportRelancesQuotidien), pour que le chiffre affiché ici colle
// à ce qui part réellement dans le mail du matin.
const FINANCE_STATUTS_NON_ACTIONABLES = ['litige', 'promesse_paiement', 'solde'];

app.get('/api/finance/kpis', requireFinance, (req, res) => {
// Même borne que /api/finance/invoices (cf. plus haut) : les factures ÉMISES
// avant le 01/01/2025 sortent aussi des KPI de recouvrement (encours, retard,
// DSO, aging, répartition par statut) — pas seulement de la liste affichée.
// Décision Lina 09/2026 : « vraiment on retire ce qu'il y a avant », cf.
// statut-implementation-recouvrement.md.
const unpaid = db.prepare(`
SELECT remaining_amount, deadline, internal_status FROM pennylane_invoices
WHERE remaining_amount > 0 AND (status IS NULL OR status NOT IN (${HORS_RECOUVREMENT_PLACEHOLDERS}))
AND date_emission >= '2025-01-01'
`).all(...PENNYLANE_HORS_RECOUVREMENT);
let totalEncours = 0;
let montantEnRetard = 0;
let nbEnRetard = 0;
let montantActionable = 0;
let nbActionable = 0;
const aging = { j0_30: 0, j31_60: 0, j61_90: 0, j90_plus: 0 };
const parStatut = {}; // vue "pipeline" : répartition de l'encours par statut interne, retard ou pas
for (const inv of unpaid) {
totalEncours += inv.remaining_amount;
const statut = inv.internal_status || 'a_relancer';
if (!parStatut[statut]) parStatut[statut] = { count: 0, montant: 0 };
parStatut[statut].count += 1;
parStatut[statut].montant += inv.remaining_amount;
const daysLate = joursDeRetard(inv.deadline);
if (daysLate !== null && daysLate > 0) {
nbEnRetard += 1;
montantEnRetard += inv.remaining_amount;
if (!FINANCE_STATUTS_NON_ACTIONABLES.includes(statut)) {
nbActionable += 1;
montantActionable += inv.remaining_amount;
}
if (daysLate <= 30) aging.j0_30 += inv.remaining_amount;
else if (daysLate <= 60) aging.j31_60 += inv.remaining_amount;
else if (daysLate <= 90) aging.j61_90 += inv.remaining_amount;
else aging.j90_plus += inv.remaining_amount;
}
}
const PERIOD_DAYS = 90;
const periodStart = new Date();
periodStart.setHours(0, 0, 0, 0);
periodStart.setDate(periodStart.getDate() - PERIOD_DAYS);
const caPeriode = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM pennylane_invoices WHERE date_emission >= ?')
.get(periodStart.toISOString().slice(0, 10)).total || 0;
const dso = caPeriode > 0 ? Math.round((totalEncours / caPeriode) * PERIOD_DAYS) : null;
const tauxDeRetard = totalEncours > 0 ? Math.round((montantEnRetard / totalEncours) * 1000) / 10 : 0;
// Aperçu de synchro : répartition par statut BRUT Pennylane, sur TOUT ce qui
// a été synchronisé (pas seulement l'encours dû) — sert de repère de
// cohérence face au propre tableau de bord Pennylane (son onglet "Toutes X"
// / Brouillon / Encaissée / Annulée / Avoir...), pas à filtrer le travail
// de recouvrement lui-même.
const statusCounts = db.prepare('SELECT status, COUNT(*) AS n FROM pennylane_invoices GROUP BY status').all();
const syncOverview = { total: 0, byStatus: {} };
for (const row of statusCounts) {
const key = row.status || 'inconnu';
syncOverview.byStatus[key] = row.n;
syncOverview.total += row.n;
}
res.json({
totalEncours,
montantEnRetard,
nbFacturesEnRetard: nbEnRetard,
nbFacturesTotal: unpaid.length,
montantActionable,
nbFacturesActionable: nbActionable,
tauxDeRetard,
dso,
aging,
parStatut,
syncOverview,
periodJours: PERIOD_DAYS,
});
});

app.get('/api/finance/invoices/:id/relances', requireFinance, (req, res) => {
res.json(db.prepare('SELECT * FROM finance_relances WHERE invoice_id=? ORDER BY created_at DESC').all(req.params.id));
});

app.post('/api/finance/invoices/:id/relances', requireFinance, (req, res) => {
const invoice = db.prepare('SELECT id, internal_status FROM pennylane_invoices WHERE id=?').get(req.params.id);
if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
const canal = String(req.body.canal || '').trim();
if (!canal) return res.status(400).json({ error: 'Canal requis' });
const note = req.body.note ? String(req.body.note).trim() : null;
const r = db.prepare('INSERT INTO finance_relances (invoice_id, canal, note, auteur) VALUES (?,?,?,?)')
.run(req.params.id, canal, note, req.commercial.nom);
// Une relance faite = on passe implicitement de "à relancer" à "en cours"
// (affiché "Relancé" côté UI depuis 09/2026, clé technique inchangée),
// sauf si un statut plus avancé (litige/promesse/solde) a déjà été posé à
// la main — on ne veut pas écraser un statut plus informatif.
// NB : depuis la suppression du formulaire "Nouvelle relance" côté front
// (voir recouvrement/frontend/app.js, point 3.c du prompt de dev), cette
// route n'est plus appelée par l'UI — le passage à "Relancé" se fait
// désormais à la main via le select de statut. On la laisse fonctionnelle
// (pas de suppression backend) au cas où elle serait réutilisée plus tard.
if (invoice.internal_status === 'a_relancer') {
db.prepare("UPDATE pennylane_invoices SET internal_status='en_cours' WHERE id=?").run(req.params.id);
}
res.status(201).json(db.prepare('SELECT * FROM finance_relances WHERE id=?').get(r.lastInsertRowid));
});

const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.patch('/api/finance/invoices/:id', requireFinance, (req, res) => {
const existing = db.prepare('SELECT * FROM pennylane_invoices WHERE id=?').get(req.params.id);
if (!existing) return res.status(404).json({ error: 'Facture introuvable' });
const internalStatus = req.body.internalStatus !== undefined ? String(req.body.internalStatus).trim() : existing.internal_status;
if (!FINANCE_INTERNAL_STATUSES.includes(internalStatus)) {
return res.status(400).json({ error: `Statut invalide (attendu: ${FINANCE_INTERNAL_STATUSES.join(', ')})` });
}
// Correction manuelle de l'échéance (ex. délai négocié avec le client) :
// ne touche QUE la date qui sert au calcul du retard/classement/KPI, jamais
// le montant dû (celui-ci reste celui de Pennylane). Marquée deadline_manual=1
// pour que la prochaine synchro Pennylane ne l'écrase pas (cf. pennylane.js).
let deadline = existing.deadline;
let deadlineManual = existing.deadline_manual;
if (req.body.deadline !== undefined) {
const d = String(req.body.deadline).trim();
if (!DEADLINE_RE.test(d)) return res.status(400).json({ error: 'Date d\'échéance invalide (attendu AAAA-MM-JJ)' });
deadline = d;
deadlineManual = 1;
}
// Statut de l'échéance 1 (même pastille personnalisable que 2/3/4) — sert
// la chaîne de validation, cf. computeEcheanceReference/maybeAutoSolde.
let deadlineStatusId = resolveStatusId(req.body.deadlineStatusId);
if (deadlineStatusId === false) return res.status(400).json({ error: 'Statut d\'échéance introuvable' });
// "Sans statut" n'existe plus comme état possible (09/2026) : si la valeur
// se résout explicitement à null, on retombe sur "Douteux" par défaut —
// voir defaultInstallmentStatusId() plus bas.
if (deadlineStatusId === null) deadlineStatusId = defaultInstallmentStatusId();
// L'attribution par collaborateur a été retirée (une seule personne gère le
// recouvrement) — seuls le statut interne et l'échéance restent modifiables ici.
db.prepare('UPDATE pennylane_invoices SET internal_status=?, deadline=?, deadline_manual=?, deadline_status_id=? WHERE id=?')
.run(internalStatus, deadline, deadlineManual, deadlineStatusId === undefined ? existing.deadline_status_id : deadlineStatusId, req.params.id);
maybeAutoSolde(req.params.id);
res.json(db.prepare('SELECT * FROM pennylane_invoices WHERE id=?').get(req.params.id));
});

// Lien PDF (public_file_url) : jamais mis en cache côté nous (expire au bout
// de 30 min chez Pennylane), redemandé à chaque clic sur "Voir le PDF".
app.get('/api/finance/invoices/:id/pdf', requireFinance, async (req, res) => {
try {
const invoice = db.prepare('SELECT id FROM pennylane_invoices WHERE id=?').get(req.params.id);
if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
const pdf = await pennylane.getInvoicePdfUrl(req.params.id);
res.json(pdf);
} catch (e) {
res.status(500).json({ error: e.message });
}
});

// Commentaires libres sur une facture (distincts de l'historique de relances :
// une note interne, pas une action de relance envoyée au client).
app.get('/api/finance/invoices/:id/comments', requireFinance, (req, res) => {
res.json(db.prepare('SELECT * FROM finance_invoice_comments WHERE invoice_id=? ORDER BY created_at DESC').all(req.params.id));
});

app.post('/api/finance/invoices/:id/comments', requireFinance, (req, res) => {
const invoice = db.prepare('SELECT id FROM pennylane_invoices WHERE id=?').get(req.params.id);
if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
const comment = String(req.body.comment || '').trim();
if (!comment) return res.status(400).json({ error: 'Commentaire vide' });
const r = db.prepare('INSERT INTO finance_invoice_comments (invoice_id, auteur, comment) VALUES (?,?,?)')
.run(req.params.id, req.commercial.nom, comment);
res.status(201).json(db.prepare('SELECT * FROM finance_invoice_comments WHERE id=?').get(r.lastInsertRowid));
});

// Modification d'un commentaire existant (point 4.b du prompt de dev,
// finalement ouvert à TOUT compte finance/admin plutôt que restreint à des
// personnes nommées — décision Lina 09/2026, cf. statut-implementation-
// recouvrement.md). Mêmes droits que l'ajout (requireFinance) : pas de
// vérification d'auteur, n'importe quel compte finance/admin peut corriger
// n'importe quel commentaire.
app.patch('/api/finance/invoices/:id/comments/:commentId', requireFinance, (req, res) => {
const existing = db.prepare('SELECT * FROM finance_invoice_comments WHERE id=? AND invoice_id=?')
.get(req.params.commentId, req.params.id);
if (!existing) return res.status(404).json({ error: 'Commentaire introuvable' });
const comment = String(req.body.comment || '').trim();
if (!comment) return res.status(400).json({ error: 'Commentaire vide' });
db.prepare("UPDATE finance_invoice_comments SET comment=?, updated_at=datetime('now') WHERE id=?")
.run(comment, req.params.commentId);
res.json(db.prepare('SELECT * FROM finance_invoice_comments WHERE id=?').get(req.params.commentId));
});

// Suppression d'un commentaire (demande Lina 24/09/2026). Mêmes droits que la
// modification ci-dessus (requireFinance, pas de vérification d'auteur) —
// cohérent avec la décision déjà prise pour l'édition, pas une nouvelle
// politique inventée pour ce point précis.
app.delete('/api/finance/invoices/:id/comments/:commentId', requireFinance, (req, res) => {
const existing = db.prepare('SELECT id FROM finance_invoice_comments WHERE id=? AND invoice_id=?')
.get(req.params.commentId, req.params.id);
if (!existing) return res.status(404).json({ error: 'Commentaire introuvable' });
db.prepare('DELETE FROM finance_invoice_comments WHERE id=?').run(existing.id);
res.status(204).end();
});

// Échéances de paiement personnalisées (Pennylane n'expose qu'une seule
// deadline — `installments` y est encore en alpha et toujours null — donc ces
// dates d'échelonnement sont gérées entièrement de notre côté). Chaque
// échéance porte désormais un statut personnalisable (finance_installment_statuses)
// et un montant déjà réglé — `paid` (0/1) reste maintenu en synchro pour du
// code plus ancien éventuel, mais paid_amount est la source de vérité.
function installmentWithStatus(id) {
return db.prepare(`
SELECT fi.*, s.label AS status_label, s.color AS status_color
FROM finance_invoice_installments fi
LEFT JOIN finance_installment_statuses s ON s.id = fi.status_id
WHERE fi.id = ?
`).get(id);
}
function shapeInstallment(row) {
return {
id: row.id,
invoiceId: row.invoice_id,
label: row.label,
dueDate: row.due_date,
amount: row.amount,
paidAmount: row.paid_amount || 0,
solde: Math.max(0, (row.amount || 0) - (row.paid_amount || 0)),
paid: !!row.paid,
statusId: row.status_id,
statusLabel: row.status_label || null,
statusColor: row.status_color || null,
createdAt: row.created_at,
};
}
// Valide et normalise un statusId envoyé par le front — null/absent = pas de
// statut choisi explicitement (voir defaultInstallmentStatusId ci-dessous
// pour ce que ça devient réellement), et un id qui ne correspond à aucune
// ligne de finance_installment_statuses est rejeté plutôt que silencieusement
// ignoré (évite qu'un statut supprimé entre-temps se retrouve à réapparaître).
function resolveStatusId(rawStatusId) {
if (rawStatusId === undefined) return undefined; // pas touché
if (rawStatusId === null || rawStatusId === '') return null;
const id = Number(rawStatusId);
const exists = db.prepare('SELECT id FROM finance_installment_statuses WHERE id=?').get(id);
if (!exists) return false; // signal d'erreur pour l'appelant
return id;
}
// Statut par défaut d'une échéance quand rien n'est choisi (09/2026) :
// "Sans statut" a été retiré du sélecteur côté front (recouvrement/frontend/
// app.js) — on retombe désormais sur "Douteux" plutôt que sur une absence de
// statut (status_id/deadline_status_id NULL). Matché par libellé — fragile
// si l'équipe renomme "Douteux" depuis Paramètres, mais suffisant pour une v1
// (voir le prompt de dev, point 3.b, qui documente aussi l'alternative
// `is_default` si on veut un jour un matching plus robuste).
function defaultInstallmentStatusId() {
const row = db.prepare("SELECT id FROM finance_installment_statuses WHERE label='Douteux' ORDER BY sort_order ASC LIMIT 1").get();
return row ? row.id : null;
}

app.get('/api/finance/invoices/:id/installments', requireFinance, (req, res) => {
const rows = db.prepare(`
SELECT fi.*, s.label AS status_label, s.color AS status_color
FROM finance_invoice_installments fi
LEFT JOIN finance_installment_statuses s ON s.id = fi.status_id
WHERE fi.invoice_id=? ORDER BY fi.due_date ASC
`).all(req.params.id);
res.json(rows.map(shapeInstallment));
});

app.post('/api/finance/invoices/:id/installments', requireFinance, (req, res) => {
const invoice = db.prepare('SELECT id FROM pennylane_invoices WHERE id=?').get(req.params.id);
if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
const dueDate = String(req.body.dueDate || '').trim();
const amount = Number(req.body.amount);
if (!dueDate) return res.status(400).json({ error: 'Date d\'échéance requise' });
if (!amount || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
let statusId = resolveStatusId(req.body.statusId);
if (statusId === false) return res.status(400).json({ error: 'Statut d\'échéance introuvable' });
// "Sans statut" n'existe plus comme état possible (09/2026) : une échéance
// créée sans statut choisi démarre directement sur "Douteux" plutôt que sur
// NULL — voir defaultInstallmentStatusId() ci-dessus.
if (statusId === undefined || statusId === null) statusId = defaultInstallmentStatusId();
// Si on crée directement l'échéance sur un statut "compte comme réglée"
// (ex. import d'un historique déjà soldé), le montant réglé se solde tout
// seul sur le montant total, sauf si paidAmount est explicitement fourni.
let paidAmount = req.body.paidAmount !== undefined ? Number(req.body.paidAmount) : (isStatusReglee(statusId) ? amount : 0);
if (Number.isNaN(paidAmount) || paidAmount < 0) return res.status(400).json({ error: 'Montant réglé invalide' });
const label = req.body.label ? String(req.body.label).trim() : null;
const paid = paidAmount >= amount ? 1 : 0;
const r = db.prepare('INSERT INTO finance_invoice_installments (invoice_id, label, due_date, amount, paid, paid_amount, status_id) VALUES (?,?,?,?,?,?,?)')
.run(req.params.id, label, dueDate, amount, paid, paidAmount, statusId);
maybeAutoSolde(req.params.id);
res.status(201).json(shapeInstallment(installmentWithStatus(r.lastInsertRowid)));
});

app.patch('/api/finance/invoices/:id/installments/:installmentId', requireFinance, (req, res) => {
const existing = db.prepare('SELECT * FROM finance_invoice_installments WHERE id=? AND invoice_id=?')
.get(req.params.installmentId, req.params.id);
if (!existing) return res.status(404).json({ error: 'Échéance introuvable' });
let statusId = resolveStatusId(req.body.statusId);
if (statusId === false) return res.status(400).json({ error: 'Statut d\'échéance introuvable' });
// "Sans statut" n'existe plus comme état possible (09/2026) : si le front
// envoie explicitement un statut vide, on retombe sur "Douteux" plutôt que
// de laisser l'échéance repasser à NULL. `undefined` (statut non touché par
// cette requête) reste distinct et laisse le statut existant inchangé.
if (statusId === null) statusId = defaultInstallmentStatusId();
let paidAmount = existing.paid_amount || 0;
if (req.body.paidAmount !== undefined) {
paidAmount = Number(req.body.paidAmount);
if (Number.isNaN(paidAmount) || paidAmount < 0) return res.status(400).json({ error: 'Montant réglé invalide' });
} else if (statusId !== undefined && isStatusReglee(statusId)) {
// Valider une échéance en la passant sur un statut "compte comme réglée"
// solde automatiquement son montant réglé (demandé) — sans ressaisie,
// sauf si paidAmount est aussi envoyé explicitement dans la même requête.
paidAmount = existing.amount;
}
// `paid` reste dérivé automatiquement de paid_amount vs amount — on ne le
// lit plus en entrée (l'ancienne case à cocher a été remplacée par le
// montant réglé + le statut), mais on le maintient à jour pour tout code
// plus ancien qui le lirait encore.
const paid = paidAmount >= existing.amount ? 1 : 0;
db.prepare('UPDATE finance_invoice_installments SET paid=?, paid_amount=?, status_id=? WHERE id=?')
.run(paid, paidAmount, statusId === undefined ? existing.status_id : statusId, existing.id);
maybeAutoSolde(req.params.id);
res.json(shapeInstallment(installmentWithStatus(existing.id)));
});

app.delete('/api/finance/invoices/:id/installments/:installmentId', requireFinance, (req, res) => {
const existing = db.prepare('SELECT id FROM finance_invoice_installments WHERE id=? AND invoice_id=?')
.get(req.params.installmentId, req.params.id);
if (!existing) return res.status(404).json({ error: 'Échéance introuvable' });
db.prepare('DELETE FROM finance_invoice_installments WHERE id=?').run(existing.id);
// Supprimer une échéance peut faire retomber la chaîne à "tout réglé" (ex.
// on retire une tranche encore en attente) — on revérifie après coup.
maybeAutoSolde(req.params.id);
res.status(204).end();
});

// ── Statuts d'échéance personnalisables (Paramètres > Recouvrement) ─────────
// Liste éditable (libellé + couleur + ordre) référencée par status_id sur
// chaque échéance ci-dessus — contrairement à FINANCE_INTERNAL_STATUSES (le
// statut de la facture entière), cette liste n'est pas figée dans le code.
app.get('/api/finance/installment-statuses', requireFinance, (req, res) => {
res.json(db.prepare('SELECT * FROM finance_installment_statuses ORDER BY sort_order ASC, id ASC').all());
});

app.post('/api/finance/installment-statuses', requireFinance, (req, res) => {
const label = String(req.body.label || '').trim();
if (!label) return res.status(400).json({ error: 'Libellé requis' });
const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';
const compteRegle = req.body.compteRegle ? 1 : 0;
const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS m FROM finance_installment_statuses').get().m;
const r = db.prepare('INSERT INTO finance_installment_statuses (label, color, sort_order, compte_regle) VALUES (?,?,?,?)')
.run(label, color, maxOrder + 1, compteRegle);
res.status(201).json(db.prepare('SELECT * FROM finance_installment_statuses WHERE id=?').get(r.lastInsertRowid));
});

app.patch('/api/finance/installment-statuses/:statusId', requireFinance, (req, res) => {
const existing = db.prepare('SELECT * FROM finance_installment_statuses WHERE id=?').get(req.params.statusId);
if (!existing) return res.status(404).json({ error: 'Statut introuvable' });
const label = req.body.label !== undefined ? String(req.body.label).trim() : existing.label;
if (!label) return res.status(400).json({ error: 'Libellé requis' });
const color = req.body.color !== undefined
? (/^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : existing.color)
: existing.color;
const sortOrder = req.body.sortOrder !== undefined ? Number(req.body.sortOrder) : existing.sort_order;
// Case "compte comme réglée" (Paramètres) : c'est elle qui fait avancer la
// référence de retard à l'échéance suivante et déclenche le passage auto de
// la facture en "Soldée" quand toute la chaîne y est — voir financeRoutes.js.
const compteRegle = req.body.compteRegle !== undefined ? (req.body.compteRegle ? 1 : 0) : existing.compte_regle;
db.prepare('UPDATE finance_installment_statuses SET label=?, color=?, sort_order=?, compte_regle=? WHERE id=?')
.run(label, color, sortOrder, compteRegle, existing.id);
res.json(db.prepare('SELECT * FROM finance_installment_statuses WHERE id=?').get(existing.id));
});

app.delete('/api/finance/installment-statuses/:statusId', requireFinance, (req, res) => {
const existing = db.prepare('SELECT id FROM finance_installment_statuses WHERE id=?').get(req.params.statusId);
if (!existing) return res.status(404).json({ error: 'Statut introuvable' });
// Les échéances qui pointaient sur ce statut retombent sur "Douteux" (statut
// par défaut, voir defaultInstallmentStatusId) plutôt que de garder une
// référence morte ou de repasser à "Sans statut" (qui n'existe plus).
const fallbackId = existing.label === 'Douteux' ? null : defaultInstallmentStatusId();
db.prepare('UPDATE finance_invoice_installments SET status_id=? WHERE status_id=?').run(fallbackId, existing.id);
db.prepare('UPDATE pennylane_invoices SET deadline_status_id=? WHERE deadline_status_id=?').run(fallbackId, existing.id);
db.prepare('DELETE FROM finance_installment_statuses WHERE id=?').run(existing.id);
res.status(204).end();
});

};
