// ==========================================
//  CONNECTEUR SALESFORCE
//  Auth via OAuth Client Credentials Flow
// ==========================================
import fetch from 'node-fetch';
import { matchSale, buildFullList } from './roster.js';
import { toSoqlDate, toSoqlDateTime } from './dateRange.js';

let cachedAuth = null;
let cachedAuthExpiry = 0;

async function getAuth() {
  const now = Date.now();
  if (cachedAuth && now < cachedAuthExpiry) return cachedAuth;

  // Client Credentials Flow : exige le My Domain (PAS login.salesforce.com).
  const domain = process.env.SALESFORCE_DOMAIN_URL || 'https://openmedias.my.salesforce.com';
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SALESFORCE_CLIENT_ID,
    client_secret: process.env.SALESFORCE_CLIENT_SECRET,
  });

  const res = await fetch(`${domain}/services/oauth2/token`, {
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
  cachedAuthExpiry = now + 60 * 60 * 1000;
  return cachedAuth;
}

async function query(soql) {
  const { accessToken, instanceUrl } = await getAuth();
  const url = `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce query failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.records || [];
}

function groupRecords(records, sumField) {
  const map = new Map();
  for (const r of records) {
    const owner = matchSale(r.Owner?.Name) || 'Inconnu';
    if (!map.has(owner)) map.set(owner, { count: 0, amount: 0 });
    const entry = map.get(owner);
    entry.count += 1;
    if (sumField && typeof r[sumField] === 'number') entry.amount += r[sumField];
  }
  return map;
}

function onlyActive(map, withAmount) {
  return Array.from(map.entries())
    .map(([name, e]) => (withAmount ? { name, count: e.count, amount: e.amount } : { name, count: e.count }))
    .sort((a, b) => (withAmount ? b.amount - a.amount : b.count - a.count));
}

// --- Signatures sur la période (Opportunity Closed Won, CloseDate dans la plage) ---
export async function getSignatures({ start, end }) {
  const s = toSoqlDate(start);
  const e = toSoqlDate(end);
  const records = await query(
    `SELECT Id, Name, Amount, Owner.Name FROM Opportunity WHERE IsWon = true AND CloseDate >= ${s} AND CloseDate <= ${e}`
  );
  const detail = onlyActive(groupRecords(records, 'Amount'), true);
  const total = records.length;
  const totalAmount = records.reduce((sum, r) => sum + (r.Amount || 0), 0);
  return { total, totalAmount, detail };
}

// --- CA sur la période (Opportunity Closed Won, CloseDate dans la plage) ---
export async function getRevenue({ start, end }) {
  const s = toSoqlDate(start);
  const e = toSoqlDate(end);
  const records = await query(
    `SELECT Id, Name, Amount, Owner.Name FROM Opportunity WHERE IsWon = true AND CloseDate >= ${s} AND CloseDate <= ${e}`
  );
  const detail = buildFullList(groupRecords(records, 'Amount'), true);
  const totalAmount = records.reduce((sum, r) => sum + (r.Amount || 0), 0);
  return { totalAmount, detail };
}

// --- Propals sur la période (Lead Status=Working, LastModifiedDate dans la plage) ---
export async function getPropals({ start, end }) {
  const s = toSoqlDateTime(start);
  const e = toSoqlDateTime(end);
  const records = await query(
    `SELECT Id, Name, Owner.Name FROM Lead WHERE Status = 'Working' AND LastModifiedDate >= ${s} AND LastModifiedDate <= ${e}`
  );
  const detail = buildFullList(groupRecords(records), false);
  const total = records.length;
  return { total, detail };
}

// ==========================================
//  PROPOSITIONS SUR COMPTES
//  Statut "Proposition envoyée" sur l'objet Account.
//  Le nom API du champ statut est auto-découvert
//  (ou forcé via SF_ACCOUNT_STATUS_FIELD).
// ==========================================

const PROPOSITION_VALUE = 'Proposition envoyée';
let cachedStatusField = null;

/** Trouve le champ picklist de Account qui contient la valeur "Proposition envoyée". */
async function getAccountStatusField() {
  if (process.env.SF_ACCOUNT_STATUS_FIELD) return process.env.SF_ACCOUNT_STATUS_FIELD;
  if (cachedStatusField) return cachedStatusField;

  const { accessToken, instanceUrl } = await getAuth();
  const res = await fetch(`${instanceUrl}/services/data/v59.0/sobjects/Account/describe`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce describe Account failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const field = (data.fields || []).find(
    (f) => f.type === 'picklist' &&
      (f.picklistValues || []).some((v) => (v.label === PROPOSITION_VALUE || v.value === PROPOSITION_VALUE))
  );
  if (!field) {
    throw new Error(
      `champ statut introuvable sur Account (aucune picklist avec la valeur "${PROPOSITION_VALUE}"). Forcer via SF_ACCOUNT_STATUS_FIELD si besoin.`
    );
  }
  cachedStatusField = field.name;
  console.log(`Salesforce: champ statut Account découvert → ${field.name}`);
  return cachedStatusField;
}

/**
 * Comptes au statut "Proposition envoyée" modifiés dans la plage,
 * groupés par propriétaire (même convention que les propals pistes).
 */
export async function getPropalsComptes({ start, end }) {
  const fieldName = await getAccountStatusField();
  const s = toSoqlDateTime(start);
  const e = toSoqlDateTime(end);
  const records = await query(
    `SELECT Id, Name, Owner.Name FROM Account WHERE ${fieldName} = '${PROPOSITION_VALUE.replace("'", "\\'")}' AND LastModifiedDate >= ${s} AND LastModifiedDate <= ${e}`
  );
  const detail = buildFullList(groupRecords(records), false);
  return { total: records.length, detail };
}
