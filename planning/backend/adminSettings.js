// ── RÉGLAGES ADMIN DU DASHBOARD (reporting email + journal de connexions) ────
// Remplace server/settings.js et le loginLog en mémoire du dashboard (perdus à
// chaque redémarrage) : persistés en SQLite, dans la même base partagée que le
// planning — un seul backend admin, quelle que soit la page depuis laquelle on
// les modifie (console cachée du dashboard OU Paramètres du planning).
const { db } = require('./db');
const { parseMonthlyObjective } = require('./objectiveValue');

db.exec(`
  CREATE TABLE IF NOT EXISTS dashboard_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS dashboard_login_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    ip TEXT,
    ua TEXT
  );
`);

const PRESETS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7', 'last_30'];

const DEFAULTS = {
  reportTheme: process.env.REPORT_THEME === 'dark' ? 'dark' : 'light',
  reportTo: process.env.REPORT_TO || '',
  reportPreset: PRESETS.includes(process.env.REPORT_PRESET) ? process.env.REPORT_PRESET : 'today',
  reportAuto: process.env.REPORT_AUTO === 'true',
  reportTime: /^\d{2}:\d{2}$/.test(process.env.REPORT_TIME || '') ? process.env.REPORT_TIME : '08:00',
  reportDays: [1, 2, 3, 4, 5],
  // Objectif de CA mensuel (€) : 0 = pas d'objectif défini (alerte de seuil
  // désactivée sur la tuile CA du dashboard). Réglable par un admin depuis le
  // dashboard (clic sur le badge objectif) ou via cette même table.
  monthlyRevenueObjective: Math.max(0, parseInt(process.env.MONTHLY_REVENUE_OBJECTIVE || '0', 10) || 0),
};

// Seed unique : au premier démarrage sur la base persistée, on reprend soit les
// valeurs d'env, soit les défauts ci-dessus (une seule fois — table vide = jamais seedée).
try {
  const seeded = db.prepare('SELECT COUNT(*) as n FROM dashboard_settings').get();
  if (seeded.n === 0) {
    const insert = db.prepare('INSERT INTO dashboard_settings (key,value) VALUES (?,?)');
    insert.run('reportTheme', DEFAULTS.reportTheme);
    insert.run('reportTo', DEFAULTS.reportTo);
    insert.run('reportPreset', DEFAULTS.reportPreset);
    insert.run('reportAuto', DEFAULTS.reportAuto ? '1' : '0');
    insert.run('reportTime', DEFAULTS.reportTime);
    insert.run('reportDays', JSON.stringify(DEFAULTS.reportDays));
    insert.run('monthlyRevenueObjective', String(DEFAULTS.monthlyRevenueObjective));
  }
  // Migration douce : une base déjà seedée AVANT l'ajout de ce champ n'a pas
  // la ligne — on l'ajoute sans toucher au reste des réglages déjà en place.
  const hasObjective = db.prepare("SELECT COUNT(*) as n FROM dashboard_settings WHERE key = 'monthlyRevenueObjective'").get();
  if (hasObjective.n === 0) {
    db.prepare('INSERT INTO dashboard_settings (key,value) VALUES (?,?)').run('monthlyRevenueObjective', String(DEFAULTS.monthlyRevenueObjective));
  }
} catch (e) {}

function getReportSettings() {
  const rows = db.prepare('SELECT key, value FROM dashboard_settings').all();
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  let reportDays = DEFAULTS.reportDays;
  try { reportDays = JSON.parse(map.reportDays || '[]'); } catch (e) {}
  return {
    reportTheme: map.reportTheme === 'dark' ? 'dark' : 'light',
    reportTo: map.reportTo || '',
    reportPreset: PRESETS.includes(map.reportPreset) ? map.reportPreset : 'today',
    reportAuto: map.reportAuto === '1',
    reportTime: /^\d{2}:\d{2}$/.test(map.reportTime || '') ? map.reportTime : '08:00',
    reportDays: Array.isArray(reportDays) ? reportDays : DEFAULTS.reportDays,
    monthlyRevenueObjective: Math.max(0, parseInt(map.monthlyRevenueObjective, 10) || 0),
  };
}

function set(key, value) {
  db.prepare('INSERT INTO dashboard_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

function updateReportSettings(patch = {}) {
  const objective = patch.monthlyRevenueObjective === undefined ? undefined : parseMonthlyObjective(patch.monthlyRevenueObjective);
  if (patch.reportTheme === 'light' || patch.reportTheme === 'dark') set('reportTheme', patch.reportTheme);
  if (typeof patch.reportTo === 'string') set('reportTo', patch.reportTo);
  if (PRESETS.includes(patch.reportPreset)) set('reportPreset', patch.reportPreset);
  if (typeof patch.reportAuto === 'boolean') set('reportAuto', patch.reportAuto ? '1' : '0');
  if (typeof patch.reportTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.reportTime)) set('reportTime', patch.reportTime);
  if (Array.isArray(patch.reportDays)) {
    const days = [...new Set(patch.reportDays.map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6))];
    set('reportDays', JSON.stringify(days));
  }
  if (patch.monthlyRevenueObjective !== undefined) {
    set('monthlyRevenueObjective', String(objective));
  }
  return getReportSettings();
}

// ── Journal des connexions (200 derniers, persisté) ──────────────────────────
function recordLoginEvent(ok, ip, ua) {
  db.prepare('INSERT INTO dashboard_login_events (at, ok, ip, ua) VALUES (?,?,?,?)').run(
    new Date().toISOString(), ok ? 1 : 0, ip || 'inconnue', String(ua || '').slice(0, 200)
  );
  // Purge : ne garde que les 200 derniers événements.
  db.exec(`DELETE FROM dashboard_login_events WHERE id NOT IN (
    SELECT id FROM dashboard_login_events ORDER BY id DESC LIMIT 200
  )`);
}

function getLoginEvents(limit = 200) {
  return db.prepare('SELECT at, ok, ip, ua FROM dashboard_login_events ORDER BY id DESC LIMIT ?').all(limit)
    .map((r) => ({ at: r.at, ok: !!r.ok, ip: r.ip, ua: r.ua }));
}

module.exports = { getReportSettings, updateReportSettings, recordLoginEvent, getLoginEvents };
