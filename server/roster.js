// ==========================================
//  ROSTER DES COMMERCIAUX OPENMEDIAS
//  Dérivé en direct des comptes commercial_users (SQLite, planning.db) —
//  remplace l'ancienne liste SALES figée à la main dans ce fichier. Un
//  nouveau commercial apparaît désormais dans toutes les métriques (CA,
//  propals, propositions comptes, calls, RDV, objectifs...) dès que son
//  compte existe (⚙️ Paramètres → Comptes / rétroplanning → Comptes),
//  sans jamais retoucher ce fichier — c'est justement l'ancien pas manuel
//  qui restait systématiquement oublié à chaque embauche. Un commercial qui
//  quitte reste dans ce roster (désactivé ≠ supprimé) pour ne pas perdre son
//  historique de vente sur les périodes passées — voir la note plus bas.
// ==========================================
// Les sources (Aircall, Calendly, Salesforce) renvoient les noms dans des
// formats variés ("Streith Noemie", "Noémie Streith", etc.). On matche sur le
// NOM DE FAMILLE normalisé (sans accent, minuscule) — dérivé automatiquement
// du dernier mot du nom du compte (commercial_users.nom), donc lui aussi sans
// entretien manuel.
const { db: planningDb } = (await import('../planning/backend/db.js')).default;

/** Enlève accents + minuscule + trim. */
function normalize(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Alias ponctuels pour des fautes d'orthographe récurrentes d'un outil tiers
// (Aircall/Calendly) qu'on ne peut pas déduire du nom du compte — à ne pas
// confondre avec un commercial manquant : ça n'empêche jamais un nouveau
// compte d'apparaître, ça élargit juste le matching d'un nom déjà connu.
// Clé = nom de famille normalisé du compte.
const ALIASES = {
  streith: ['streight'],
};

// Rôles qui comptent comme "commerciaux" pour les métriques CA/propals/etc.
// (edito/communication n'ont pas accès au dashboard commercial — cf.
// planning/backend/router.js VALID_ROLES et son commentaire "pas d'accès
// dashboard" — les inclure ici ne ferait qu'ajouter des lignes à 0 qui ne
// matcheront jamais rien dans Salesforce/Aircall/Calendly).
const ROSTER_ROLES = ['commercial', 'manager', 'admin'];

// IMPORTANT : on ne filtre PAS sur actif=1 ici. Un commercial qui quitte est
// désactivé (pour couper sa connexion), pas supprimé — mais son historique de
// vente reste bien réel. Filtrer sur actif ferait disparaître sa ligne de
// TOUS les détails par commercial (CA, propals...) dès sa désactivation, y
// compris sur les périodes passées où il travaillait encore ici : un rapport
// annuel perdrait alors une partie du CA réellement généré. L'ancienne liste
// SALES figée à la main avait ce comportement par accident (personne n'y
// retirait jamais un nom qui partait, il finissait juste masqué via "Sales
// visibles") — on le reproduit ici volontairement. Un commercial parti reste
// donc dans le roster pour toujours ; s'il faut le sortir de la vue courante
// du dashboard, ⚙️ Paramètres → Sales visibles fait déjà exactement ça, sans
// toucher à l'historique.

// Requêtes potentiellement très fréquentes (une par enregistrement Salesforce/
// Aircall/Calendly dans une boucle de matching) : un cache mémoire de
// quelques secondes évite de retaper la même requête SQLite des centaines de
// fois par appel API, tout en restant assez court pour qu'un compte tout
// juste créé apparaisse dès le rechargement suivant du dashboard (pas besoin
// d'un redéploiement).
const ROSTER_CACHE_TTL_MS = 15000;
let rosterCache = null;
let rosterCacheAt = 0;

function loadRosterFromDb() {
  const placeholders = ROSTER_ROLES.map(() => '?').join(',');
  const rows = planningDb
    .prepare(
      `SELECT nom, role, actif FROM commercial_users WHERE COALESCE(role, 'commercial') IN (${placeholders})`
    )
    .all(...ROSTER_ROLES);
  return rows
    .map((r) => {
      const nom = (r.nom || '').trim();
      const words = nom.split(/\s+/);
      const last = normalize(words[words.length - 1] || nom);
      return {
        display: nom,
        last,
        role: r.role || 'commercial',
        actif: !!r.actif,
        aliases: ALIASES[last] || [],
      };
    })
    .filter((s) => s.display)
    .sort((a, b) => a.last.localeCompare(b.last));
}

/**
 * Liste de référence des commerciaux, dérivée en direct de commercial_users
 * (role commercial/manager/admin — actif ou non, voir la note ci-dessus).
 * Toujours à jour (à quelques secondes de cache près, cf.
 * ROSTER_CACHE_TTL_MS) — pas de liste à maintenir à la main.
 */
export function getRoster() {
  const now = Date.now();
  if (rosterCache && now - rosterCacheAt < ROSTER_CACHE_TTL_MS) return rosterCache;
  rosterCache = loadRosterFromDb();
  rosterCacheAt = now;
  return rosterCache;
}

/**
 * Tente de matcher un nom brut (depuis une source) à un sale du roster.
 * Match si le nom de famille du roster est présent dans le nom brut normalisé.
 * Renvoie le `display` du roster, ou le nom brut tel quel si pas de match.
 */
export function matchSale(rawName) {
  const norm = normalize(rawName);
  if (!norm) return null;
  const found = getRoster().find(
    (s) => norm.includes(s.last) || (s.aliases || []).some((a) => norm.includes(normalize(a)))
  );
  return found ? found.display : rawName;
}

/**
 * Construit la liste complète : tous les sales du roster avec leur valeur,
 * 0 pour ceux absents de `dataMap`. dataMap = Map(displayName -> {count, amount}).
 * Renvoie un tableau trié par valeur décroissante (puis alphabétique).
 */
export function buildFullList(dataMap, withAmount = false) {
  const rows = getRoster().map((s) => {
    const entry = dataMap.get(s.display) || {};
    // On propage tous les champs de l'entrée (ex: inbound/outbound pour les calls)
    const base = { name: s.display, ...entry, count: entry.count || 0 };
    if (withAmount) base.amount = entry.amount || 0;
    return base;
  });
  rows.sort((a, b) => {
    const va = withAmount ? a.amount : a.count;
    const vb = withAmount ? b.amount : b.count;
    if (vb !== va) return vb - va;
    return a.name.localeCompare(b.name);
  });
  return rows;
}
