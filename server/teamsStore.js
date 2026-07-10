// ==========================================
//  ÉQUIPES (mémoire, seedées par défaut)
//  Modifiables via ⚙️ Paramètres (côté client). NB: Render free = mémoire
//  volatile → après un redémarrage, on revient aux 4 équipes par défaut
//  ci-dessous (même logique que server/settings.js).
// ==========================================

const DEFAULT_TEAMS = [
  { id: 'lisa', label: 'Équipe Lisa', members: ['Lisa Neveu', 'Nicolas Poulain', 'Valentin Tobni', 'Manon MEUNIER', 'Lucas Dias'] },
  { id: 'quentin', label: 'Équipe Quentin', members: ['Quentin PUREN', 'Moni Kek', 'Noemie Streith', 'Anastasia Bendali'] },
  { id: 'david', label: 'Équipe David', members: ['David CHEA', 'Fabio Poisson', 'Antoine Corre', 'Adrien Lassus'] },
  { id: 'paul', label: 'Équipe Paul', members: ['Paul Jouannet', 'Louna LORION', 'Jérémie GARO', 'Mickael MARCIANO', 'Imane DOENLEN'] },
];

let teams = DEFAULT_TEAMS.map((t) => ({ ...t, members: [...t.members] }));

function slugify(label) {
  return String(label || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'equipe';
}

function uniqueId(base) {
  let id = base;
  let n = 2;
  while (teams.some((t) => t.id === id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

export function getTeams() {
  return teams.map((t) => ({ ...t, members: [...t.members] }));
}

export function createTeam({ label, members } = {}) {
  const cleanLabel = String(label || '').trim();
  if (!cleanLabel) throw new Error("Nom d'équipe requis");
  const id = uniqueId(slugify(cleanLabel));
  const team = { id, label: cleanLabel, members: Array.isArray(members) ? [...new Set(members)] : [] };
  teams.push(team);
  return { ...team, members: [...team.members] };
}

export function updateTeam(id, { label, members } = {}) {
  const team = teams.find((t) => t.id === id);
  if (!team) throw new Error('Équipe introuvable');
  if (typeof label === 'string' && label.trim()) team.label = label.trim();
  if (Array.isArray(members)) team.members = [...new Set(members)];
  return { ...team, members: [...team.members] };
}

export function deleteTeam(id) {
  const idx = teams.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error('Équipe introuvable');
  teams.splice(idx, 1);
}
