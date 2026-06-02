// ==========================================
//  CONNECTEUR SALESFORCE
//  Auth via Username-Password OAuth Flow
// ==========================================
import fetch from 'node-fetch';

let cachedAuth = null;
let cachedAuthExpiry = 0;

/**
 * Authentifie auprès de Salesforce et renvoie { access_token, instance_url }.
 * Met en cache le token pendant 1h pour éviter de se reconnecter à chaque appel.
 */
async function getAuth() {
  const now = Date.now();
  if (cachedAuth && now < cachedAuthExpiry) {
    return cachedAuth;
  }

  const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.SALESFORCE_CLIENT_ID,
    client_secret: process.env.SALESFORCE_CLIENT_SECRET,
    username: process.env.SALESFORCE_USERNAME,
    // Salesforce exige password + security token concaténés
    password: (process.env.SALESFORCE_PASSWORD || '') + (process.env.SALESFORCE_SECURITY_TOKEN || ''),
  });

  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedAuth = { accessToken: data.access_token, instanceUrl: data.instance_url };
  cachedAuthExpiry = now + 60 * 60 * 1000; // 1h
  return cachedAuth;
}

/**
 * Exécute une requête SOQL et renvoie le tableau de records.
 */
async function query(soql) {
  const { accessToken, instanceUrl } = await getAuth();
  const url = `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce query failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.records || [];
}

/**
 * Regroupe des records par nom de propriétaire, en sommant un champ optionnel.
 */
function groupByOwner(records, sumField) {
  const map = new Map();
  for (const r of records) {
    const owner = r.Owner?.Name || 'Inconnu';
    if (!map.has(owner)) map.set(owner, { name: owner, count: 0, amount: 0 });
    const entry = map.get(owner);
    entry.count += 1;
    if (sumField && typeof r[sumField] === 'number') entry.amount += r[sumField];
  }
  return Array.from(map.values()).sort((a, b) => b.amount - a.amount || b.count - a.count);
}

// --- Signatures du jour (Opportunity Closed Won aujourd'hui) ---
export async function getSignaturesToday() {
  const records = await query(
    `SELECT Id, Name, Amount, Owner.Name FROM Opportunity WHERE IsWon = true AND CloseDate = TODAY`
  );
  const detail = groupByOwner(records, 'Amount');
  const total = records.length;
  const totalAmount = records.reduce((s, r) => s + (r.Amount || 0), 0);
  return { total, totalAmount, detail };
}

// --- CA du mois (Opportunity Closed Won ce mois) ---
export async function getRevenueThisMonth() {
  const records = await query(
    `SELECT Id, Name, Amount, Owner.Name FROM Opportunity WHERE IsWon = true AND CloseDate = THIS_MONTH`
  );
  const detail = groupByOwner(records, 'Amount');
  const totalAmount = records.reduce((s, r) => s + (r.Amount || 0), 0);
  return { totalAmount, detail };
}

// --- Propals envoyées aujourd'hui (Lead Status = Working = "Proposition faite") ---
export async function getPropalsToday() {
  const records = await query(
    `SELECT Id, Name, Owner.Name FROM Lead WHERE Status = 'Working' AND LastModifiedDate = TODAY`
  );
  const detail = groupByOwner(records);
  const total = records.length;
  return { total, detail };
}
