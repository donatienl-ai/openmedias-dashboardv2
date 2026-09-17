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
app.get('/api/finance/invoices', requireFinance, (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
           c.contact_name AS contact_name, c.contact_email AS contact_email, c.contact_phone AS contact_phone,
           lr.last_relance_at AS last_relance_at
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
  `).all();
  const { statut, q, retard_only } = req.query;
  const qLower = q ? String(q).trim().toLowerCase() : '';
  let list = rows.map((r) => ({
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
    amountHt: r.amount_ht,
    amountTtc: r.amount,
    remainingAmountHt: r.remaining_amount_ht,
    remainingAmountTtc: r.remaining_amount,
    // Alias conservés pour compat avec un ancien code éventuel côté front.
    amount: r.amount,
    remainingAmount: r.remaining_amount,
    status: r.status,
    internalStatus: r.internal_status,
    daysLate: joursDeRetard(r.deadline),
    lastRelanceAt: r.last_relance_at || null,
  }));
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
  const unpaid = db.prepare(`
    SELECT remaining_amount, deadline, internal_status FROM pennylane_invoices
    WHERE remaining_amount > 0 AND (status IS NULL OR status NOT IN (${HORS_RECOUVREMENT_PLACEHOLDERS}))
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
  // Une relance faite = on passe implicitement de "à relancer" à "en cours",
  // sauf si un statut plus avancé (litige/promesse/solde) a déjà été posé à
  // la main — on ne veut pas écraser un statut plus informatif que "en cours".
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
  // L'attribution par collaborateur a été retirée (une seule personne gère le
  // recouvrement) — seuls le statut interne et l'échéance restent modifiables ici.
  db.prepare('UPDATE pennylane_invoices SET internal_status=?, deadline=?, deadline_manual=? WHERE id=?')
    .run(internalStatus, deadline, deadlineManual, req.params.id);
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

// Échéances de paiement personnalisées (Pennylane n'expose qu'une seule
// deadline — `installments` y est encore en alpha et toujours null — donc ces
// dates d'échelonnement sont gérées entièrement de notre côté).
app.get('/api/finance/invoices/:id/installments', requireFinance, (req, res) => {
  res.json(db.prepare('SELECT * FROM finance_invoice_installments WHERE invoice_id=? ORDER BY due_date ASC').all(req.params.id));
});

app.post('/api/finance/invoices/:id/installments', requireFinance, (req, res) => {
  const invoice = db.prepare('SELECT id FROM pennylane_invoices WHERE id=?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
  const dueDate = String(req.body.dueDate || '').trim();
  const amount = Number(req.body.amount);
  if (!dueDate) return res.status(400).json({ error: 'Date d\'échéance requise' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
  const label = req.body.label ? String(req.body.label).trim() : null;
  const r = db.prepare('INSERT INTO finance_invoice_installments (invoice_id, label, due_date, amount) VALUES (?,?,?,?)')
    .run(req.params.id, label, dueDate, amount);
  res.status(201).json(db.prepare('SELECT * FROM finance_invoice_installments WHERE id=?').get(r.lastInsertRowid));
});

app.patch('/api/finance/invoices/:id/installments/:installmentId', requireFinance, (req, res) => {
  const existing = db.prepare('SELECT * FROM finance_invoice_installments WHERE id=? AND invoice_id=?')
    .get(req.params.installmentId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Échéance introuvable' });
  const paid = req.body.paid !== undefined ? (req.body.paid ? 1 : 0) : existing.paid;
  db.prepare('UPDATE finance_invoice_installments SET paid=? WHERE id=?').run(paid, existing.id);
  res.json(db.prepare('SELECT * FROM finance_invoice_installments WHERE id=?').get(existing.id));
});

app.delete('/api/finance/invoices/:id/installments/:installmentId', requireFinance, (req, res) => {
  const existing = db.prepare('SELECT id FROM finance_invoice_installments WHERE id=? AND invoice_id=?')
    .get(req.params.installmentId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Échéance introuvable' });
  db.prepare('DELETE FROM finance_invoice_installments WHERE id=?').run(existing.id);
  res.status(204).end();
});


};
