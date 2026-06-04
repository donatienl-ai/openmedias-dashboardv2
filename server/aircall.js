// ==========================================
//  CONNECTEUR AIRCALL
//  Auth via Basic (API ID : API Token)
//  Pagination robuste : 100/page, retry sur rate limit, plafond 50k
// ==========================================
import fetch from 'node-fetch';
import { matchSale, buildFullList } from './roster.js';
import { toUnix } from './dateRange.js';

function authHeader() {
  const id = process.env.AIRCALL_API_ID || '';
  const token = process.env.AIRCALL_API_TOKEN || '';
  return `Basic ${Buffer.from(`${id}:${token}`).toString('base64')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fait une requête Aircall avec retry automatique sur rate limit (429).
 * Aircall limite à ~60 req/min ; en cas de 429 on attend et on réessaie.
 */
async function fetchWithRetry(url, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers: { Authorization: authHeader() } });

    if (res.status === 429) {
      // Rate limited : on lit le header Retry-After si présent, sinon backoff progressif
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 2000;
      await sleep(waitMs);
      continue; // réessaie
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Aircall failed (${res.status}): ${text}`);
    }
    return res.json();
  }
  throw new Error('Aircall failed: rate limit dépassé après plusieurs tentatives');
}

/**
 * Récupère TOUS les calls (entrants + sortants) sur la période, paginés.
 * - 100 calls par page (max Aircall) → 2x moins de requêtes
 * - Retry auto sur rate limit
 * - Plafond de sécurité à 50 000 calls (500 pages)
 */
export async function getCalls({ start, end }) {
  const from = toUnix(start);
  const to = toUnix(end);
  let page = 1;
  const perPage = 100; // max autorisé par Aircall
  const MAX_PAGES = 500; // 500 × 100 = 50 000 calls
  let allCalls = [];
  let hasMore = true;
  let truncated = false;

  while (hasMore) {
    if (page > MAX_PAGES) {
      truncated = true; // on a atteint le plafond de 50k
      break;
    }
    const url = `https://api.aircall.io/v1/calls?from=${from}&to=${to}&per_page=${perPage}&page=${page}`;
    const data = await fetchWithRetry(url);
    const calls = data.calls || [];
    allCalls = allCalls.concat(calls);
    hasMore = Boolean(data.meta?.next_page_link);
    page += 1;
  }

  const map = new Map();
  let totalInbound = 0;
  let totalOutbound = 0;
  for (const c of allCalls) {
    const isInbound = c.direction === 'inbound';
    if (isInbound) totalInbound += 1; else totalOutbound += 1;
    const name = matchSale(c.user?.name) || 'Inconnu';
    const e = map.get(name) || { count: 0, inbound: 0, outbound: 0 };
    e.count += 1;
    if (isInbound) e.inbound += 1; else e.outbound += 1;
    map.set(name, e);
  }
  const detail = buildFullList(map);
  // `truncated` permet au front d'afficher un indicateur si le total est plafonné
  return { total: allCalls.length, totalInbound, totalOutbound, detail, truncated };
}
