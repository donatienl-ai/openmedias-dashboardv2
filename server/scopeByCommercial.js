// ==========================================
//  SCOPING PAR COMMERCIAL — Fusion OpenDashboard
// ==========================================
// Un compte commercial connecté (non-admin) ne doit voir QUE ses propres
// chiffres, pas ceux de toute l'équipe. Toutes les sources de données
// (Aircall, Calendly, Salesforce, DocuSign) passent déjà par
// `roster.js` → `buildFullList()`, qui renvoie pour chaque métrique un
// `detail` = un tableau avec UNE ligne par commercial du roster (0 si absent).
// On peut donc scoper n'importe quelle réponse de façon générique : repérer la
// ligne de la bonne personne dans chaque `detail`, et reconstruire les totaux
// à partir de cette seule ligne — sans toucher aux connecteurs eux-mêmes.
import { matchSale, SALES } from './roster.js';

const ROSTER_DISPLAYS = new Set(SALES.map((s) => s.display));

// Champs d'agrégat courants dans ce projet, tous dérivés du `detail`.
const AGG_FIELDS = {
  total: 'count',
  totalAmount: 'amount',
  totalInbound: 'inbound',
  totalOutbound: 'outbound',
};

function personRow(detail, displayName) {
  if (!Array.isArray(detail)) return null;
  return detail.find((d) => d.name === displayName) || null;
}

// Reconstruit un bloc `{ total?, totalAmount?, ..., detail }` pour une seule personne.
function scopeEntry(entry, displayName) {
  if (!entry || !Array.isArray(entry.detail)) return entry;
  const row = personRow(entry.detail, displayName) || { name: displayName, count: 0, amount: 0, inbound: 0, outbound: 0 };
  const scoped = { ...entry, detail: [row] };
  for (const [aggKey, rowKey] of Object.entries(AGG_FIELDS)) {
    if (aggKey in entry) scoped[aggKey] = row[rowKey] || 0;
  }
  return scoped;
}

// Clés dont la valeur est un groupe de sous-blocs (chacun avec son propre
// `detail`), au lieu d'un bloc direct — ex: rdvToday.r1/r2, bdc.sent/signed/pending.
const NESTED_KEYS = new Set(['rdvToday', 'rdvBooked', 'bdc']);

/**
 * Scope un payload complet (celui de /api/dashboard, ou son `compare` imbriqué)
 * pour un commercial donné. Ne modifie que les clés reconnues (detail direct ou
 * imbriqué) ; laisse le reste (range, errors, generatedAt...) inchangé.
 */
export function scopeDataToCommercial(data, displayName) {
  const out = { ...data };
  for (const key of Object.keys(out)) {
    const val = out[key];
    if (!val || typeof val !== 'object') continue;
    if (NESTED_KEYS.has(key)) {
      const nested = {};
      for (const subKey of Object.keys(val)) nested[subKey] = scopeEntry(val[subKey], displayName);
      out[key] = nested;
    } else if (Array.isArray(val.detail)) {
      out[key] = scopeEntry(val, displayName);
    } else if (key === 'compare' && val) {
      out[key] = scopeDataToCommercial(val, displayName);
    }
  }
  return out;
}

/**
 * Résout le nom de roster (SALES[].display) correspondant à un compte
 * commercial connecté, à partir de son `nom` (commercial_users.nom).
 * Renvoie null si aucun match trouvé dans roster.js (le commercial verra alors
 * des zéros partout — à corriger en ajoutant/alignant l'entrée dans SALES).
 */
export function resolveDisplayName(commercial) {
  if (!commercial || !commercial.nom) return null;
  const matched = matchSale(commercial.nom);
  // matchSale renvoie le nom brut tel quel s'il ne trouve aucune correspondance
  // dans SALES — dans ce cas ce n'est pas un display valide du roster.
  return matched && ROSTER_DISPLAYS.has(matched) ? matched : null;
}
