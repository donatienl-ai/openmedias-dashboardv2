// ==========================================
//  CALCUL DES PLAGES DE DATES (presets)
// ==========================================
// Renvoie { start, end } en objets Date (heure locale serveur),
// start = début de journée (00:00:00), end = fin de journée (23:59:59.999).

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Lundi de la semaine de la date donnée (semaine ISO, lundi = 1er jour). */
function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0 = dimanche, 1 = lundi...
  const diff = day === 0 ? -6 : 1 - day; // ramène au lundi
  return addDays(x, diff);
}

/**
 * Résout un preset (ou une plage custom) en { start, end, label }.
 * @param {string} preset - today|yesterday|this_week|last_week|this_month|last_month|last_7|last_30|custom
 * @param {string} customStart - ISO date (YYYY-MM-DD) si preset=custom
 * @param {string} customEnd - ISO date (YYYY-MM-DD) si preset=custom
 */
export function resolveRange(preset, customStart, customEnd) {
  const now = new Date();

  switch (preset) {
    case 'yesterday': {
      const y = addDays(now, -1);
      return { start: startOfDay(y), end: endOfDay(y), label: 'Hier' };
    }
    case 'this_week':
      return { start: startOfWeek(now), end: endOfDay(now), label: 'Cette semaine' };
    case 'last_week': {
      const lwStart = addDays(startOfWeek(now), -7);
      const lwEnd = endOfDay(addDays(lwStart, 6));
      return { start: lwStart, end: lwEnd, label: 'Semaine dernière' };
    }
    case 'this_month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: startOfDay(s), end: endOfDay(now), label: 'Ce mois' };
    }
    case 'last_month': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0); // dernier jour mois précédent
      return { start: startOfDay(s), end: endOfDay(e), label: 'Mois dernier' };
    }
    case 'last_7':
      return { start: startOfDay(addDays(now, -6)), end: endOfDay(now), label: '7 derniers jours' };
    case 'last_30':
      return { start: startOfDay(addDays(now, -29)), end: endOfDay(now), label: '30 derniers jours' };
    case 'custom': {
      if (customStart && customEnd) {
        const s = startOfDay(new Date(customStart));
        const e = endOfDay(new Date(customEnd));
        const fmt = (d) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        return { start: s, end: e, label: `${fmt(s)} → ${fmt(e)}` };
      }
      // fallback aujourd'hui si custom mal formé
      return { start: startOfDay(now), end: endOfDay(now), label: "Aujourd'hui" };
    }
    case 'today':
    default:
      return { start: startOfDay(now), end: endOfDay(now), label: "Aujourd'hui" };
  }
}

/** Convertit une Date en chaîne SOQL date (YYYY-MM-DD). */
export function toSoqlDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Convertit une Date en datetime SOQL ISO (avec timezone). */
export function toSoqlDateTime(d) {
  return d.toISOString();
}

/** Timestamp Unix en secondes. */
export function toUnix(d) {
  return Math.floor(d.getTime() / 1000);
}
