// ==========================================
//  RÉGLAGES ADMIN (en mémoire, seedés par env)
//  Modifiables via la console cachée du dashboard.
//  NB: Render free = mémoire volatile → les défauts env
//  reprennent la main après un redémarrage ; le dashboard
//  re-synchronise les réglages sauvegardés à chaque ouverture.
// ==========================================

const settings = {
  reportTheme: process.env.REPORT_THEME === 'dark' ? 'dark' : 'light',
  reportTo: process.env.REPORT_TO || '',
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
  return getSettings();
}
