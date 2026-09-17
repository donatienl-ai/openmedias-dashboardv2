// ==========================================
//  CONNECTEUR DOCUSIGN
//  Auth via JWT Grant (RSA), impersonation
//  → BDC envoyés / signés par commercial
// ==========================================
import fetch from 'node-fetch';
import crypto from 'crypto';
import { matchSaleStrict, buildFullList } from './roster.js';
import { createWideningCache } from './rawDataCache.js';

// Hôte OAuth : account.docusign.com (prod) / account-d.docusign.com (demo)
const OAUTH_HOST = () => process.env.DOCUSIGN_OAUTH_HOST || 'account.docusign.com';

let cached = null;
let cachedExpiry = 0;

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Construit et signe le JWT (RS256) avec la clé privée RSA de l'app. */
function makeJwt() {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.DOCUSIGN_INTEGRATION_KEY,
    sub: process.env.DOCUSIGN_USER_ID,
    aud: OAUTH_HOST(),
    iat: now,
    exp: now + 3500,
    scope: 'signature impersonation',
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  // La clé peut être collée avec des \n littéraux dans Render → on les restaure
  let key = process.env.DOCUSIGN_PRIVATE_KEY || '';
  key = key.replace(/\\n/g, '\n');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer
    .sign(key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${unsigned}.${signature}`;
}

/**
 * Authentifie via JWT Grant, puis découvre le compte (base_uri + account_id)
 * via /oauth/userinfo. Cache 50 min.
 */
async function getAuth(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cached && now < cachedExpiry) return cached;

  const jwt = makeJwt();
  const res = await fetch(`https://${OAUTH_HOST()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    if (data.error === 'consent_required') {
      throw new Error(
        "DocuSign: consentement requis. Ouvre l'URL de consentement (voir README) une fois en tant qu'admin."
      );
    }
    throw new Error(`DocuSign auth failed: ${JSON.stringify(data)}`);
  }

  // Découverte du compte : base_uri + account_id
  const uiRes = await fetch(`https://${OAUTH_HOST()}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!uiRes.ok) {
    throw new Error(`DocuSign userinfo failed (${uiRes.status})`);
  }
  const ui = await uiRes.json();
  const wanted = process.env.DOCUSIGN_ACCOUNT_ID;
  const acct =
    (ui.accounts || []).find((a) => (wanted ? a.account_id === wanted : a.is_default)) ||
    (ui.accounts || [])[0];
  if (!acct) throw new Error('DocuSign: aucun compte trouvé pour cet utilisateur');

  cached = {
    token: data.access_token,
    baseUri: acct.base_uri,
    accountId: acct.account_id,
  };
  cachedExpiry = now + 50 * 60 * 1000; // 50 min
  return cached;
}

/**
 * Liste les enveloppes dont le statut est passé à `fromToStatus`
 * (sent | completed) dans la plage.
 * Pagination MANUELLE via start_position (le format de nextUri varie selon
 * les comptes et provoquait des 404 sur les grosses périodes).
 *
 * Retry (point qui manquait totalement avant) :
 *  - 401 → ré-authentifie une fois puis retente la même page.
 *  - 429 / 5xx → backoff exponentiel (respecte Retry-After si présent),
 *    jusqu'à 5 tentatives — DocuSign applique un rate limit par burst
 *    (contrairement au quota journalier Salesforce), donc retenter a du sens ici.
 */
async function listEnvelopesRaw({ start, end }, fromToStatus) {
  let { token, baseUri, accountId } = await getAuth();
  const base =
    `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes` +
    `?from_date=${encodeURIComponent(start.toISOString())}` +
    `&to_date=${encodeURIComponent(end.toISOString())}` +
    `&from_to_status=${fromToStatus}&count=100`;

  let all = [];
  let startPos = 0;
  let pageSafety = 0;

  while (pageSafety < 100) {
    pageSafety += 1;
    let attempt = 0;
    let res;
    for (;;) {
      res = await fetch(`${base}&start_position=${startPos}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 && attempt === 0) {
        attempt += 1;
        ({ token, baseUri, accountId } = await getAuth(true));
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        attempt += 1;
        const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
        const backoff = Math.min(30000, 500 * 2 ** attempt);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff);
        continue;
      }
      break;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DocuSign envelopes failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const batch = data.envelopes || [];
    all = all.concat(batch);

    const total = parseInt(data.totalSetSize || '0', 10);
    const endPos = parseInt(data.endPosition || '0', 10);
    if (batch.length === 0 || endPos + 1 >= total) break;
    startPos = endPos + 1;
  }
  return all;
}

/** Groupe des records par expéditeur (matché au roster) → liste complète. */
function groupBySender(records) {
  const map = new Map();
  for (const r of records) {
    const name = matchSaleStrict(r.senderRaw) || 'Inconnu';
    const entry = map.get(name) || { count: 0 };
    entry.count += 1;
    map.set(name, entry);
  }
  return buildFullList(map);
}

// --- Caches BRUTS (fenêtre élargissable, voir server/rawDataCache.js) --------
// Corrige le point relevé : contrairement à Aircall, DocuSign n'avait aucun
// cache — chaque plage "custom" retapait l'API en direct.
//
// TTL volontairement COURT (5 min par défaut, comme les statuts mutables
// côté Salesforce) : le champ `status` d'une enveloppe "sent" change dans le
// temps (sent → delivered → completed), et sert à calculer les BDC "en
// attente". Une fenêtre gardée trop longtemps afficherait un BDC comme encore
// en attente alors qu'il vient d'être signé. Réglable via
// DOCUSIGN_CACHE_TTL_MS si besoin d'un compromis différent.
const DOCUSIGN_CACHE_TTL_MS = parseInt(process.env.DOCUSIGN_CACHE_TTL_MS || '300000', 10);

function mapEnvelope(dateField) {
  return (e) => ({
    at: e[dateField] ? new Date(e[dateField]).getTime() : (e.statusChangedDateTime ? new Date(e.statusChangedDateTime).getTime() : 0),
    senderRaw: e.sender?.userName || null,
    status: String(e.status || '').toLowerCase(),
  });
}

const sentEnvelopesCache = createWideningCache({
  ttlMs: DOCUSIGN_CACHE_TTL_MS,
  fetchWindow: (fromMs, toMs) => listEnvelopesRaw({ start: new Date(fromMs), end: new Date(toMs) }, 'sent'),
  mapRecord: mapEnvelope('sentDateTime'),
});

const completedEnvelopesCache = createWideningCache({
  ttlMs: DOCUSIGN_CACHE_TTL_MS,
  fetchWindow: (fromMs, toMs) => listEnvelopesRaw({ start: new Date(fromMs), end: new Date(toMs) }, 'completed'),
  mapRecord: mapEnvelope('completedDateTime'),
});

/**
 * BDC envoyés + signés + en attente sur la période.
 * - envoyés    : enveloppes passées au statut "sent" dans la plage
 * - signés     : enveloppes passées au statut "completed" dans la plage
 * - en attente : parmi les envoyés de la plage, celles dont le statut ACTUEL
 *                est encore sent/delivered (= pipeline de relance)
 */
export async function getBdc({ start, end }) {
  const [sentRecords, completedRecords] = await Promise.all([
    sentEnvelopesCache.get(start.getTime(), end.getTime()),
    completedEnvelopesCache.get(start.getTime(), end.getTime()),
  ]);
  const pendingRecords = sentRecords.filter((r) => ['sent', 'delivered'].includes(r.status));
  return {
    sent: { total: sentRecords.length, detail: groupBySender(sentRecords) },
    signed: { total: completedRecords.length, detail: groupBySender(completedRecords) },
    pending: { total: pendingRecords.length, detail: groupBySender(pendingRecords) },
  };
}

/** Diagnostic (route /api/admin/cache) : état des 2 caches bruts DocuSign. */
export function getCacheStats() {
  return { sent: sentEnvelopesCache.stats(), completed: completedEnvelopesCache.stats() };
}
