// ── CONNECTEUR PENNYLANE (recouvrement) ──────────────────────────────────────
const API_BASE = 'https://app.pennylane.com/api/external/v2';

function apiToken() {
  const t = process.env.PENNYLANE_API_TOKEN || process.env.PENNYLANE_API_KEY;
  if (!t) throw new Error('Pennylane non configuré (variable PENNYLANE_API_TOKEN ou PENNYLANE_API_KEY manquante)');
  return t;
}

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

function amountsOf(invoice) {
  const ttc = Number(invoice.amount) || 0;
  const tax = Number(invoice.tax) || 0;
  return {
    ht: Number((ttc - tax).toFixed(2)),
    ttc,
    // Facture payée dans Pennylane → restant 0 (Pennylane laisse parfois le restant
    // égal au total sur des factures payées ; constaté sur ~1 400 factures, 13/10/2026).
    remainingHt: isPaid(invoice) ? 0 : Number(invoice.remaining_amount_without_tax) || 0,
    remainingTtc: isPaid(invoice) ? 0 : Number(invoice.remaining_amount_with_tax) || 0,
  };
}

function isPaid(invoice) {
  return invoice.paid === true || invoice.status === 'paid';
}

// Mention spéciale : contient les acomptes / échéances saisis dans Pennylane.
// Enregistrée seulement si le champ est présent dans la réponse (sinon on garde l'ancienne valeur).
const _mentionStmts = new WeakMap();
function saveSpecialMention(db, inv) {
  if (!inv || !Object.prototype.hasOwnProperty.call(inv, 'special_mention')) return;
  try {
    if (!_mentionStmts.has(db)) _mentionStmts.set(db, db.prepare('UPDATE pennylane_invoices SET special_mention = ? WHERE id = ?'));
    _mentionStmts.get(db).run(inv.special_mention ? String(inv.special_mention) : null, String(inv.id));
  } catch (e) {
    // Ne jamais bloquer la synchro pour la mention (ex. colonne pas encore créée).
  }
}

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

function defaultDeadlineStatusId(db) {
  const row = db.prepare("SELECT id FROM finance_installment_statuses WHERE label='Douteux' ORDER BY sort_order ASC LIMIT 1").get();
  return row ? row.id : null;
}

const PENNYLANE_STATUSES_SOLDEES = ['paid', 'cancelled', 'partially_cancelled', 'credit_note'];

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

async function syncFinance(db) {
  const [invoices, customers] = await Promise.all([
    getAllPaginated('customer_invoices'),
    getAllPaginated('customers'),
  ]);

  const invoiceContacts = new Map();
  for (const inv of invoices) {
    const custId = customerIdOf(inv);
    if (!custId || invoiceContacts.has(custId)) continue;

    const cust = inv.customer || {};
    const billing = inv.billing_address || cust.billing_address || {};
    const firstName = cust.first_name || billing.first_name || '';
    const lastName = cust.last_name || billing.last_name || '';
    let name = [firstName, lastName].filter(Boolean).join(' ');
    if (!name) {
      name = inv.recipient_name || inv.recipient || billing.name || cust.recipient || '';
    }
    if (name) {
      invoiceContacts.set(custId, name.trim());
    }
  }

  const dueCustomerIds = new Set(
    invoices
      .filter((inv) => !inv.draft && !inv.credit_note && (Number(inv.remaining_amount_with_tax) || 0) > 0)
      .map((inv) => customerIdOf(inv))
      .filter(Boolean)
  );

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
      });
    }
  } catch (e) {
    console.warn('[PENNYLANE] récupération des contacts interrompue :', e.message);
  }

  const upsertCustomer = buildUpsertCustomer(db);
  const upsertInvoice = buildUpsertInvoice(db);
  const defaultStatusId = defaultDeadlineStatusId(db);

  const runAll = db.transaction(() => {
    for (const c of customers) {
      const contact = contactsById.get(String(c.id));
      const extractedName = invoiceContacts.get(String(c.id));

      upsertCustomer.run(
        String(c.id),
        c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
        (Array.isArray(c.emails) ? c.emails[0] : c.email) || '',
        c.phone || c.phone_number || '',
        (contact && contact.name) || extractedName || (c.recipient || '').trim() || null,
        contact ? contact.email : null,
        contact ? contact.phone : null
      );
    }
    for (const inv of invoices) {
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
      saveSpecialMention(db, inv);
    }
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

async function syncInvoiceChanges(db) {
  let startDate = getStoredCheckpoint(db);
  if (!startDate) {
    startDate = new Date().toISOString();
    storeCheckpoint(db, startDate);
  }

  let page;
  try {
    page = await fetchChangesPage(startDate);
  } catch (e) {
    if (String(e.message).includes('(422)')) {
      storeCheckpoint(db, new Date().toISOString());
      return { checked: 0, applied: 0, reset: true };
    }
    throw e;
  }

  const items = Array.isArray(page.items) ? page.items : [];
  if (items.length === 0) {
    return { checked: 0, applied: 0 };
  }

  const changedIds = [...new Set(items.filter((it) => it.operation !== 'delete').map((it) => String(it.id)))];
  const maxProcessedAt = items.reduce((max, it) => (it.processed_at && (!max || it.processed_at > max) ? it.processed_at : max), null);

  if (changedIds.length === 0) {
    if (!page.has_more && maxProcessedAt) storeCheckpoint(db, maxProcessedAt);
    return { checked: items.length, applied: 0 };
  }

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
          console.warn(`[PENNYLANE][CHANGES] client ${custId} introuvable :`, e.message);
        }
      }
    }
  } catch (e) {
    return { checked: items.length, applied: 0, error: e.message };
  }

  const upsertCustomer = buildUpsertCustomer(db);
  const upsertInvoice = buildUpsertInvoice(db);
  const defaultStatusId = defaultDeadlineStatusId(db);

  const runAll = db.transaction(() => {
    for (const c of fetchedCustomers) {
      const matchingInv = fetchedInvoices.find(i => customerIdOf(i) === String(c.id));
      let extractedName = null;
      if (matchingInv) {
        const cust = matchingInv.customer || {};
        const billing = matchingInv.billing_address || cust.billing_address || {};
        const firstName = cust.first_name || billing.first_name || '';
        const lastName = cust.last_name || billing.last_name || '';
        extractedName = [firstName, lastName].filter(Boolean).join(' ') || matchingInv.recipient_name || matchingInv.recipient || billing.name || cust.recipient || '';
      }

      upsertCustomer.run(
        String(c.id),
        c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
        (Array.isArray(c.emails) ? c.emails[0] : c.email) || '',
        c.phone || c.phone_number || '',
        extractedName || (c.recipient || '').trim() || null, 
        null, null
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
      saveSpecialMention(db, inv);
    }
    if (!page.has_more && maxProcessedAt) storeCheckpoint(db, maxProcessedAt);
  });
  runAll();

  return { checked: items.length, applied: fetchedInvoices.length };
}

async function getInvoicePdfUrl(id) {
  const json = await pennylaneFetch(`/customer_invoices/${encodeURIComponent(id)}`);
  if (!json.public_file_url) throw new Error("Pennylane n'a renvoyé aucun PDF pour cette facture");
  return { url: json.public_file_url, filename: json.filename || null };
}

module.exports = { syncFinance, syncInvoiceChanges, getInvoicePdfUrl, getAllPaginated, pennylaneFetch };
