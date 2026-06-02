// ==========================================
//  CONNECTEUR CALENDLY
//  Auth via Personal Access Token (Bearer)
// ==========================================
import fetch from 'node-fetch';

function authHeader() {
  return `Bearer ${process.env.CALENDLY_TOKEN || ''}`;
}

const ORG = () => process.env.CALENDLY_ORG_URI;

/**
 * Récupère TOUS les scheduled events sur une fenêtre temporelle, en paginant.
 * @param {string} minStart ISO datetime
 * @param {string} maxStart ISO datetime
 */
async function fetchEvents(minStart, maxStart) {
  let url = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(ORG())}&status=active&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}&count=100`;
  let all = [];
  let safety = 0;

  while (url && safety < 20) {
    safety += 1;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Calendly failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    all = all.concat(data.collection || []);
    const nextToken = data.pagination?.next_page_token;
    if (nextToken) {
      url = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(ORG())}&status=active&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}&count=100&page_token=${nextToken}`;
    } else {
      url = null;
    }
  }
  return all;
}

/** Un R2 = le nom de l'event commence par "Retour" (insensible casse). R1 = le reste. */
function isR2(event) {
  return (event.name || '').trim().toLowerCase().startsWith('retour');
}

/** Extrait le nom du commercial (host) depuis event_memberships. */
function hostName(event) {
  const m = event.event_memberships?.[0];
  return m?.user_name || 'Inconnu';
}

/** Regroupe une liste d'events par commercial → [{name, count}]. */
function groupByHost(events) {
  const map = new Map();
  for (const e of events) {
    const name = hostName(e);
    map.set(name, (map.get(name) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function startOfTodayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function endOfTodayISO() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
function isoNow() {
  return new Date().toISOString();
}
function isoPlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

/**
 * R1/R2 DU JOUR = events qui ONT LIEU aujourd'hui (start_time entre 00:00 et 23:59).
 */
export async function getRdvToday() {
  const events = await fetchEvents(startOfTodayISO(), endOfTodayISO());
  const r1 = events.filter((e) => !isR2(e));
  const r2 = events.filter((e) => isR2(e));
  return {
    r1: { total: r1.length, detail: groupByHost(r1) },
    r2: { total: r2.length, detail: groupByHost(r2) },
  };
}

/**
 * R1/R2 PRIS AUJOURD'HUI = events CRÉÉS aujourd'hui (created_at = today),
 * peu importe leur date de RDV. On scanne une large fenêtre future puis on filtre sur created_at.
 */
export async function getRdvBookedToday() {
  // On prend les events à venir dans les 90 prochains jours
  const events = await fetchEvents(isoNow(), isoPlusDays(90));
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const createdToday = events.filter((e) => {
    if (!e.created_at) return false;
    const c = new Date(e.created_at);
    return c >= start; // créé depuis aujourd'hui 00:00
  });

  const r1 = createdToday.filter((e) => !isR2(e));
  const r2 = createdToday.filter((e) => isR2(e));
  return {
    r1: { total: r1.length, detail: groupByHost(r1) },
    r2: { total: r2.length, detail: groupByHost(r2) },
  };
}
