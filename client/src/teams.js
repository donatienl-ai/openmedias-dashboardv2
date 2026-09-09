// ==========================================
//  ÉQUIPES OPENMEDIAS (filtrage front)
// ==========================================
// Les noms doivent correspondre aux `display` du roster serveur.
//
// ALL_SALES et MANAGERS ci-dessous ne sont plus la source de vérité : elles
// ne servent que de valeur de repli le temps du tout premier rendu, avant
// que App.js ait reçu la réponse de GET /api/admin/roster (qui dérive
// désormais ces deux listes en direct de commercial_users, voir
// server/roster.js — un nouveau commercial y apparaît dès que son compte
// existe, sans jamais toucher ce fichier). Inutile de les tenir à jour.

export const TEAMS = [
  {
    id: 'lisa',
    label: 'Équipe Lisa',
    members: ['Lisa Neveu', 'Nicolas Poulain', 'Valentin Tobni', 'Manon MEUNIER', 'Lucas Dias'],
  },
  {
    id: 'quentin',
    label: 'Équipe Quentin',
    members: ['Quentin PUREN', 'Moni Kek', 'Noemie Streith', 'Anastasia Bendali'],
  },
  {
    id: 'david',
    label: 'Équipe David',
    members: ['David CHEA', 'Fabio Poisson', 'Antoine Corre', 'Adrien Lassus'],
  },
  {
    id: 'paul',
    label: 'Équipe Paul',
    members: ['Paul Jouannet', 'Louna LORION', 'Jérémie GARO', 'Mickael MARCIANO', 'Imane DOENLEN'],
  },
];

// Liste complète des sales (même que le roster serveur), pour le menu Sales.
export const ALL_SALES = [
  'Romy ABDEN',
  'Clauvaine Battery',
  'Anastasia Bendali',
  'Tim Cattiaux',
  'David CHEA',
  'Antoine Corre',
  'Lucas Dias',
  'Imane DOENLEN',
  'Thomas Durand',
  'Jérémie GARO',
  'Louis Hubert',
  'Thomas Jallais',
  'Paul Jouannet',
  'Thaivin Jousselin',
  'Moni Kek',
  'Adrien Lassus',
  'Donatien LEFEBURE',
  'Louna LORION',
  'Mickael MARCIANO',
  'Yanis Mehal',
  'Manon MEUNIER',
  'François Millet',
  'Theo Molina',
  'Lisa Neveu',
  'Fabio Poisson',
  'Nicolas Poulain',
  'Quentin PUREN',
  'Fouad Senhadji',
  'Rémi Simon',
  'Noemie Streith',
  'Valentin Tobni',
];

/**
 * Renvoie l'ensemble des noms autorisés selon les filtres.
 * @param {string|null} teamId - id d'équipe ou null (toutes)
 * @param {string|null} saleName - nom d'un sale ou null (tous)
 * @param {Array} teamsList - liste d'équipes à utiliser (par défaut TEAMS statique ;
 *   passer l'état dynamique chargé depuis /api/teams une fois créer/renommer/supprimer
 *   activés côté ⚙️ Paramètres)
 * @returns {Set<string>|null} null = pas de filtre (tout le monde)
 */
export function allowedNames(teamId, saleName, teamsList = TEAMS) {
  if (saleName) return new Set([saleName]);
  if (teamId) {
    const team = teamsList.find((t) => t.id === teamId);
    if (team) return new Set(team.members);
  }
  return null; // pas de filtre
}

/**
 * Sales masqués PAR DÉFAUT (hors équipe, sauf Thomas Durand qui reste visible).
 * Appliqué uniquement au premier chargement (navigateur sans réglage sauvegardé) ;
 * modifiable ensuite via ⚙️ Paramètres.
 *
 * Vidée le 09/09/2026 : tout le monde (y compris les comptes désactivés/
 * partis, conservés dans commercial_users pour l'historique de CA — voir
 * server/roster.js) est visible par défaut désormais. Ce réglage est un pur
 * filtre d'affichage côté navigateur (localStorage) : il ne touche jamais au
 * champ `actif` en base, donc ne réactive/désactive aucun compte. Ancienne
 * liste conservée ci-dessous pour référence si on veut la restaurer :
 *   Romy ABDEN, Clauvaine Battery, Tim Cattiaux, Louis Hubert,
 *   Thomas Jallais, Thaivin Jousselin, Donatien LEFEBURE, Yanis Mehal,
 *   François Millet, Theo Molina, Fouad Senhadji, Rémi Simon
 */
export const DEFAULT_HIDDEN = [];

/** Managers (filtre Rôle : Managers vs Sales). */
export const MANAGERS = [
  'Lisa Neveu',
  'Quentin PUREN',
  'David CHEA',
  'Paul Jouannet',
  'Thomas Durand',
];
