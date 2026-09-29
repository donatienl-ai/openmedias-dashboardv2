// ── AVOIRS / DOUBLONS PENNYLANE — diagnostic (29/09/2026) ─────────────────────
// Lecture seule : compare, pour des numéros de facture donnés, les lignes
// stockées en base avec ce que Pennylane renvoie en direct. Sert à vérifier que
// les avoirs (ex : F6828 qui annule F6796) sont bien pris en compte et à
// comprendre les numéros présents deux fois (deux identifiants Pennylane).
const pennylane = require('./pennylane');

module.exports = function registerFinanceAvoirs(app, { db, requireFinance }) {
  const pick = (inv) => inv && ({
    id: inv.id, invoice_number: inv.invoice_number, status: inv.status, draft: inv.draft,
    credit_note: inv.credit_note, paid: inv.paid, date: inv.date, deadline: inv.deadline,
    amount: inv.amount, remaining: inv.remaining_amount_with_tax,
    credited_invoice: inv.credited_invoice || inv.credited_invoice_id || null,
    credit_notes: inv.credit_notes || null, updated_at: inv.updated_at,
    customer: inv.customer && inv.customer.id, keys: Object.keys(inv).join(','),
  });

  app.get('/api/finance/avoirs/diagnostic/:numeros', requireFinance, async (req, res) => {
    try {
      const numeros = String(req.params.numeros).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
      const out = {};
      for (const n of numeros) {
        const rows = db.prepare(`SELECT id, invoice_number, customer_id, date_emission, deadline, amount, remaining_amount,
          status, internal_status, synced_at, rowid AS r FROM pennylane_invoices WHERE invoice_number=? ORDER BY rowid`).all(n);
        for (const row of rows) {
          try { row.pennylane = pick(await pennylane.pennylaneFetch(`/customer_invoices/${encodeURIComponent(row.id)}`)); }
          catch (e) { row.pennylane = { erreur: String(e.message).slice(0, 200) }; }
        }
        out[n] = rows;
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/finance/avoirs/doublons', requireFinance, (req, res) => {
    const rows = db.prepare(`SELECT invoice_number, COUNT(*) AS n, GROUP_CONCAT(id || ':' || COALESCE(status,'') || ':' || COALESCE(internal_status,'') || ':' || remaining_amount, ' | ') AS detail
      FROM pennylane_invoices WHERE invoice_number IS NOT NULL GROUP BY invoice_number HAVING COUNT(*) > 1 ORDER BY invoice_number`).all();
    const ids = db.prepare(`SELECT LENGTH(id) AS len, COUNT(*) AS n, MIN(synced_at) AS min_sync, MAX(synced_at) AS max_sync FROM pennylane_invoices GROUP BY LENGTH(id)`).all();
    res.json({ nbNumerosEnDoublon: rows.length, parLongueurId: ids, doublons: rows });
  });
};
