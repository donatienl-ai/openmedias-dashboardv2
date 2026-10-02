// ==========================================
//  CONNECTEUR AIRCALL
//  Auth via Basic (API ID : API Token)
//  Pagination robuste : 100/page, retry sur rate limit, plafond 50k
// ==========================================
import fetch from 'node-fetch';
import { matchSale, matchSaleStrict, buildFullList } from './roster.js';
import { toUnix } from './dateRange.js';

function authHeader() {
  const id = process.env.AIRCALL_API_ID || '';
  const token = process.env.AIRCALL_API_TOKEN || '';
  return `Basic ${Buffer.from(`${id}:${token}`).toString('base64')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Throttle GLOBAL Aircall avec PRIORITÉS ---------------------------------
// Aircall limite à ~60 req/min par clé. On fait passer TOUTES les requêtes par
// une file unique espacée de MIN_INTERVAL_MS, MAIS avec deux niveaux :
//  - 'high' : requêtes déclenchées par l'utilisateur (ouverture du dashboard)
//  - 'low'  : préchauffage / rafraîchissement périodique en arrière-plan
// La file 'high' est servie en priorité : les requêtes utilisateur passent
// devant les centaines de requêtes du préchauffage. Le dashboard reste donc
// utilisable pendant l'amorçage initial (qui peut prendre plusieurs minutes
// pour une grosse fenêtre).
const MIN_INTERVAL_MS = parseInt(process.env.AIRCALL_MIN_INTERVAL_MS || '1100', 10);
const queues = { high: [], low: [] };
let lastAt = 0;
let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queues.high.length || queues.low.length) {
      const item = queues.high.shift() || queues.low.shift();
      const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastAt));
      if (wait) await sleep(wait);
      lastAt = Date.now();
      try { item.resolve(await item.fn()); } catch (e) { item.reject(e); }
    }
  } finally { pumping = false; }
}

function schedule(fn, priority = 'high') {
  return new Promise((resolve, reject) => {
    queues[priority === 'low' ? 'low' : 'high'].push({ fn, resolve, reject });
    pump();
  });
}

/**
 * Fait une requête Aircall via la file throttlée, avec retry sur rate limit (429).
 * Backoff exponentiel + jitter, et respect du header Retry-After si présent.
 */
async function fetchWithRetry(url, maxRetries = 6, priority = 'high') {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await schedule(() => fetch(url, { headers: { Authorization: authHeader() } }), priority);

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
async function fetchWindow(from, to, priority = 'high') {
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
    const data = await fetchWithRetry(url, 6, priority);
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
 * `priority` : 'high' (utilisateur) ou 'low' (préchauffage de fond).
 */
async function fetchAllCallsRaw(from, to, priority = 'high') {
  let allCalls = [];
  let truncated = false;
  const step = CHUNK_DAYS * 86400;
  for (let winStart = from; winStart <= to; winStart += step) {
    const winEnd = Math.min(winStart + step - 1, to);
    const { calls, hitCap } = await fetchWindow(winStart, winEnd, priority);
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

// Dédoublonnage PAR FENÊTRE : deux appels simultanés sur exactement la même
// fenêtre ne déclenchent qu'un fetch. Mais une requête utilisateur sur
// 'today' ne BLOQUE PAS sur un préchauffage trimestriel en cours — elle lance
// son propre fetch (court) en priorité haute et se voit servie en quelques
// secondes pendant que le préchauffage continue en fond.
const inflightByKey = new Map();

// Garantit que le cache couvre [from, to]. `priority` : 'high' pour l'utilisateur,
// 'low' pour le préchauffage / rafraîchissement de fond.
async function ensureCalls(from, to, priority = 'high') {
  if (cacheCovers(from, to)) return;
  // Élargissement de la fenêtre tant que le cache est frais (on ne rétrécit pas).
  const winFrom = cacheIsFresh() ? Math.min(from, callsCache.from) : from;
  const winTo = cacheIsFresh() ? Math.max(to, callsCache.to) : to;
  const key = `${winFrom}|${winTo}`;
  if (inflightByKey.has(key)) {
    await inflightByKey.get(key).catch(() => {});
    return;
  }
  const promise = (async () => {
    const { allCalls, truncated } = await fetchAllCallsRaw(winFrom, winTo, priority);
    const fresh = allCalls.map((c) => ({
      at: c.started_at || 0,
      inbound: c.direction === 'inbound',
      user: c.user?.name || null,
      // Ligne Aircall (numéro personnel du commercial) : sert à attribuer les
      // appels sans utilisateur (message vocal, entrant manqué ou abandonné).
      line: c.number?.name || null,
    }));
    // Fusion sans rétrécir : si un autre fetch a déjà acquis une couverture plus
    // large pendant que celui-ci tournait, on conserve la fenêtre la plus large
    // et on remplace seulement les calls compris dans [winFrom, winTo].
    const existingFresh = cacheIsFresh();
    const newFrom = existingFresh ? Math.min(winFrom, callsCache.from) : winFrom;
    const newTo = existingFresh ? Math.max(winTo, callsCache.to) : winTo;
    const kept = existingFresh
      ? callsCache.calls.filter((c) => c.at < winFrom || c.at > winTo)
      : [];
    callsCache = {
      from: newFrom,
      to: newTo,
      fetchedAt: Date.now(),
      truncated: (existingFresh ? callsCache.truncated : false) || truncated,
      calls: kept.concat(fresh),
    };
  })().finally(() => inflightByKey.delete(key));
  inflightByKey.set(key, promise);
  await promise;
}

function selectCalls(from, to) {
  return callsCache.calls.filter((c) => c.at >= from && c.at <= to);
}

/** Diagnostic (route /api/admin/cache) : état du cache brut des calls. */
export function getCacheStats() {
  return {
    calls: {
      from: callsCache.from || null,
      to: callsCache.to || null,
      count: callsCache.calls.length,
      truncated: callsCache.truncated,
      ageMs: callsCache.fetchedAt ? Date.now() - callsCache.fetchedAt : null,
      fresh: cacheIsFresh(),
    },
  };
}

/**
 * AMORÇAGE (lancement) : précharge les calls bruts sur une large fenêtre
 * (typiquement depuis le début du trimestre précédent jusqu'à maintenant).
 * Toute période incluse sera ensuite servie sans rappeler Aircall.
 * Priorité BASSE : ne bloque pas les requêtes utilisateur.
 */
export async function prewarmCalls({ start, end }) {
  await ensureCalls(toUnix(start), toUnix(end), 'low');
  return { from: callsCache.from, to: callsCache.to, count: callsCache.calls.length, truncated: callsCache.truncated };
}

/**
 * RAFRAÎCHISSEMENT INCRÉMENTAL : ne re-récupère que la queue récente [since, now]
 * et la fusionne dans le cache. L'historique (calls < since), immuable, est
 * conservé tel quel → on garde la couverture large sans tout repaginer.
 * Priorité BASSE également.
 */
export async function refreshRecent(since) {
  const sinceU = toUnix(since);
  const nowU = Math.floor(Date.now() / 1000);
  // Si le cache ne remonte pas jusqu'à `since`, on amorce simplement la fenêtre.
  if (!callsCache.fetchedAt || callsCache.from > sinceU) {
    await ensureCalls(sinceU, nowU, 'low');
    return;
  }
  const { allCalls, truncated } = await fetchAllCallsRaw(sinceU, nowU, 'low');
  const fresh = allCalls.map((c) => ({
    at: c.started_at || 0,
    inbound: c.direction === 'inbound',
    user: c.user?.name || null,
      // Ligne Aircall (numéro personnel du commercial) : sert à attribuer les
      // appels sans utilisateur (message vocal, entrant manqué ou abandonné).
      line: c.number?.name || null,
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

// Attribution d'un appel à un commercial (correctif 02/10/2026, demande Lina).
// Avant : un appel dont l'utilisateur Aircall n'était pas reconnu comme
// commercial du dashboard (compte hors équipe commerciale, nom écrit
// autrement, homonyme) était compté à Quentin (règle « Inconnu → Quentin » de
// nameMatching.js), ce qui gonflait ses appels. Désormais ces appels vont dans
// une ligne à part, « Autres utilisateurs Aircall », qui liste les noms
// Aircall concernés : on voit tout de suite à qui ils appartiennent. Elle
// n'entre ni dans le podium ni dans le graphique par commercial, et un compte
// commercial ne la voit jamais (scoping par nom).
export const OTHER_AIRCALL_USERS = 'Autres utilisateurs Aircall';
const normName = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function attributeCall(rawUser) {
  const raw = normName(rawUser);
  if (!raw || ['inconnu', 'unknown', 'unassigned'].includes(raw)) return null;
  // Nom vide ou « inconnu » écarté ci-dessus : c'est le seul cas où
  // resolveSaleName rattachait par défaut à Quentin. Les alias restent gérés.
  return matchSaleStrict(rawUser) || null;
}

export async function getCalls({ start, end }) {
  const from = toUnix(start);
  const to = toUnix(end);
  await ensureCalls(from, to);
  // Seuls les appels passés ou décrochés par un commercial du dashboard sont
  // comptés (décision Lina du 02/10/2026). Sont exclus :
  //  - les appels sans utilisateur Aircall (message vocal, entrant non
  //    répondu, abandonné ou hors horaires sur une ligne personnelle) : ils
  //    étaient auparavant comptés à Quentin par défaut ;
  //  - les appels d'un utilisateur Aircall qui n'est pas commercial du
  //    dashboard (admins, autres services).
  // Le total « Calls » est donc la somme des appels des commerciaux.
  const calls = selectCalls(from, to);

  const map = new Map();
  let totalInbound = 0;
  let totalOutbound = 0;
  let counted = 0;
  for (const c of calls) {
    const name = attributeCall(c.user);
    if (!name) continue;
    counted += 1;
    if (c.inbound) totalInbound += 1; else totalOutbound += 1;
    const e = map.get(name) || { count: 0, inbound: 0, outbound: 0 };
    e.count += 1;
    if (c.inbound) e.inbound += 1; else e.outbound += 1;
    map.set(name, e);
  }
  const detail = buildFullList(map);
  // `truncated` reflète le plafond 50k sur la fenêtre récupérée.
  return { total: counted, totalInbound, totalOutbound, detail, truncated: callsCache.truncated };
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
