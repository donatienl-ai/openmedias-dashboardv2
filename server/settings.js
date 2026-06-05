// ==========================================
//  RÉGLAGES ADMIN (en mémoire, seedés par env)
//  Modifiables via la console cachée du dashboard.
//  NB: Render free = mémoire volatile → les défauts env
//  reprennent la main après un redémarrage ; le dashboard
//  re-synchronise les réglages sauvegardés à chaque ouverture.
// ==========================================

const PRESETS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7', 'last_30'];

function parseDays(str) {
  const days = String(str || '').split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n >= 0 && n <= 6);
  return days.length ? [...new Set(days)] : null;
}

const settings = {
  reportTheme: process.env.REPORT_THEME === 'dark' ? 'dark' : 'light',
  reportTo: process.env.REPORT_TO || '',
  reportPreset: PRESETS.includes(process.env.REPORT_PRESET) ? process.env.REPORT_PRESET : 'today',
  reportAuto: process.env.REPORT_AUTO === 'true',
  reportTime: /^\d{2}:\d{2}$/.test(process.env.REPORT_TIME || '') ? process.env.REPORT_TIME : '08:00',
  reportDays: parseDays(process.env.REPORT_DAYS) || [1, 2, 3, 4, 5], // lun-ven
};

export function getSettings() {
  return { ...settings };
}

export function updateSettings(patch = {}) {
  if (patch.reportTheme === 'light' || patch.reportTheme === 'dark') {
    settings.reportTheme = patch.reportTheme;
  }
  if (typeof patch.reportTo === 'string') {
    settings.reportTo = patch.reportTo;
  }
  if (PRESETS.includes(patch.reportPreset)) {
    settings.reportPreset = patch.reportPreset;
  }
  if (typeof patch.reportAuto === 'boolean') {
    settings.reportAuto = patch.reportAuto;
  }
  if (typeof patch.reportTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.reportTime)) {
    settings.reportTime = patch.reportTime;
  }
  if (Array.isArray(patch.reportDays)) {
    const days = [...new Set(patch.reportDays.map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6))];
    settings.reportDays = days; // peut être vide = aucun jour
  }
  return getSettings();
}
