const PENNYLANE_API_URL = 'https://api.pennylane.com/v1';

async function pennylaneFetch(endpoint, options = {}) {
  const apiKey = process.env.PENNYLANE_API_KEY;
  if (!apiKey) {
    throw new Error('Clé API Pennylane manquante (PENNYLANE_API_KEY dans process.env)');
  }

  const response = await fetch(`${PENNYLANE_API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erreur API Pennylane (${response.status}) : ${errorText}`);
  }

  return response.json();
}

async function fetchAllInvoices() {
  let invoices = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await pennylaneFetch(`/customer_invoices?page=${page}&per_page=100`);
    const items = data.customer_invoices || data.invoices || data.data || [];
    
    invoices = invoices.concat(items);

    if (data.has_more || (data.pagination && page < data.pagination.total_pages)) {
      page++;
    } else {
      hasMore = false;
    }
  }

  return invoices;
}

async function syncFinance(db) {
  const invoices = await fetchAllInvoices();
  let invoicesSynced = 0;
  let customersSynced = 0;

  const insertCustomer = db.prepare(`
    INSERT INTO pennylane_customers (id, name, contact_name, email, phone)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      contact_name = COALESCE(NULLIF(excluded.contact_name, ''), pennylane_customers.contact_name),
      email = COALESCE(NULLIF(excluded.email, ''), pennylane_customers.email),
      phone = COALESCE(NULLIF(excluded.phone, ''), pennylane_customers.phone)
  `);

  const insertInvoice = db.prepare(`
    INSERT INTO pennylane_invoices (
      id, invoice_number, customer_id, date_emission, deadline, deadline_manual,
      amount, amount_ht, remaining_amount, remaining_amount_ht, status, internal_status
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'a_relancer')
    ON CONFLICT(id) DO UPDATE SET
      invoice_number = excluded.invoice_number,
      customer_id = excluded.customer_id,
      date_emission = excluded.date_emission,
      deadline = CASE WHEN pennylane_invoices.deadline_manual = 1 THEN pennylane_invoices.deadline ELSE excluded.deadline END,
      amount = excluded.amount,
      amount_ht = excluded.amount_ht,
      remaining_amount = excluded.remaining_amount,
      remaining_amount_ht = excluded.remaining_amount_ht,
      status = excluded.status
  `);

  db.transaction(() => {
    const customersSeen = new Set();

    for (const inv of invoices) {
      const customer = inv.customer || {};
      const billing = inv.billing_address || customer.billing_address || {};

      // Extraction approfondie du nom/prénom depuis la facture
      const firstName = customer.first_name || billing.first_name || '';
      const lastName = customer.last_name || billing.last_name || '';
      
      let contactName = [firstName, lastName].filter(Boolean).join(' ');
      if (!contactName) {
        contactName = inv.recipient_name || billing.name || customer.contact_name || customer.name || '';
      }

      const customerId = String(inv.customer_id || customer.id || '');
      const customerName = customer.name || customer.company_name || inv.recipient_name || 'Client inconnu';
      const email = customer.email || billing.email || inv.recipient_email || '';
      const phone = customer.phone || billing.phone || '';

      if (customerId && !customersSeen.has(customerId)) {
        insertCustomer.run(customerId, customerName, contactName, email, phone);
        customersSeen.add(customerId);
        customersSynced++;
      }

      const invoiceId = String(inv.id);
      const invoiceNumber = inv.number || inv.invoice_number || invoiceId;
      const dateEmission = inv.date || inv.issue_date || inv.created_at || new Date().toISOString().slice(0, 10);
      const deadline = inv.deadline || inv.due_date || dateEmission;
      const amount = Number(inv.amount || inv.total_incl_taxes || 0);
      const amountHt = Number(inv.amount_ht || inv.total_excl_taxes || amount);
      const remainingAmount = Number(inv.remaining_amount !== undefined ? inv.remaining_amount : amount);
      const remainingAmountHt = Number(inv.remaining_amount_ht !== undefined ? inv.remaining_amount_ht : amountHt);
      const status = inv.status || 'draft';

      insertInvoice.run(
        invoiceId,
        invoiceNumber,
        customerId || null,
        dateEmission,
        deadline,
        amount,
        amountHt,
        remainingAmount,
        remainingAmountHt,
        status
      );

      invoicesSynced++;
    }
  })();

  return { invoicesSynced, customersSynced };
}

async function getInvoicePdfUrl(invoiceId) {
  const data = await pennylaneFetch(`/customer_invoices/${encodeURIComponent(invoiceId)}`);
  const inv = data.customer_invoice || data.invoice || data;
  
  return {
    url: inv.public_file_url || inv.pdf_url || inv.file_url || null,
  };
}

module.exports = {
  pennylaneFetch,
  syncFinance,
  getInvoicePdfUrl,
};
