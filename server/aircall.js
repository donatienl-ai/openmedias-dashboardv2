// ==========================================
//  CONNECTEUR AIRCALL
//  Auth via Basic (API ID : API Token)
// ==========================================
import fetch from 'node-fetch';

function authHeader() {
  const id = process.env.AIRCALL_API_ID || '';
  const token = process.env.AIRCALL_API_TOKEN || '';
  const encoded = Buffer.from(`${id}:${token}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Renvoie le timestamp Unix (secondes) du début de la journée locale.
 */
function startOfTodayUnix() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Récupère les calls sortants du jour, paginés.
 * Aircall pagine par 50 ; on boucle tant qu'il y a une page suivante.
 */
export async function getCallsToday() {
  const from = startOfTodayUnix();
  let page = 1;
  const perPage = 50;
  let allCalls = [];
  let hasMore = true;
  let safety = 0;

  while (hasMore && safety < 40) {
    safety += 1;
    const url = `https://api.aircall.io/v1/calls?from=${from}&direction=outbound&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Aircall failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const calls = data.calls || [];
    allCalls = allCalls.concat(calls);
    // Aircall renvoie meta.next_page_link à null quand c'est fini
    hasMore = Boolean(data.meta?.next_page_link);
    page += 1;
  }

  // Regroupe par utilisateur
  const map = new Map();
  for (const c of allCalls) {
    const name = c.user?.name || 'Inconnu';
    map.set(name, (map.get(name) || 0) + 1);
  }
  const detail = Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { total: allCalls.length, detail };
}
