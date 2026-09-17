import { resolveSaleName, completeRosterRows } from './nameMatching.js';
// ==========================================
//  ROSTER DES COMMERCIAUX OPENMEDIAS
//  Fusionne deux sources (voir loadRosterFromDb) :
//   1) les comptes commercial_users (SQLite, planning.db) — la source
//      vivante. Un nouveau commercial y apparaît dans toutes les métriques
//      (CA, propals, propositions comptes, calls, RDV, objectifs...) dès que
//      son compte existe (⚙️ Paramètres → Comptes / rétroplanning →
//      Comptes), sans jamais retoucher ce fichier.
//   2) STATIC_SALES ci-dessous — l'ancienne liste figée à la main, conservée
//      pour ne pas perdre l'historique de CA des commerciaux qui n'ont
//      jamais eu de compte (avant la mise en place des comptes) ou dont le
//      compte a été supprimé plutôt que désactivé. Un compte réel l'emporte
//      toujours sur une entrée statique du même nom.
//  Un commercial qui quitte reste dans ce roster (désactivé ≠ supprimé) pour
//  ne pas perdre son historique de vente sur les périodes passées — voir la
//  note plus bas.
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

// Historique conservé de l'ANCIEN roster figé à la main (avant le passage à
// commercial_users comme source). Certains de ces noms n'ont jamais eu de
// compte (embauchés avant l'existence des comptes commerciaux, ou compte
// supprimé depuis plutôt que désactivé) — sans cette liste, leur CA
// disparaîtrait purement et simplement du détail par commercial sur les
// périodes passées où ils vendaient (constaté : écart de CA sur juillet dès
// qu'un ou plusieurs sales sont masqués, cf. fBlock côté client qui
// recalcule le total à partir des lignes visibles de `detail` — un nom
// absent du détail n'est jamais recompté). Cette liste ne bouge donc plus :
// un NOUVEAU commercial n'a JAMAIS besoin d'y être ajouté (voir
// loadRosterFromDb, qui fusionne ceci avec commercial_users — un compte réel
// l'emporte toujours sur une entrée d'ici pour le même nom). Elle ne sert
// qu'à ne pas perdre les profils d'avant la bascule.
const STATIC_SALES = [
  { display: 'Romy ABDEN', last: 'abden' },
  { display: 'Clauvaine Battery', last: 'battery' },
  { display: 'Anastasia Bendali', last: 'bendali' },
  { display: 'Tim Cattiaux', last: 'cattiaux' },
  { display: 'David CHEA', last: 'chea' },
  { display: 'Antoine Corre', last: 'corre' },
  { display: 'Lucas Dias', last: 'dias' },
  { display: 'Imane DOENLEN', last: 'doenlen' },
  { display: 'Thomas Durand', last: 'durand' },
  { display: 'Jérémie GARO', last: 'garo' },
  { display: 'Louis Hubert', last: 'hubert' },
  { display: 'Thomas Jallais', last: 'jallais' },
  { display: 'Paul Jouannet', last: 'jouannet' },
  { display: 'Thaivin Jousselin', last: 'jousselin' },
  { display: 'Moni Kek', last: 'kek' },
  { display: 'Adrien Lassus', last: 'lassus' },
  { display: 'Donatien LEFEBURE', last: 'lefebure' },
  { display: 'Louna LORION', last: 'lorion' },
  { display: 'Mickael MARCIANO', last: 'marciano' },
  { display: 'Yanis Mehal', last: 'mehal' },
  { display: 'Manon MEUNIER', last: 'meunier' },
  { display: 'François Millet', last: 'millet' },
  { display: 'Theo Molina', last: 'molina' },
  { display: 'Lisa Neveu', last: 'neveu' },
  { display: 'Fabio Poisson', last: 'poisson' },
  { display: 'Nicolas Poulain', last: 'poulain' },
  { display: 'Quentin PUREN', last: 'puren' },
  { display: 'Fouad Senhadji', last: 'senhadji' },
  { display: 'Rémi Simon', last: 'simon' },
  { display: 'Noemie Streith', last: 'streith', aliases: ['streight'] },
  { display: 'Valentin Tobni', last: 'tobni' },
];

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
  const dbEntries = rows
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
        _source: 'db',
      };
    })
    .filter((s) => s.display);

  const staticEntries = STATIC_SALES.map((s) => ({
    display: s.display,
    last: s.last,
    role: s.role || 'commercial',
    actif: false,
    aliases: s.aliases || ALIASES[s.last] || [],
    _source: 'static',
  }));

  // Fusionne les deux sources par nom normalisé (accents/casse ignorés) :
  // - un compte réel (commercial_users) l'emporte toujours sur une entrée
  //   STATIC_SALES du même nom (ex: quelqu'un présent dans l'ancienne liste
  //   ET qui a depuis un vrai compte) ;
  // - deux comptes réels pour le même nom (réembauche avec un nouveau
  //   compte plutôt qu'une réactivation) : on garde l'actif ;
  // - un nom qui n'existe QUE dans STATIC_SALES (jamais eu de compte, ou
  //   compte supprimé) reste présent grâce à cette fusion.
  const byName = new Map();
  for (const s of staticEntries) byName.set(normalize(s.display), s);
  for (const s of dbEntries) {
    const key = normalize(s.display);
    const current = byName.get(key);
    if (!current || current._source === 'static' || (!current.actif && s.actif)) {
      byName.set(key, s);
    }
  }
  return [...byName.values()]
    .map(({ _source, ...rest }) => rest)
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
  return resolveSaleName(rawName, getRoster());
}

/**
 * Comme matchSale, mais ne renvoie JAMAIS le nom brut : null si aucun
 * commercial du roster ne correspond réellement. À utiliser partout où le
 * nom sert de clé d'agrégation par commercial (CA, calls, RDV, BDC...) —
 * sans ça, une personne sans compte dashboard (ex-collaborateur, agent
 * Aircall externe, faute de frappe côté Salesforce...) apparaît comme un
 * commercial à part entière dans les graphes "par commercial" au lieu
 * d'être regroupée avec les appels/dossiers non attribués (cf. l'écart
 * remonté sur "Calls par commercial" : un nom hors roster affichait sa
 * propre barre à côté des vrais commerciaux). Même logique que
 * resolveDisplayName (scopeByCommercial.js), généralisée ici.
 */
export function matchSaleStrict(rawName) {
  const matched = resolveSaleName(rawName, getRoster());
  if (!matched) return null;
  const rosterDisplays = new Set(getRoster().map((s) => s.display));
  return rosterDisplays.has(matched) ? matched : null;
}

/**
 * Construit la liste complète : tous les sales du roster avec leur valeur,
 * 0 pour ceux absents de `dataMap`. dataMap = Map(displayName -> {count, amount}).
 * Renvoie un tableau trié par valeur décroissante (puis alphabétique).
 */
export function buildFullList(dataMap, withAmount = false) {
  return completeRosterRows(dataMap, getRoster(), withAmount);
}
