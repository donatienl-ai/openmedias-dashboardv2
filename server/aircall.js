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

// --- Throttle GLOBAL Aircall -------------------------------------------------
// Aircall limite à ~60 req/min PAR CLÉ. Comme le cache peut déclencher plusieurs
// paginations en même temps (plusieurs périodes + comparatif), on fait passer
// TOUTES les requêtes Aircall par une file unique, espacées d'au moins
// MIN_INTERVAL_MS. Ainsi, quel que soit le nombre d'appelants simultanés, on ne
// dépasse jamais la limite. Réglable via AIRCALL_MIN_INTERVAL_MS.
const MIN_INTERVAL_MS = parseInt(process.env.AIRCALL_MIN_INTERVAL_MS || '1100', 10); // ~55 req/min
let chain = Promise.resolve();
let lastAt = 0;

function schedule(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastAt));
    if (wait) await sleep(wait);
    lastAt = Date.now();
    return fn();
  });
  // La file ne doit jamais se rompre, même si une requête échoue.
  chain = run.then(() => {}, () => {});
  return run;
}

/**
 * Fait une requête Aircall via la file throttlée, avec retry sur rate limit (429).
 * Backoff exponentiel + jitter, et respect du header Retry-After si présent.
 */
async function fetchWithRetry(url, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await schedule(() => fetch(url, { headers: { Authorization: authHeader() } }));

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
      const backoff = Math.min(30000, 1000 * 2 ** attempt); // 1s, 2s, 4s... plafonné à 30s
      const jitter = Math.floor(Math.random() * 500);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : backoff + jitter;
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

// Limites DURES de l'API Aircall (cf. doc) :
//  - per_page maximum = 50 (au-delà, le décalage de pagination se désynchronise
//    et on saute des appels) ;
//  - une requête ne peut JAMAIS renvoyer plus de 10 000 résultats : les pages
//    au-delà sont inaccessibles, page/per_page ne contournent pas la limite.
// → On pagine à 50, et on DÉCOUPE la plage en fenêtres assez courtes pour que
//   chacune reste sous 10 000 calls. Réglable via AIRCALL_CHUNK_DAYS.
const PER_PAGE = 50;
const MAX_PAGES_PER_WINDOW = 200; // 200 × 50 = 10 000 (limite dure par requête)
const CHUNK_DAYS = parseInt(process.env.AIRCALL_CHUNK_DAYS || '7', 10);

// Pagine UNE fenêtre [from, to] (censée contenir < 10 000 calls).
async function fetchWindow(from, to) {
  let page = 1;
  let calls = [];
  let hasMore = true;
  let hitCap = false;
  while (hasMore) {
    if (page > MAX_PAGES_PER_WINDOW) {
      hitCap = true; // cette fenêtre dépasse 10k → il faudrait la découper plus fin
      break;
    }
    const url = `https://api.aircall.io/v1/calls?from=${from}&to=${to}&per_page=${PER_PAGE}&page=${page}`;
    const data = await fetchWithRetry(url);
    const batch = data.calls || [];
    calls = calls.concat(batch);
    hasMore = Boolean(data.meta?.next_page_link) && batch.length > 0;
    page += 1;
  }
  return { calls, hitCap };
}

/**
 * Pagine TOUS les calls bruts d'Aircall sur [from, to] (Unix) en découpant en
 * fenêtres de CHUNK_DAYS jours, pour contourner la limite de 10 000 résultats
 * par requête. `truncated` = vrai si une fenêtre a malgré tout dépassé 10k.
 */
async function fetchAllCallsRaw(from, to) {
  let allCalls = [];
  let truncated = false;
  const step = CHUNK_DAYS * 86400;
  for (let winStart = from; winStart <= to; winStart += step) {
    const winEnd = Math.min(winStart + step - 1, to);
    const { calls, hitCap } = await fetchWindow(winStart, winEnd);
    allCalls = allCalls.concat(calls);
    if (hitCap) truncated = true;
  }
  return { allCalls, truncated };
}

// --- Cache des calls BRUTS ---------------------------------------------------
// On garde en mémoire les calls bruts (version allégée) sur la fenêtre la plus
// large déjà demandée. Toute sous-période est alors obtenue par simple FILTRAGE,
// sans rappeler Aircall. Charger « depuis le 1er janvier » puis « le mois
// précédent » ne refait donc aucun appel : la 2e période est dérivée du cache.
// Réglable via AIRCALL_CACHE_TTL_MS. C'est le délai au-delà duquel on referait
// une récupération COMPLÈTE. Comme la fraîcheur est assurée par refreshRecent
// (queue récente), on peut le garder long (30 min) : ça évite que le cache ne
// rétrécisse entre deux cycles.
const CALLS_TTL_MS = parseInt(process.env.AIRCALL_CACHE_TTL_MS || '1800000', 10); // 30 min
let callsCache = { from: 0, to: 0, fetchedAt: 0, calls: [], truncated: false };

function cacheIsFresh() {
  return callsCache.fetchedAt > 0 && Date.now() - callsCache.fetchedAt < CALLS_TTL_MS;
}

function cacheCovers(from, to) {
  return cacheIsFresh() && from >= callsCache.from && to <= callsCache.to;
}

// Single-flight : une seule récupération Aircall à la fois (l'amorçage au
// lancement et une requête utilisateur simultanée ne fetchent pas en double).
let inflight = null;

// Garantit que le cache couvre [from, to] (sinon récupère la fenêtre élargie).
async function ensureCalls(from, to) {
  if (cacheCovers(from, to)) return;
  if (inflight) {
    await inflight.catch(() => {});
    if (cacheCovers(from, to)) return; // une autre récupération a peut-être déjà couvert
  }
  // Tant que le cache est frais, on ne le rétrécit pas : on élargit la fenêtre
  // pour englober ce qui était déjà récupéré + la nouvelle demande.
  const winFrom = cacheIsFresh() ? Math.min(from, callsCache.from) : from;
  const winTo = cacheIsFresh() ? Math.max(to, callsCache.to) : to;
  inflight = (async () => {
    const { allCalls, truncated } = await fetchAllCallsRaw(winFrom, winTo);
    callsCache = {
      from: winFrom,
      to: winTo,
      fetchedAt: Date.now(),
      truncated,
      // On ne stocke que le strict nécessaire (date, sens, commercial).
      calls: allCalls.map((c) => ({
        at: c.started_at || 0,
        inbound: c.direction === 'inbound',
        user: c.user?.name || null,
      })),
    };
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

function selectCalls(from, to) {
  return callsCache.calls.filter((c) => c.at >= from && c.at <= to);
}

/**
 * AMORÇAGE (lancement) : précharge les calls bruts sur une large fenêtre
 * (typiquement depuis le début du trimestre précédent jusqu'à maintenant).
 * Toute période incluse sera ensuite servie sans rappeler Aircall.
 */
export async function prewarmCalls({ start, end }) {
  await ensureCalls(toUnix(start), toUnix(end));
  return { from: callsCache.from, to: callsCache.to, count: callsCache.calls.length, truncated: callsCache.truncated };
}

/**
 * RAFRAÎCHISSEMENT INCRÉMENTAL : ne re-récupère que la queue récente [since, now]
 * et la fusionne dans le cache. L'historique (calls < since), immuable, est
 * conservé tel quel → on garde la couverture large sans tout repaginer.
 */
export async function refreshRecent(since) {
  const sinceU = toUnix(since);
  const nowU = Math.floor(Date.now() / 1000);
  // Si le cache ne remonte pas jusqu'à `since`, on amorce simplement la fenêtre.
  if (!callsCache.fetchedAt || callsCache.from > sinceU) {
    await ensureCalls(sinceU, nowU);
    return;
  }
  const { allCalls, truncated } = await fetchAllCallsRaw(sinceU, nowU);
  const fresh = allCalls.map((c) => ({
    at: c.started_at || 0,
    inbound: c.direction === 'inbound',
    user: c.user?.name || null,
  }));
  const kept = callsCache.calls.filter((c) => c.at < sinceU); // historique immuable conservé
  callsCache = {
    from: callsCache.from,
    to: Math.max(callsCache.to, nowU),
    fetchedAt: Date.now(),
    truncated: callsCache.truncated || truncated,
    calls: kept.concat(fresh),
  };
}

export async function getCalls({ start, end }) {
  const from = toUnix(start);
  const to = toUnix(end);
  await ensureCalls(from, to);
  const calls = selectCalls(from, to);

  const map = new Map();
  let totalInbound = 0;
  let totalOutbound = 0;
  for (const c of calls) {
    if (c.inbound) totalInbound += 1; else totalOutbound += 1;
    const name = matchSale(c.user) || 'Inconnu';
    const e = map.get(name) || { count: 0, inbound: 0, outbound: 0 };
    e.count += 1;
    if (c.inbound) e.inbound += 1; else e.outbound += 1;
    map.set(name, e);
  }
  const detail = buildFullList(map);
  // `truncated` reflète le plafond 50k sur la fenêtre récupérée.
  return { total: calls.length, totalInbound, totalOutbound, detail, truncated: callsCache.truncated };
}

/**
 * DEBUG : liste les noms d'utilisateurs BRUTS vus dans Aircall sur la période,
 * avec volume et résultat du matching roster. Sert à diagnostiquer les écarts.
 */
export async function getRawUsers({ start, end }) {
  const from = toUnix(start);
  const to = toUnix(end);
  await ensureCalls(from, to);
  const map = new Map();
  for (const c of selectCalls(from, to)) {
    const raw = c.user || '(sans utilisateur)';
    map.set(raw, (map.get(raw) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count, matchedTo: matchSale(name) }))
    .sort((a, b) => b.count - a.count);
}
