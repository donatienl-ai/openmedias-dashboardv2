// ==========================================
//  CONNECTEUR SALESFORCE
//  Auth via OAuth Client Credentials Flow
// ==========================================
import fetch from 'node-fetch';
import { matchSale, buildFullList } from './roster.js';
import { toSoqlDate, toSoqlDateTime } from './dateRange.js';
import { createWideningCache } from './rawDataCache.js';

let cachedAuth = null;
let cachedAuthExpiry = 0;

async function getAuth(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedAuth && now < cachedAuthExpiry) return cachedAuth;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exécute une requête SOQL avec pagination complète (nextRecordsUrl - une
 * requête peut renvoyer plus de 2000 lignes sur une grande plage, l'ancien
 * code s'arrêtait silencieusement à la 1ère page) et retry :
 *  - 401 (session/token expiré) → ré-authentifie une fois puis retente.
 *  - 5xx / erreur réseau → backoff exponentiel (jusqu'à 3 tentatives).
 * Les 403 REQUEST_LIMIT_EXCEEDED (quota API JOURNALIER, pas un débit court
 * terme) ne sont volontairement PAS retentés en boucle : l'erreur remonte
 * telle quelle, réessayer immédiatement n'y changerait rien.
 */
async function queryAll(soql) {
  let { accessToken, instanceUrl } = await getAuth();
  let path = `/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  const all = [];
  let attempt = 0;

  while (path) {
    const res = await fetch(`${instanceUrl}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 401 && attempt === 0) {
      attempt += 1;
      ({ accessToken, instanceUrl } = await getAuth(true));
      continue; // retente la même page avec un token frais
    }
    if (res.status >= 500 && attempt < 3) {
      attempt += 1;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Salesforce query failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    all.push(...(data.records || []));
    path = data.nextRecordsUrl || null;
    attempt = 0; // budget de retry réinitialisé pour la page suivante
  }
  return all;
}

function groupByOwner(records, withAmount) {
  const map = new Map();
  for (const r of records) {
    const owner = matchSale(r.owner) || 'Inconnu';
    const entry = map.get(owner) || { count: 0, amount: 0 };
    entry.count += 1;
    if (withAmount) entry.amount += r.amount || 0;
    map.set(owner, entry);
  }
  return map;
}

function onlyActive(map, withAmount) {
  return Array.from(map.entries())
    .map(([name, e]) => (withAmount ? { name, count: e.count, amount: e.amount } : { name, count: e.count }))
    .sort((a, b) => (withAmount ? b.amount - a.amount : b.count - a.count));
}

// ==========================================
//  CACHES BRUTS (fenêtre élargissable, voir server/rawDataCache.js)
//  Corrige le point relevé : contrairement à Aircall, Salesforce n'avait
//  aucun cache — chaque plage "custom" retapait le SOQL en direct.
//
//  IMPORTANT sur le choix des TTL :
//  - Opportunity IsWon=true (Closed Won) : fait IMMUABLE une fois écrit
//    (un deal gagné ne redevient pas "non gagné" sur cette période) → TTL
//    long (30 min), comme le cache Aircall.
//  - Lead.Status='Working' / Account "Proposition envoyée" : reflète un
//    STATUT COURANT mutable (un lead peut sortir de "Working" entre deux
//    chargements) → TTL court (5 min, aligné sur le cache dashboard global)
//    pour ne jamais afficher un statut visiblement périmé.
// ==========================================

const wonOppsCache = createWideningCache({
  ttlMs: 30 * 60 * 1000,
  fetchWindow: async (fromMs, toMs) => {
    const s = toSoqlDate(new Date(fromMs));
    const e = toSoqlDate(new Date(toMs));
    return queryAll(
      `SELECT Id, Name, Amount, CloseDate, Owner.Name FROM Opportunity WHERE IsWon = true AND CloseDate >= ${s} AND CloseDate <= ${e}`
    );
  },
  mapRecord: (r) => ({ at: new Date(r.CloseDate).getTime(), amount: r.Amount || 0, owner: r.Owner?.Name || null }),
});

const workingLeadsCache = createWideningCache({
  ttlMs: parseInt(process.env.SF_STATUS_CACHE_TTL_MS || '300000', 10), // 5 min par défaut
  fetchWindow: async (fromMs, toMs) => {
    const s = toSoqlDateTime(new Date(fromMs));
    const e = toSoqlDateTime(new Date(toMs));
    return queryAll(
      `SELECT Id, Name, Owner.Name, LastModifiedDate FROM Lead WHERE Status = 'Working' AND LastModifiedDate >= ${s} AND LastModifiedDate <= ${e}`
    );
  },
  mapRecord: (r) => ({ at: new Date(r.LastModifiedDate).getTime(), owner: r.Owner?.Name || null }),
});

// --- Signatures sur la période (Opportunity Closed Won, CloseDate dans la plage) ---
export async function getSignatures({ start, end }) {
  const records = await wonOppsCache.get(start.getTime(), end.getTime());
  const detail = onlyActive(groupByOwner(records, true), true);
  const total = records.length;
  const totalAmount = records.reduce((sum, r) => sum + (r.amount || 0), 0);
  return { total, totalAmount, detail };
}

// --- CA sur la période (Opportunity Closed Won, CloseDate dans la plage) ---
export async function getRevenue({ start, end }) {
  const records = await wonOppsCache.get(start.getTime(), end.getTime());
  const detail = buildFullList(groupByOwner(records, true), true);
  const totalAmount = records.reduce((sum, r) => sum + (r.amount || 0), 0);
  return { totalAmount, detail };
}

// --- Propals sur la période (Lead Status=Working, LastModifiedDate dans la plage) ---
export async function getPropals({ start, end }) {
  const records = await workingLeadsCache.get(start.getTime(), end.getTime());
  const detail = buildFullList(groupByOwner(records, false), false);
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

// Créé après coup (dépend du nom de champ auto-découvert), une seule fois.
let accountsPropalCache = null;
function getAccountsPropalCache(fieldName) {
  if (accountsPropalCache) return accountsPropalCache;
  accountsPropalCache = createWideningCache({
    ttlMs: parseInt(process.env.SF_STATUS_CACHE_TTL_MS || '300000', 10), // 5 min par défaut
    fetchWindow: async (fromMs, toMs) => {
      const s = toSoqlDateTime(new Date(fromMs));
      const e = toSoqlDateTime(new Date(toMs));
      return queryAll(
        `SELECT Id, Name, Owner.Name, LastModifiedDate FROM Account WHERE ${fieldName} = '${PROPOSITION_VALUE.replace("'", "\\'")}' AND LastModifiedDate >= ${s} AND LastModifiedDate <= ${e}`
      );
    },
    mapRecord: (r) => ({ at: new Date(r.LastModifiedDate).getTime(), owner: r.Owner?.Name || null }),
  });
  return accountsPropalCache;
}

/**
 * Comptes au statut "Proposition envoyée" modifiés dans la plage,
 * groupés par propriétaire (même convention que les propals pistes).
 */
export async function getPropalsComptes({ start, end }) {
  const fieldName = await getAccountStatusField();
  const records = await getAccountsPropalCache(fieldName).get(start.getTime(), end.getTime());
  const detail = buildFullList(groupByOwner(records, false), false);
  return { total: records.length, detail };
}

/** Diagnostic (route /api/admin/cache) : état des 3 caches bruts Salesforce. */
export function getCacheStats() {
  return {
    wonOpportunities: wonOppsCache.stats(),
    workingLeads: workingLeadsCache.stats(),
    accountsPropal: accountsPropalCache ? accountsPropalCache.stats() : null,
  };
}
