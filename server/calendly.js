// ==========================================
//  CONNECTEUR CALENDLY
//  Auth via Personal Access Token (Bearer)
// ==========================================
import fetch from 'node-fetch';
import { matchSale, buildFullList } from './roster.js';

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

// Cache court des scans d'events : "RDV pris" et "SalesForge" balayent la même
// fenêtre → on évite de tout re-télécharger deux fois dans la même requête.
const scanCache = new Map(); // clé: `${min}|${max}` -> { ts, events }
const SCAN_TTL = 60 * 1000;

// Purge les entrées expirées. Sans ça, chaque nouvelle fenêtre (les presets
// relatifs bougent dans le temps) crée une entrée jamais libérée, avec tous les
// events Calendly en payload -> la RAM monte jusqu'à l'OOM (SIGABRT 134) sur
// Render puis redémarrage. Ce cache ne sert qu'à dédupliquer dans une même
// requête, donc on peut purger agressivement.
function pruneScanCache() {
  const now = Date.now();
  for (const [k, v] of scanCache) {
    if (now - v.ts >= SCAN_TTL) scanCache.delete(k);
  }
}

/**
 * Récupère les scheduled events dont le START_TIME est dans [minStart, maxStart].
 * Pagine via l'URL next_page fournie par Calendly (ne JAMAIS reconstruire avec le token).
 */
async function fetchEventsByStart(minStart, maxStart) {
  pruneScanCache();
  const cacheKey = `${minStart}|${maxStart}`;
  const hit = scanCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < SCAN_TTL) return hit.events;

  let url = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(ORG())}&status=active&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}&count=100`;
  let all = [];
  let safety = 0;
  while (url && safety < 150) {
    safety += 1;
    const data = await fetchWithRetry(url);
    all = all.concat(data.collection || []);
    url = data.pagination?.next_page || null;
  }
  scanCache.set(cacheKey, { ts: Date.now(), events: all });
  return all;
}

function isR2(event) {
  return (event.name || '').trim().toLowerCase().startsWith('retour');
}
function hostName(event) {
  return event.event_memberships?.[0]?.user_name || 'Inconnu';
}
function groupByHost(events) {
  const map = new Map();
  for (const e of events) {
    const name = matchSale(hostName(e)) || 'Inconnu';
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
  const events = await fetchEventsByStart(start.toISOString(), end.toISOString());
  const r1 = events.filter((e) => !isR2(e));
  const r2 = events.filter((e) => isR2(e));
  return {
    r1: { total: r1.length, detail: groupByHost(r1) },
    r2: { total: r2.length, detail: groupByHost(r2) },
  };
}

/**
 * R1/R2 "PRIS" dans la plage (filtre sur created_at).
 * Calendly ne permet pas de filtrer directement sur created_at via l'API,
 * donc on récupère une large fenêtre d'events à venir + récents, puis on filtre
 * côté code sur created_at dans la plage.
 *
 * Fenêtre de scan : events dont le start_time va de (start - 7j) à (start + 365j).
 * Ça couvre les RDV pris dans la plage qui ont lieu plus tard.
 */
export async function getRdvBookedInRange({ start, end }) {
  // On scanne large car un RDV "pris" aujourd'hui peut avoir lieu dans plusieurs mois.
  const scanStart = new Date(start);
  scanStart.setDate(scanStart.getDate() - 7);
  const scanEnd = new Date(start);
  scanEnd.setDate(scanEnd.getDate() + 365);

  const events = await fetchEventsByStart(scanStart.toISOString(), scanEnd.toISOString());

  const createdInRange = events.filter((e) => {
    if (!e.created_at) return false;
    const c = new Date(e.created_at);
    return c >= start && c <= end;
  });

  const r1 = createdInRange.filter((e) => !isR2(e));
  const r2 = createdInRange.filter((e) => isR2(e));
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
async function getInviteeUtmSource(event) {
  try {
    const data = await fetchWithRetry(`${event.uri}/invitees?count=1`);
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
  const scanStart = new Date(start);
  scanStart.setDate(scanStart.getDate() - 7);
  const scanEnd = new Date(start);
  scanEnd.setDate(scanEnd.getDate() + 365);

  const events = await fetchEventsByStart(scanStart.toISOString(), scanEnd.toISOString());
  const createdInRange = events.filter((e) => {
    if (!e.created_at) return false;
    const c = new Date(e.created_at);
    return c >= start && c <= end;
  });

  // Garde-fou : au-delà de ~2500 RDV créés, le scan des invitees (1 appel/RDV)
  // prendrait plusieurs minutes et exploserait les quotas → on refuse proprement.
  if (createdInRange.length > 2500) {
    throw new Error(
      `période trop large pour le tracking SalesForge (${createdInRange.length} RDV à inspecter). Choisis une période de 3 mois max pour cette tuile.`
    );
  }

  // Invitees par paquets parallèles de 10
  const BATCH = 10;
  const salesforgeEvents = [];
  for (let i = 0; i < createdInRange.length; i += BATCH) {
    const batch = createdInRange.slice(i, i + BATCH);
    const sources = await Promise.all(batch.map(getInviteeUtmSource));
    sources.forEach((src, j) => {
      if (src === 'salesforge') salesforgeEvents.push(batch[j]);
    });
  }

  return { total: salesforgeEvents.length, detail: groupByHost(salesforgeEvents) };
}

// Managers dont on veut les RDV NL (noms exacts du roster)
const NL_MANAGERS = ['Lisa Neveu', 'Paul Jouannet', 'David CHEA', 'Quentin PUREN'];

/**
 * RDV générés par Newsletter sur la période :
 * = events CRÉÉS dans la plage (created_at) dont l'invitee a utm_source = "newsletter".
 * Retourné groupé par manager (Lisa, Paul, David, Quentin) uniquement.
 */
export async function getNewsletterRdv({ start, end }) {
  const scanStart = new Date(start);
  scanStart.setDate(scanStart.getDate() - 7);
  const scanEnd = new Date(start);
  scanEnd.setDate(scanEnd.getDate() + 365);

  const events = await fetchEventsByStart(scanStart.toISOString(), scanEnd.toISOString());
  const createdInRange = events.filter((e) => {
    if (!e.created_at) return false;
    const c = new Date(e.created_at);
    return c >= start && c <= end;
  });

  if (createdInRange.length > 2500) {
    throw new Error(
      `Période trop large pour le tracking Newsletter (${createdInRange.length} RDV à inspecter).`
    );
  }

  // Récupère les utm_source par paquets de 10
  const BATCH = 10;
  const nlEvents = [];
  for (let i = 0; i < createdInRange.length; i += BATCH) {
    const batch = createdInRange.slice(i, i + BATCH);
    const sources = await Promise.all(batch.map(getInviteeUtmSource));
    sources.forEach((src, j) => {
      if (src === 'newsletter') nlEvents.push(batch[j]);
    });
  }

  // Grouper par manager (NL_MANAGERS uniquement)
  const counts = {};
  NL_MANAGERS.forEach((m) => { counts[m] = 0; });
  for (const e of nlEvents) {
    const name = matchSale(hostName(e));
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
  const events = await fetchEventsByStart(start.toISOString(), end.toISOString());
  const map = new Map();
  for (const e of events) {
    const raw = e.event_memberships?.[0]?.user_name || '(sans hôte)';
    map.set(raw, (map.get(raw) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count, matchedTo: matchSale(name) }))
    .sort((a, b) => b.count - a.count);
}
