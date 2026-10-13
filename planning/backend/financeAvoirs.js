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

  // ── DIAGNOSTIC ÉCHÉANCES / ACOMPTES / PAIEMENTS (13/10/2026, lecture seule) ──
  // Montre, pour quelques factures, ce que Pennylane expose dans installments,
  // payments et matched_transactions, et compare le restant dû stocké avec ce
  // que Pennylane renvoie. Ne garde que les montants, dates et statuts (aucune
  // coordonnée client). Sert à décider comment lire les échéances et acomptes.
  const KEEP = /(^id$|amount|date|status|paid|deadline|due|label|currency|number|type|percent|rank|position)/i;
  const slim = (o) => {
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, val] of Object.entries(o)) {
      if (!KEEP.test(k)) continue;
      out[k] = val && typeof val === 'object' ? (val.id !== undefined ? { id: val.id } : '[objet]') : val;
    }
    return out;
  };
  const API_PREFIX = 'https://app.pennylane.com/api/external/v2';
  async function readNested(value) {
    if (value == null) return null;
    if (Array.isArray(value)) return { forme: 'tableau', n: value.length, elements: value.slice(0, 12).map(slim) };
    if (typeof value === 'object' && value.url) {
      try {
        const json = await pennylane.pennylaneFetch(String(value.url).replace(API_PREFIX, ''));
        const items = Array.isArray(json) ? json : (json.items || []);
        return { forme: 'url', n: items.length, elements: items.slice(0, 12).map(slim) };
      } catch (e) { return { forme: 'url', erreur: String(e.message).slice(0, 200) }; }
    }
    return { forme: typeof value, valeur: slim(value) };
  }

  app.get('/api/finance/diagnostic/echeances/:numeros', requireFinance, async (req, res) => {
    try {
      const numeros = String(req.params.numeros).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
      const out = {};
      for (const n of numeros) {
        const rows = db.prepare('SELECT id, invoice_number, amount, remaining_amount, status, internal_status FROM pennylane_invoices WHERE invoice_number=? ORDER BY rowid').all(n);
        for (const row of rows) {
          try {
            const inv = await pennylane.pennylaneFetch(`/customer_invoices/${encodeURIComponent(row.id)}`);
            row.pennylane = {
              status: inv.status, paid: inv.paid, amount: inv.amount,
              remaining_amount_with_tax: inv.remaining_amount_with_tax,
              deadline: inv.deadline,
              installments: await readNested(inv.installments),
              payments: await readNested(inv.payments),
              matched_transactions: await readNested(inv.matched_transactions),
              // Textes libres de la facture (souvent utilisés comme notes) et tentative
              // de lecture des commentaires Pennylane, si l'API les expose.
              special_mention: inv.special_mention ? String(inv.special_mention).slice(0, 500) : null,
              pdf_invoice_free_text: inv.pdf_invoice_free_text ? String(inv.pdf_invoice_free_text).slice(0, 500) : null,
              commentaires: await (async () => {
                for (const path of [`/customer_invoices/${encodeURIComponent(row.id)}/comments`, `/comments?filter=${encodeURIComponent(JSON.stringify([{ field: 'record_id', operator: 'eq', value: String(row.id) }]))}`]) {
                  try {
                    const json = await pennylane.pennylaneFetch(path);
                    const items = Array.isArray(json) ? json : (json.items || []);
                    return { source: path.split('?')[0], n: items.length, elements: items.slice(0, 10).map((c) => ({ date: c.created_at || c.date, texte: String(c.content || c.text || c.body || '').slice(0, 300) })) };
                  } catch (e) { /* endpoint absent : on essaie le suivant */ }
                }
                return { erreur: 'aucun endpoint de commentaires trouvé' };
              })(),
            };
          } catch (e) { row.pennylane = { erreur: String(e.message).slice(0, 200) }; }
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
