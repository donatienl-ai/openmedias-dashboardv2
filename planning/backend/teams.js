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

// manager_nom joint pour affichage direct sur la fiche équipe (avant, "qui
// manage cette équipe" ne se lisait qu'en allant chercher le rôle de chaque
// compte dans la liste "Comptes" — rien ne le montrait sur la carte équipe).
function listSalesTeams() {
  return db.prepare(`
    SELECT st.*, cu.nom as manager_nom
    FROM sales_teams st
    LEFT JOIN commercial_users cu ON cu.id = st.manager_id
    ORDER BY st.label ASC
  `).all();
}

// Comptes (commerciaux + manager) rattachés à une équipe — le manager designé
// (team.manager_id) partage aussi ce team_id par convention (posé à la
// création/édition ci-dessous), donc il apparaît ici comme un membre de plus.
// C'est volontaire : c'est ce même mécanisme que server/index.js utilise pour
// scoper un manager à SES perfs + celles de ses commerciaux (voir
// scopeByCommercial.js) — ne pas l'exclure ici casserait ce scoping.
function getTeamMembers(teamId) {
  if (!teamId) return [];
  return db.prepare(`SELECT id, nom, email, role FROM commercial_users WHERE team_id=? AND actif=1`).all(teamId);
}

// managerId : compte désigné manager de l'équipe (passe role='manager' +
// team_id sur ce compte). memberIds : commerciaux à rattacher (team_id
// seulement, rôle inchangé). Tout en une transaction pour ne pas laisser
// l'équipe créée sans ses rattachements si une étape échoue en cours de route.
function createSalesTeam(label, managerId, memberIds) {
  const clean = String(label || '').trim();
  if (!clean) throw new Error("Nom d'équipe requis");
  const id = uniqueId(slugify(clean));
  const run = db.transaction(() => {
    db.prepare('INSERT INTO sales_teams (id,label,manager_id) VALUES (?,?,?)').run(id, clean, managerId || null);
    if (managerId) {
      db.prepare("UPDATE commercial_users SET team_id=?, role='manager' WHERE id=?").run(id, managerId);
    }
    if (Array.isArray(memberIds)) {
      for (const mid of memberIds) {
        if (mid === managerId) continue; // déjà rattaché juste au-dessus, pas de doublon de traitement
        db.prepare('UPDATE commercial_users SET team_id=? WHERE id=?').run(id, mid);
      }
    }
  });
  run();
  return { id, label: clean, manager_id: managerId || null };
}

// label/managerId/memberIds tous optionnels (undefined = inchangé) — permet
// de renommer seul (comme avant) ou de ré-assigner manager/membres après coup
// sans repasser par la fiche "Comptes" compte par compte.
function updateSalesTeam(id, { label, managerId, memberIds } = {}) {
  const team = db.prepare('SELECT * FROM sales_teams WHERE id=?').get(id);
  if (!team) throw new Error('Équipe introuvable');
  const run = db.transaction(() => {
    if (label !== undefined) {
      const clean = String(label || '').trim();
      if (!clean) throw new Error("Nom d'équipe requis");
      db.prepare('UPDATE sales_teams SET label=? WHERE id=?').run(clean, id);
    }
    if (managerId !== undefined) {
      // Si l'équipe avait déjà un autre manager, il n'est plus automatiquement
      // rattaché à cette équipe (sinon deux managers y resteraient collés).
      if (team.manager_id && team.manager_id !== managerId) {
        db.prepare("UPDATE commercial_users SET team_id=NULL WHERE id=? AND team_id=?").run(team.manager_id, id);
      }
      db.prepare('UPDATE sales_teams SET manager_id=? WHERE id=?').run(managerId || null, id);
      if (managerId) {
        db.prepare("UPDATE commercial_users SET team_id=?, role='manager' WHERE id=?").run(id, managerId);
      }
    }
    if (Array.isArray(memberIds)) {
      const finalManagerId = managerId !== undefined ? managerId : team.manager_id;
      for (const mid of memberIds) {
        if (mid === finalManagerId) continue;
        db.prepare('UPDATE commercial_users SET team_id=? WHERE id=?').run(id, mid);
      }
    }
  });
  run();
  return db.prepare(`
    SELECT st.*, cu.nom as manager_nom FROM sales_teams st
    LEFT JOIN commercial_users cu ON cu.id = st.manager_id WHERE st.id=?
  `).get(id);
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
  listSalesTeams, getTeamMembers, createSalesTeam, updateSalesTeam, renameSalesTeam, deleteSalesTeam,
  findAccountByRosterName, setAccountTeam,
};
