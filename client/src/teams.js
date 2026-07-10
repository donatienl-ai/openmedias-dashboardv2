// ==========================================
//  ÉQUIPES OPENMEDIAS (filtrage front)
// ==========================================
// Les noms doivent correspondre aux `display` du roster serveur.

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
 */
export const DEFAULT_HIDDEN = [
  'Romy ABDEN',
  'Clauvaine Battery',
  'Tim Cattiaux',
  'Louis Hubert',
  'Thomas Jallais',
  'Thaivin Jousselin',
  'Donatien LEFEBURE',
  'Yanis Mehal',
  'François Millet',
  'Theo Molina',
  'Fouad Senhadji',
  'Rémi Simon',
];

/** Managers (filtre Rôle : Managers vs Sales). */
export const MANAGERS = [
  'Lisa Neveu',
  'Quentin PUREN',
  'David CHEA',
  'Paul Jouannet',
  'Thomas Durand',
];
