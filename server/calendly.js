// ==========================================
//  CONNECTEUR CALENDLY
//  Auth via Personal Access Token (Bearer)
// ==========================================
import fetch from 'node-fetch';
import { matchSale, matchSaleStrict, buildFullList } from './roster.js';
import { createWideningCache } from './rawDataCache.js';

function authHeader() {
  return `Bearer ${process.env.CALENDLY_TOKEN || ''}`;
}
const ORG = () => process.env.CALENDLY_ORG_URI;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Requête Calendly avec retry automatique sur rate limit (429). */
async function fetchWithRetry(url, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 2000;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Calendly failed (${res.status}): ${text}`);
    }
    return res.json();
  }
  throw new Error('Calendly failed (429): rate limit dépassé après plusieurs tentatives');
}

/**
 * Pagine TOUS les scheduled events dont le START_TIME est dans [minStart, maxStart].
 * Pas de cache ici : la mise en cache (fenêtre élargissable + allègement des
 * records) est gérée par `eventsCache` ci-dessous.
 */
async function fetchEventsRaw(minStart, maxStart) {
  let url = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(ORG())}&status=active&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}&count=100`;
  let all = [];
  let safety = 0;
  while (url && safety < 150) {
    safety += 1;
    const data = await fetchWithRetry(url);
    all = all.concat(data.collection || []);
    url = data.pagination?.next_page || null;
  }
  return all;
}

// --- Cache des events BRUTS (fenêtre élargissable) ---------------------------
// Remplace l'ancien `scanCache` (dédup 60s, une entrée PAR fenêtre exacte
// demandée) par le même principe qu'Aircall : UNE seule fenêtre, allégée, qui
// s'élargit au fil des requêtes. Une sous-période déjà couverte ne rappelle
// jamais l'API — avant, ouvrir "ce mois" puis "cette semaine" relançait deux
// scans complets ; maintenant le 2e est un filtrage en mémoire.
//
// Garde-fou mémoire (cf. incident OOM déjà rencontré ici) : ce cache ne garde
// QUE les champs utiles (uri, name, hostRaw, createdAt), jamais l'objet brut
// Calendly complet — et une seule fenêtre existe à la fois (pas d'entrée par
// clé de plage qui grossirait indéfiniment).
//
// TTL court (5 min, comme le cache dashboard global) : un event peut être
// annulé après avoir été mis en cache (l'API ne renvoie que les events
// `status=active`), donc on ne garde pas cette fenêtre trop longtemps pour
// éviter d'afficher un RDV en fait annulé entre-temps.
function hostNameRaw(event) {
  return event.event_memberships?.[0]?.user_name || 'Inconnu';
}

const eventsCache = createWideningCache({
  ttlMs: parseInt(process.env.CALENDLY_CACHE_TTL_MS || '300000', 10),
  fetchWindow: (fromMs, toMs) => fetchEventsRaw(new Date(fromMs).toISOString(), new Date(toMs).toISOString()),
  mapRecord: (e) => ({
    at: e.start_time ? new Date(e.start_time).getTime() : 0,
    name: e.name || '',
    hostRaw: hostNameRaw(e),
    createdAt: e.created_at || null,
    uri: e.uri || null,
  }),
});

function isR2(record) {
  return (record.name || '').trim().toLowerCase().startsWith('retour');
}

/**
 * RDV À VENIR pour UN commercial (roster.js display name), du moment présent
 * jusqu'à `end`. Réutilise le même eventsCache que getRdvInRange/getRdvBookedInRange
 * (aucun nouvel appel Calendly dédié) — sert la vue perso "Ma semaine" du
 * commercial connecté (cf. server/index.js /api/mes-rdv-a-venir).
 */
export async function getUpcomingRdvForHost({ end, displayName }) {
  const now = Date.now();
  const records = await eventsCache.get(now, end.getTime());
  return records
    .filter((r) => matchSale(r.hostRaw) === displayName)
    .map((r) => ({ at: r.at, name: r.name, isR2: isR2(r) }))
    .sort((a, b) => a.at - b.at);
}
function groupByHost(records) {
  const map = new Map();
  for (const r of records) {
    const name = matchSaleStrict(r.hostRaw) || 'Inconnu';
    const entry = map.get(name) || { count: 0 };
    entry.count += 1;
    map.set(name, entry);
  }
  return buildFullList(map);
}

/**
 * R1/R2 "qui ONT LIEU" dans la plage (filtre sur start_time).
 */
export async function getRdvInRange({ start, end }) {
  const records = await eventsCache.get(start.getTime(), end.getTime());
  const r1 = records.filter((r) => !isR2(r));
  const r2 = records.filter((r) => isR2(r));
  return {
    r1: { total: r1.length, detail: groupByHost(r1) },
    r2: { total: r2.length, detail: groupByHost(r2) },
  };
}

/** Fenêtre de scan large utilisée par les fonctions "pris" (created_at) : voir getRdvBookedInRange. */
function scanWindowFor(start) {
  const scanStart = new Date(start);
  scanStart.setDate(scanStart.getDate() - 7);
  const scanEnd = new Date(start);
  scanEnd.setDate(scanEnd.getDate() + 365);
  return { scanStart, scanEnd };
}

function filterCreatedInRange(records, start, end) {
  return records.filter((r) => {
    if (!r.createdAt) return false;
    const c = new Date(r.createdAt);
    return c >= start && c <= end;
  });
}

/**
 * R1/R2 "PRIS" dans la plage (filtre sur created_at).
 * Calendly ne permet pas de filtrer directement sur created_at via l'API,
 * donc on récupère une large fenêtre d'events à venir + récents (via le cache
 * élargissable, donc sans redemander ce qui a déjà été vu), puis on filtre
 * côté code sur created_at dans la plage.
 *
 * Fenêtre de scan : events dont le start_time va de (start - 7j) à (start + 365j).
 * Ça couvre les RDV pris dans la plage qui ont lieu plus tard.
 */
export async function getRdvBookedInRange({ start, end }) {
  const { scanStart, scanEnd } = scanWindowFor(start);
  const records = await eventsCache.get(scanStart.getTime(), scanEnd.getTime());
  const createdInRange = filterCreatedInRange(records, start, end);

  const r1 = createdInRange.filter((r) => !isR2(r));
  const r2 = createdInRange.filter((r) => isR2(r));
  return {
    r1: { total: r1.length, detail: groupByHost(r1) },
    r2: { total: r2.length, detail: groupByHost(r2) },
  };
}

// ==========================================
//  TRACKING SALESFORGE (UTM via invitees)
// ==========================================

/**
 * Récupère l'utm_source de l'invitee d'un event (1 appel API par event).
 * Renvoie '' si erreur sur cet event (on ne fait pas planter tout le calcul).
 */
async function getInviteeUtmSource(record) {
  try {
    const data = await fetchWithRetry(`${record.uri}/invitees?count=1`);
    const invitee = data.collection?.[0];
    return (invitee?.tracking?.utm_source || '').toLowerCase().trim();
  } catch {
    return '';
  }
}

/**
 * RDV générés par SalesForge sur la période :
 * = events CRÉÉS dans la plage (created_at, comme "R1/R2 pris")
 *   dont l'invitee a utm_source = "salesforge".
 *
 * Coût : 1 appel invitee par event créé dans la plage.
 * On parallélise par paquets de 10 pour limiter le temps total,
 * avec retry automatique si Calendly rate-limite.
 */
export async function getSalesforgeRdv({ start, end }) {
  const { scanStart, scanEnd } = scanWindowFor(start);
  const records = await eventsCache.get(scanStart.getTime(), scanEnd.getTime());
  const createdInRange = filterCreatedInRange(records, start, end);

  // Garde-fou : au-delà de ~2500 RDV créés, le scan des invitees (1 appel/RDV)
  // prendrait plusieurs minutes et exploserait les quotas → on refuse proprement.
  if (createdInRange.length > 2500) {
    throw new Error(
      `période trop large pour le tracking SalesForge (${createdInRange.length} RDV à inspecter). Choisis une période de 3 mois max pour cette tuile.`
    );
  }

  // Invitees par paquets parallèles de 10
  const BATCH = 10;
  const salesforgeRecords = [];
  for (let i = 0; i < createdInRange.length; i += BATCH) {
    const batch = createdInRange.slice(i, i + BATCH);
    const sources = await Promise.all(batch.map(getInviteeUtmSource));
    sources.forEach((src, j) => {
      if (src === 'salesforge') salesforgeRecords.push(batch[j]);
    });
  }

  return { total: salesforgeRecords.length, detail: groupByHost(salesforgeRecords) };
}

// Managers dont on veut les RDV NL (noms exacts du roster)
const NL_MANAGERS = ['Lisa Neveu', 'Paul Jouannet', 'David CHEA', 'Quentin PUREN'];

/**
 * RDV générés par Newsletter sur la période :
 * = events CRÉÉS dans la plage (created_at) dont l'invitee a utm_source = "newsletter".
 * Retourné groupé par manager (Lisa, Paul, David, Quentin) uniquement.
 */
export async function getNewsletterRdv({ start, end }) {
  const { scanStart, scanEnd } = scanWindowFor(start);
  const records = await eventsCache.get(scanStart.getTime(), scanEnd.getTime());
  const createdInRange = filterCreatedInRange(records, start, end);

  if (createdInRange.length > 2500) {
    throw new Error(
      `Période trop large pour le tracking Newsletter (${createdInRange.length} RDV à inspecter).`
    );
  }

  // Récupère les utm_source par paquets de 10
  const BATCH = 10;
  const nlRecords = [];
  for (let i = 0; i < createdInRange.length; i += BATCH) {
    const batch = createdInRange.slice(i, i + BATCH);
    const sources = await Promise.all(batch.map(getInviteeUtmSource));
    sources.forEach((src, j) => {
      if (src === 'newsletter') nlRecords.push(batch[j]);
    });
  }

  // Grouper par manager (NL_MANAGERS uniquement)
  const counts = {};
  NL_MANAGERS.forEach((m) => { counts[m] = 0; });
  for (const r of nlRecords) {
    const name = matchSale(r.hostRaw);
    if (name && NL_MANAGERS.includes(name)) counts[name]++;
  }

  const detail = NL_MANAGERS.map((name) => ({ name, count: counts[name] || 0 }));
  const total = detail.reduce((s, r) => s + r.count, 0);
  return { total, detail };
}

/**
 * DEBUG : liste les noms d'hôtes BRUTS vus dans Calendly (events de la période,
 * sur start_time), avec volume et résultat du matching roster.
 */
export async function getRawHosts({ start, end }) {
  const records = await eventsCache.get(start.getTime(), end.getTime());
  const map = new Map();
  for (const r of records) {
    const raw = r.hostRaw || '(sans hôte)';
    map.set(raw, (map.get(raw) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count, matchedTo: matchSale(name) }))
    .sort((a, b) => b.count - a.count);
}

/** Diagnostic (route /api/admin/cache) : état du cache brut des events. */
export function getCacheStats() {
  return { events: eventsCache.stats() };
}
