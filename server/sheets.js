// ==========================================
//  CONNECTEUR GOOGLE SHEETS (SalesForge)
//  Auth via API Key (lecture seule)
// ==========================================
import fetch from 'node-fetch';

/**
 * Lit l'onglet DATA_RAW et renvoie le détail des RDV SalesForge par commercial.
 * UTM Source = "salesforge" (cumul all-time).
 */
export async function getSalesforgeData() {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || 'DATA_RAW';

  if (!apiKey || !sheetId) {
    return { total: 0, detail: [], disabled: true };
  }

  const range = `${encodeURIComponent(tab)}!A:AO`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Sheets failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const rows = data.values || [];
  if (rows.length < 2) return { total: 0, detail: [] };

  // En-têtes en ligne 1
  const headers = rows[0];
  const idxUserName = headers.findIndex((h) => /user name/i.test(h));
  const idxUtmSource = headers.findIndex((h) => /utm source/i.test(h));

  const colUser = idxUserName >= 0 ? idxUserName : 0; // colonne A par défaut
  const colUtm = idxUtmSource >= 0 ? idxUtmSource : 24; // colonne Y par défaut

  const map = new Map();
  let total = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const utm = (row[colUtm] || '').trim().toLowerCase();
    if (utm !== 'salesforge') continue;
    const user = (row[colUser] || 'Inconnu').trim();
    map.set(user, (map.get(user) || 0) + 1);
    total += 1;
  }

  const detail = Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { total, detail };
}
