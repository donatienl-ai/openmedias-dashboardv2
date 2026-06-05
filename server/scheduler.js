// ==========================================
//  PLANIFICATEUR INTERNE DU REPORTING
//  Vérifie chaque minute si l'envoi auto est dû
//  (heure Europe/Paris, jours choisis, anti-doublon).
//  Fenêtre de rattrapage de 30 min : si le service
//  était endormi pile à l'heure H, l'envoi part dès
//  le réveil (ping UptimeRobot) tant que H+30 n'est
//  pas dépassé.
// ==========================================

const state = {
  lastSentKey: null,      // 'YYYY-MM-DD' du dernier envoi auto
  lastAutoSendAt: null,   // ISO du dernier envoi auto réussi
  lastAutoError: null,    // dernier message d'erreur éventuel
};

/** Heure courante à Paris : { dateKey, day (0=dim..6=sam), minutes } */
export function parisNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    day: dayMap[get('weekday')] ?? 0,
    minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10),
  };
}

/**
 * Décide si l'envoi auto est dû (fonction pure, testable).
 * @param {{dateKey,day,minutes}} now
 * @param {{reportAuto,reportTime,reportDays}} s
 * @param {string|null} lastSentKey
 */
export function shouldSendNow(now, s, lastSentKey) {
  if (!s.reportAuto) return false;
  if (!Array.isArray(s.reportDays) || !s.reportDays.includes(now.day)) return false;
  const m = /^(\d{2}):(\d{2})$/.exec(s.reportTime || '');
  if (!m) return false;
  const target = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if (now.minutes < target || now.minutes > target + 30) return false; // fenêtre 30 min
  if (lastSentKey === now.dateKey) return false; // déjà envoyé aujourd'hui
  return true;
}

/**
 * Démarre la boucle (toutes les 45s).
 * @param {() => Promise<any>} sendFn - effectue l'envoi du reporting
 * @param {() => object} getSettingsFn
 */
export function startScheduler(sendFn, getSettingsFn) {
  setInterval(async () => {
    try {
      const s = getSettingsFn();
      const now = parisNow();
      if (!shouldSendNow(now, s, state.lastSentKey)) return;
      state.lastSentKey = now.dateKey; // verrouille AVANT l'envoi (anti-doublon)
      await sendFn();
      state.lastAutoSendAt = new Date().toISOString();
      state.lastAutoError = null;
      console.log(`Reporting auto envoyé (${now.dateKey})`);
    } catch (e) {
      state.lastAutoError = String(e.message || e);
      console.error('Reporting auto en échec :', state.lastAutoError);
    }
  }, 45 * 1000);
}

export function getSchedulerState() {
  return { ...state };
}
