// ── AUTH PARTAGÉE (comptes commerciaux) ───────────────────────────────────────
// Extrait de l'ancien server.js pour être réutilisable à la fois par le router
// OpenPlanning ET par le host OpenDashboard (fusion des deux auth sous un seul
// système de comptes : commercial_users). scrypt natif Node, aucune dépendance.
const crypto = require('crypto');
const { db } = require('./db');

// ── RÔLES MULTIPLES (09/2026, demande Lina) ──────────────────────────────────
// Un compte peut cumuler plusieurs rôles (cochés dans Paramètres). On garde la
// colonne `role` = rôle principal (le plus large, cf. ROLE_PRIORITY) pour que
// tout le code existant qui lit `role` continue de marcher à l'identique, et
// les rôles en plus vont dans `extra_roles` (liste séparée par des virgules).
// Les accès sont l'union des rôles (voir rolesOf).
const ROLE_PRIORITY = ['admin', 'manager', 'commercial', 'edito', 'communication', 'finance'];
try { db.exec("ALTER TABLE commercial_users ADD COLUMN extra_roles TEXT DEFAULT ''"); } catch (e) { /* déjà là */ }

function rolesOf(user) {
  if (!user) return [];
  const list = [user.role || 'commercial', ...String(user.extra_roles || '').split(',')]
    .map((r) => String(r).trim()).filter(Boolean);
  return [...new Set(list)];
}

// Normalise une liste de rôles cochés → { role (principal), extra, all }.
function normalizeRoles(list, validRoles) {
  const valid = validRoles || ROLE_PRIORITY;
  const all = [...new Set((Array.isArray(list) ? list : [list]).map((r) => String(r || '').trim()))]
    .filter((r) => valid.includes(r))
    .sort((a, b) => ROLE_PRIORITY.indexOf(a) - ROLE_PRIORITY.indexOf(b));
  return { role: all[0] || null, extra: all.slice(1).join(','), all };
}

function withRoles(user) {
  if (user) user.roles = rolesOf(user);
  return user;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Vérifie email + mot de passe → renvoie l'utilisateur (avec is_admin) ou null.
// Utilisé par /api/auth/commercial (planning) et /api/login (dashboard, fusion).
function verifyCommercialLogin(email, password) {
  const e = String(email || '').toLowerCase().trim();
  const user = db.prepare('SELECT * FROM commercial_users WHERE email=? AND actif=1').get(e);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return withRoles(user);
}

function getCommercialById(id) {
  if (!id) return null;
  return withRoles(db.prepare('SELECT * FROM commercial_users WHERE id=? AND actif=1').get(id));
}

module.exports = { hashPassword, verifyPassword, verifyCommercialLogin, getCommercialById, rolesOf, normalizeRoles, ROLE_PRIORITY };
