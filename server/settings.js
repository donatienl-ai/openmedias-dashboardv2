// ==========================================
//  RÉGLAGES ADMIN (en mémoire, seedés par env)
//  Modifiables via la console cachée du dashboard.
//  NB: Render free = mémoire volatile → les défauts env
//  reprennent la main après un redémarrage ; le dashboard
//  re-synchronise les réglages sauvegardés à chaque ouverture.
// ==========================================

const PRESETS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7', 'last_30'];

const settings = {
  reportTheme: process.env.REPORT_THEME === 'dark' ? 'dark' : 'light',
  reportTo: process.env.REPORT_TO || '',
  reportPreset: PRESETS.includes(process.env.REPORT_PRESET) ? process.env.REPORT_PRESET : 'today',
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
  return getSettings();
}
