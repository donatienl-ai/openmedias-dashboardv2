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

/**
 * Récupère les scheduled events dont le START_TIME est dans [minStart, maxStart].
 * Pagine via l'URL next_page fournie par Calendly (ne JAMAIS reconstruire avec le token).
 */
async function fetchEventsByStart(minStart, maxStart) {
  let url = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(ORG())}&status=active&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}&count=100`;
  let all = [];
  let safety = 0;
  while (url && safety < 40) {
    safety += 1;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Calendly failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    all = all.concat(data.collection || []);
    url = data.pagination?.next_page || null;
  }
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
