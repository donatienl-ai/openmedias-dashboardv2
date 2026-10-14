// Acomptes / échéances lus dans la mention spéciale Pennylane (13/10/2026).
// Chargement protégé : si le module manque, la route marche sans ce champ.
let echeancesPennylane = null;
try { echeancesPennylane = require('./echeancesPennylane'); } catch (e) { console.warn('[finance] echeancesPennylane indisponible :', e.message); }

function echeancesPennylaneDe(r) {
  if (!echeancesPennylane || !r || !r.special_mention) return { acomptes: [], alertes: [] };
  try {
    return echeancesPennylane.calculerEcheances({
      mention: r.special_mention,
      montantTtc: r.amount,
      restant: r.remaining_amount,
      status: r.status,
      aujourdhui: new Date().toISOString().slice(0, 10),
    });
  } catch (e) {
    return { acomptes: [], alertes: ['Lecture des acomptes impossible : ' + e.message] };
  }
}

module.exports = function registerFinanceRoutes(app, { db, pennylane, requireFinance, FINANCE_INTERNAL_STATUSES }) {
  function joursDeRetard(deadline) {
    if (!deadline) return null;
    const d = new Date(`${deadline}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((today - d) / 86400000);
  }

  function isStatusReglee(statusId) {
    if (statusId == null) return false;
    const s = db.prepare('SELECT compte_regle FROM finance_installment_statuses WHERE id=?').get(statusId);
    return !!(s && s.compte_regle);
  }

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

  function computeEcheanceReference(chain) {
    for (const item of chain) {
      if (!isStatusReglee(item.statusId)) return { due: item.due, num: item.num, allReglees: false };
    }
    const last = chain[chain.length - 1];
    return { due: last.due, num: last.num, allReglees: true };
  }

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

  const PENNYLANE_HORS_RECOUVREMENT = ['draft', 'credit_note', 'cancelled', 'partially_cancelled', 'archived', 'incomplete', 'paid'];
  const HORS_RECOUVREMENT_PLACEHOLDERS = PENNYLANE_HORS_RECOUVREMENT.map(() => '?').join(',');

  // Retire la civilité (M., Mr, Mme, Mlle, Monsieur, Madame…) placée devant les noms/prénoms
  // de contact (demande Lina 29/09/2026). « Mrabet » n'est pas touché : les formes sans point
  // doivent être suivies d'un espace.
  function stripCivility(name) {
    let n = String(name || '').trim();
    const re = /^(?:m\.|(?:mr|mme|mmes|mlle|melle|mm|monsieur|madame|mademoiselle|messieurs)\.?(?=[\s,]))[\s,]*(?:(?:et|&)\s+)?/i;
    let prev;
    do { prev = n; n = n.replace(re, '').trim(); } while (n !== prev && n);
    return n;
  }

  function shapeInvoiceRow(r, installments) {
    const echRef = computeEcheanceReference(buildEcheanceChain(r, installments));
    
    let firstName = '';
    let lastName = '';
    const rawContact = stripCivility(r.contact_name);
    
    if (rawContact) {
      const parts = rawContact.split(' ');
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }
    
    const fullName = rawContact || r.customer_name || 'Client inconnu';

    return {
      id: r.id,
      echeancesPennylane: echeancesPennylaneDe(r),
      
      invoiceNumber: r.invoice_number,
      invoice_number: r.invoice_number,
      
      customerId: r.customer_id,
      customer_id: r.customer_id,
      
      customerFirstName: firstName,
      customer_first_name: firstName, 
      
      customerLastName: lastName,
      customer_last_name: lastName,
      
      customerFullName: fullName,
      customer_full_name: fullName,
      
      customerName: r.customer_name || '',
      customer_name: r.customer_name || '',
      
      customerEmail: r.customer_email || '',
      customer_email: r.customer_email || '',
      
      customerPhone: r.customer_phone || '',
      customer_phone: r.customer_phone || '',
      
      contactName: rawContact,
      contact_name: rawContact,
      
      contactEmail: r.contact_email || '',
      contact_email: r.contact_email || '',
      
      contactPhone: r.contact_phone || '',
      contact_phone: r.contact_phone || '',
      
      dateEmission: r.date_emission,
      date_emission: r.date_emission,
      
      deadline: r.deadline,
      
      deadlineManual: !!r.deadline_manual,
      deadline_manual: !!r.deadline_manual,
      
      deadlineStatusId: r.deadline_status_id,
      deadline_status_id: r.deadline_status_id,
      
      deadlineStatusLabel: r.deadline_status_label || null,
      deadline_status_label: r.deadline_status_label || null,
      
      deadlineStatusColor: r.deadline_status_color || null,
      deadline_status_color: r.deadline_status_color || null,
      
      amountHt: r.amount_ht,
      amount_ht: r.amount_ht,
      
      amountTtc: r.amount,
      amount: r.amount,
      
      remainingAmountHt: r.remaining_amount_ht,
      remaining_amount_ht: r.remaining_amount_ht,
      
      remainingAmountTtc: r.remaining_amount,
      remaining_amount: r.remaining_amount,
      
      status: r.status,
      
      internalStatus: r.internal_status,
      internal_status: r.internal_status,
      
      daysLate: joursDeRetard(echRef.due),
      days_late: joursDeRetard(echRef.due),
      
      retardEcheanceNum: echRef.num,
      retard_echeance_num: echRef.num,
      
      retardEcheanceDue: echRef.due,
      retard_echeance_due: echRef.due,
      
      allEcheancesReglees: echRef.allReglees,
      all_echeances_reglees: echRef.allReglees,
      
      lastRelanceAt: r.last_relance_at || null,
      last_relance_at: r.last_relance_at || null,
      
      installments,
    };
  }

  app.get('/api/finance/invoices', requireFinance, (req, res) => {
    const rows = db.prepare(`
      SELECT i.*, 
        c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
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
      WHERE i.date_emission >= '2025-01-01'
    `).all();

    const uniqueInvoices = new Map();
    for (const r of rows) {
      const invNum = String(r.invoice_number || r.id || '').trim();
      if (!uniqueInvoices.has(invNum)) {
        uniqueInvoices.set(invNum, r);
      }
    }
    const deduplicatedRows = Array.from(uniqueInvoices.values());

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
    
    let list = deduplicatedRows.map((r) => shapeInvoiceRow(r, installmentsByInvoice[r.id] || []));
    
    if (statut) list = list.filter((r) => r.internalStatus === statut);
    if (retard_only === '1') list = list.filter((r) => (r.daysLate || 0) > 0);
    if (qLower) {
      list = list.filter(
        (r) => (r.invoiceNumber || '').toLowerCase().includes(qLower) || 
               r.customerName.toLowerCase().includes(qLower) ||
               (r.customerFullName || '').toLowerCase().includes(qLower)
      );
    }
    list.sort((a, b) => (b.daysLate ?? -9999) - (a.daysLate ?? -9999));
    res.json(list);
  });

  app.get('/api/finance/invoices/:id', requireFinance, (req, res) => {
    const r = db.prepare(`
      SELECT i.*, 
        c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
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

  const FINANCE_STATUTS_NON_ACTIONABLES = ['litige', 'promesse_paiement', 'solde', 'douteux'];

  app.get('/api/finance/kpis', requireFinance, (req, res) => {
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
    const parStatut = {};
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
    let deadline = existing.deadline;
    let deadlineManual = existing.deadline_manual;
    if (req.body.deadline !== undefined) {
      const d = String(req.body.deadline).trim();
      if (!DEADLINE_RE.test(d)) return res.status(400).json({ error: 'Date d\'échéance invalide (attendu AAAA-MM-JJ)' });
      deadline = d;
      deadlineManual = 1;
    }
    let deadlineStatusId = resolveStatusId(req.body.deadlineStatusId);
    if (deadlineStatusId === false) return res.status(400).json({ error: 'Statut d\'échéance introuvable' });
    if (deadlineStatusId === null) deadlineStatusId = defaultInstallmentStatusId();
    db.prepare('UPDATE pennylane_invoices SET internal_status=?, deadline=?, deadline_manual=?, deadline_status_id=? WHERE id=?')
      .run(internalStatus, deadline, deadlineManual, deadlineStatusId === undefined ? existing.deadline_status_id : deadlineStatusId, req.params.id);
    maybeAutoSolde(req.params.id);
    res.json(db.prepare('SELECT * FROM pennylane_invoices WHERE id=?').get(req.params.id));
  });

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

  app.delete('/api/finance/invoices/:id/comments/:commentId', requireFinance, (req, res) => {
    const existing = db.prepare('SELECT id FROM finance_invoice_comments WHERE id=? AND invoice_id=?')
      .get(req.params.commentId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Commentaire introuvable' });
    db.prepare('DELETE FROM finance_invoice_comments WHERE id=?').run(existing.id);
    res.status(204).end();
  });

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

  function resolveStatusId(rawStatusId) {
    if (rawStatusId === undefined) return undefined;
    if (rawStatusId === null || rawStatusId === '') return null;
    const id = Number(rawStatusId);
    const exists = db.prepare('SELECT id FROM finance_installment_statuses WHERE id=?').get(id);
    if (!exists) return false;
    return id;
  }

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
    if (statusId === undefined || statusId === null) statusId = defaultInstallmentStatusId();
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
    if (statusId === null) statusId = defaultInstallmentStatusId();
    let paidAmount = existing.paid_amount || 0;
    if (req.body.paidAmount !== undefined) {
      paidAmount = Number(req.body.paidAmount);
      if (Number.isNaN(paidAmount) || paidAmount < 0) return res.status(400).json({ error: 'Montant réglé invalide' });
    } else if (statusId !== undefined && isStatusReglee(statusId)) {
      paidAmount = existing.amount;
    }
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
    maybeAutoSolde(req.params.id);
    res.status(204).end();
  });

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
    const compteRegle = req.body.compteRegle !== undefined ? (req.body.compteRegle ? 1 : 0) : existing.compte_regle;
    db.prepare('UPDATE finance_installment_statuses SET label=?, color=?, sort_order=?, compte_regle=? WHERE id=?')
      .run(label, color, sortOrder, compteRegle, existing.id);
    res.json(db.prepare('SELECT * FROM finance_installment_statuses WHERE id=?').get(existing.id));
  });

  app.delete('/api/finance/installment-statuses/:statusId', requireFinance, (req, res) => {
    const existing = db.prepare('SELECT id FROM finance_installment_statuses WHERE id=?').get(req.params.statusId);
    if (!existing) return res.status(404).json({ error: 'Statut introuvable' });
    const fallbackId = existing.label === 'Douteux' ? null : defaultInstallmentStatusId();
    db.prepare('UPDATE finance_invoice_installments SET status_id=? WHERE status_id=?').run(fallbackId, existing.id);
    db.prepare('UPDATE pennylane_invoices SET deadline_status_id=? WHERE deadline_status_id=?').run(fallbackId, existing.id);
    db.prepare('DELETE FROM finance_installment_statuses WHERE id=?').run(existing.id);
    res.status(204).end();
  });

  // Import Excel des créances douteuses (29/09/2026)
  require('./creancesDouteuses')(app, { db, requireFinance });
  // Diagnostic avoirs / doublons Pennylane (29/09/2026)
  require('./financeAvoirs')(app, { db, requireFinance });
  // Trello × recouvrement, lecture seule (14/10/2026). Chargement protégé : si le
  // module manque ou plante, le reste du recouvrement fonctionne normalement.
  try { require('./trelloRecouvrement')(app, { db, requireFinance }); } catch (e) { console.warn('[trello] module indisponible :', e.message); }
};
