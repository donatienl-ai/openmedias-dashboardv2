// ==========================================
//  SCOPING PAR COMMERCIAL / ÉQUIPE — Fusion OpenDashboard
// ==========================================
// Un compte commercial connecté (rôle 'commercial') ne doit voir QUE ses
// propres chiffres ; un compte 'manager' voit les chiffres de toute son
// équipe. Toutes les sources de données (Aircall, Calendly, Salesforce,
// DocuSign) passent déjà par `roster.js` → `buildFullList()`, qui renvoie pour
// chaque métrique un `detail` = un tableau avec UNE ligne par commercial du
// roster (0 si absent). On peut donc scoper n'importe quelle réponse de façon
// générique : ne garder que les lignes des personnes concernées, et
// reconstruire les totaux en sommant ces lignes — sans toucher aux
// connecteurs eux-mêmes. Un commercial seul = cas particulier d'une équipe à
// une personne.
import { matchSale, getRoster } from './roster.js';

// Champs d'agrégat courants dans ce projet, tous dérivés du `detail`.
const AGG_FIELDS = {
  total: 'count',
  totalAmount: 'amount',
  totalInbound: 'inbound',
  totalOutbound: 'outbound',
};

// Reconstruit un bloc `{ total?, totalAmount?, ..., detail }` pour un ensemble
// de personnes (displayNames), en sommant leurs lignes respectives.
function scopeEntry(entry, displayNames) {
  if (!entry || !Array.isArray(entry.detail)) return entry;
  const names = new Set(displayNames);
  const rows = entry.detail.filter((d) => names.has(d.name));
  const scoped = {
    ...entry,
    detail: rows.length ? rows : displayNames.map((n) => ({ name: n, count: 0, amount: 0, inbound: 0, outbound: 0 })),
  };
  for (const [aggKey, rowKey] of Object.entries(AGG_FIELDS)) {
    if (aggKey in entry) scoped[aggKey] = rows.reduce((sum, r) => sum + (r[rowKey] || 0), 0);
  }
  return scoped;
}

// Clés dont la valeur est un groupe de sous-blocs (chacun avec son propre
// `detail`), au lieu d'un bloc direct — ex: rdvToday.r1/r2, bdc.sent/signed/pending.
const NESTED_KEYS = new Set(['rdvToday', 'rdvBooked', 'bdc']);

/**
 * Scope un payload complet (celui de /api/dashboard, ou son `compare` imbriqué)
 * pour un ensemble de personnes (un seul nom = commercial ; plusieurs = équipe
 * d'un manager). Ne modifie que les clés reconnues (detail direct ou imbriqué) ;
 * laisse le reste (range, errors, generatedAt...) inchangé.
 */
export function scopeDataToCommercial(data, displayNameOrNames) {
  const displayNames = Array.isArray(displayNameOrNames) ? displayNameOrNames : [displayNameOrNames];
  const out = { ...data };
  for (const key of Object.keys(out)) {
    const val = out[key];
    if (!val || typeof val !== 'object') continue;
    if (NESTED_KEYS.has(key)) {
      const nested = {};
      for (const subKey of Object.keys(val)) nested[subKey] = scopeEntry(val[subKey], displayNames);
      out[key] = nested;
    } else if (Array.isArray(val.detail)) {
      out[key] = scopeEntry(val, displayNames);
    } else if (key === 'compare' && val) {
      out[key] = scopeDataToCommercial(val, displayNames);
    }
  }
  return out;
}

/**
 * Résout le nom de roster (getRoster()[].display) correspondant à un compte
 * commercial connecté, à partir de son `nom` (commercial_users.nom). Le
 * roster étant désormais dérivé en direct de commercial_users (voir
 * roster.js), ce cas ne devrait plus se produire pour un compte actif au
 * bon rôle — il reste possible pour un compte inactif ou hors des rôles
 * commercial/manager/admin (edito, communication), qui n'a jamais de
 * chiffres à voir de toute façon.
 */
export function resolveDisplayName(commercial) {
  if (!commercial || !commercial.nom) return null;
  const matched = matchSale(commercial.nom);
  // matchSale renvoie le nom brut tel quel s'il ne trouve aucune correspondance
  // dans le roster — dans ce cas ce n'est pas un display valide.
  const rosterDisplays = new Set(getRoster().map((s) => s.display));
  return matched && rosterDisplays.has(matched) ? matched : null;
}

/**
 * Résout les noms de roster d'une liste de comptes (ex: tous les membres d'une
 * équipe de vente) — utilisé pour le scoping d'un manager. Ignore silencieusement
 * les comptes sans correspondance roster (ils ne compteront simplement pas).
 */
export function resolveTeamDisplayNames(commercials) {
  return commercials
    .map((c) => resolveDisplayName(c))
    .filter((n) => n !== null);
}
