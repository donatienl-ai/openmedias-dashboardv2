// ── ÉQUIPES DE VENTE (sales_teams) ────────────────────────────────────────────
// Remplace l'ancien teamsStore.js du dashboard (qui vivait en mémoire, perdu à
// chaque redémarrage) : persisté en SQLite, partagé dashboard + planning.
// Distinct de `equipes_edito` (équipes éditoriales, pour l'assignation
// resp_edit des émissions — sans rapport avec les rôles/permissions).
// L'appartenance à une équipe se lit directement sur commercial_users.team_id
// (pas de liste de membres à maintenir à part : une seule source de vérité).
const { db } = require('./db');

function slugify(label) {
  return String(label || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'equipe';
}

function uniqueId(base) {
  let id = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM sales_teams WHERE id=?').get(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function listSalesTeams() {
  return db.prepare('SELECT * FROM sales_teams ORDER BY label ASC').all();
}

// Comptes (commerciaux + managers) rattachés à une équipe.
function getTeamMembers(teamId) {
  if (!teamId) return [];
  return db.prepare(`SELECT id, nom, email, role FROM commercial_users WHERE team_id=? AND actif=1`).all(teamId);
}

function createSalesTeam(label) {
  const clean = String(label || '').trim();
  if (!clean) throw new Error("Nom d'équipe requis");
  const id = uniqueId(slugify(clean));
  db.prepare('INSERT INTO sales_teams (id,label) VALUES (?,?)').run(id, clean);
  return { id, label: clean };
}

function renameSalesTeam(id, label) {
  const clean = String(label || '').trim();
  if (!clean) throw new Error("Nom d'équipe requis");
  const r = db.prepare('UPDATE sales_teams SET label=? WHERE id=?').run(clean, id);
  if (r.changes === 0) throw new Error('Équipe introuvable');
  return { id, label: clean };
}

function deleteSalesTeam(id) {
  // Détache les comptes rattachés (ne les supprime pas), comme pour equipes_edito.
  db.prepare('UPDATE commercial_users SET team_id=NULL WHERE team_id=?').run(id);
  const r = db.prepare('DELETE FROM sales_teams WHERE id=?').run(id);
  if (r.changes === 0) throw new Error('Équipe introuvable');
}

function normalizeNom(str) {
  return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Retrouve le compte commercial correspondant à un nom du roster (utilisé côté
// dashboard, où les groupements d'équipe se font par nom affiché plutôt que par
// id de compte). Match sur le nom complet normalisé, ou sur le nom de famille
// si fourni — mêmes règles que server/roster.js côté dashboard.
function findAccountByRosterName(displayName, lastName) {
  const rows = db.prepare("SELECT id, nom, team_id FROM commercial_users WHERE actif=1").all();
  const normDisplay = normalizeNom(displayName);
  const normLast = normalizeNom(lastName || '');
  return rows.find((r) => {
    const n = normalizeNom(r.nom);
    return n === normDisplay || (normLast && n.includes(normLast));
  }) || null;
}

function setAccountTeam(commercialId, teamId) {
  db.prepare('UPDATE commercial_users SET team_id=? WHERE id=?').run(teamId, commercialId);
}

module.exports = {
  listSalesTeams, getTeamMembers, createSalesTeam, renameSalesTeam, deleteSalesTeam,
  findAccountByRosterName, setAccountTeam,
};
