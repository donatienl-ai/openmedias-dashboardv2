// ── AUTH PARTAGÉE (comptes commerciaux) ───────────────────────────────────────
// Extrait de l'ancien server.js pour être réutilisable à la fois par le router
// OpenPlanning ET par le host OpenDashboard (fusion des deux auth sous un seul
// système de comptes : commercial_users). scrypt natif Node, aucune dépendance.
const crypto = require('crypto');
const { db } = require('./db');

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
  return user;
}

function getCommercialById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM commercial_users WHERE id=? AND actif=1').get(id);
}

module.exports = { hashPassword, verifyPassword, verifyCommercialLogin, getCommercialById };
