const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'planning.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS emissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sf_opportunity_id TEXT UNIQUE,
    entreprise TEXT NOT NULL,
    secteur TEXT,
    format TEXT,
    media TEXT NOT NULL,
    date_diffusion TEXT NOT NULL,
    date_diffusion_originale TEXT,
    commercial TEXT,
    resp_edit TEXT,
    homepage INTEGER DEFAULT 0,
    homepage_eco INTEGER DEFAULT 0,
    montant REAL DEFAULT 0,
    notes TEXT,
    sous_media TEXT,
    statut TEXT DEFAULT 'a_assigner',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jours_bloques (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    media TEXT,
    raison TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS equipes_edito (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nom TEXT NOT NULL,
    sf_user_id TEXT,
    equipe_edito_id INTEGER REFERENCES equipes_edito(id) ON DELETE SET NULL,
    actif INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS social_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT,
    scheduled_date TEXT NOT NULL,
    status TEXT DEFAULT 'a_faire',
    assigned_to TEXT,
    drive_link TEXT,
    image_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Suivi des BDC envoyés pour signature via DocuSign (planning, vue BDC).
  -- statut métier : envoye | signe | refuse | annule ; docusign_status = statut
  -- brut DocuSign ('sent', 'completed', 'declined', 'voided'…), rafraîchi à la
  -- demande depuis l'API (pas de webhook DocuSign Connect pour l'instant).
  CREATE TABLE IF NOT EXISTS bdc_envois (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    envelope_id TEXT UNIQUE NOT NULL,
    entreprise TEXT,
    contact TEXT,
    email TEXT,
    template TEXT,
    montant_ht REAL,
    statut TEXT DEFAULT 'envoye',
    docusign_status TEXT,
    commercial TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
// Migration : lien Drive (pièce jointe du post) ajouté après coup — try/catch
// au cas où social_posts existait déjà (déployé) sans cette colonne.
try { db.exec('ALTER TABLE social_posts ADD COLUMN drive_link TEXT'); } catch(e) {}
// Migration : image de preview envoyée directement par l'app (data URL base64) —
// remplace la tentative d'intégrer la miniature Drive (nécessitait un partage
// domaine + une session Google active dans le navigateur, jugé trop compliqué).
// Stockée en TEXT dans SQLite plutôt qu'un fichier sur disque : plus simple à
// gérer pour ce volume (dizaines de posts, pas des milliers), pas de dossier
// d'uploads à sauvegarder/nettoyer séparément de la base.
try { db.exec('ALTER TABLE social_posts ADD COLUMN image_data TEXT'); } catch(e) {}

// Migration: add montant column if missing
try { db.exec('ALTER TABLE emissions ADD COLUMN montant REAL DEFAULT 0'); } catch(e) {}
// Migration: add upsell column if missing
try { db.exec('ALTER TABLE emissions ADD COLUMN upsell REAL DEFAULT 0'); } catch(e) {}
// Migration: add sous_media column if missing (titres sous "Médias spécialisés")
try { db.exec('ALTER TABLE emissions ADD COLUMN sous_media TEXT'); } catch(e) {}
// Migration: fusion des statuts "à déplacer" et "à programmer" en un seul ("à programmer")
try { db.exec("UPDATE emissions SET statut='a_programmer' WHERE statut='a_deplacer'"); } catch(e) {}
// Migration: colonnes pour l'invitation par email (le commercial définit lui-même son mot de passe)
try { db.exec('ALTER TABLE commercial_users ADD COLUMN reset_token TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE commercial_users ADD COLUMN reset_token_expires TEXT'); } catch(e) {}
// Migration: flag admin (fusion OpenDashboard) — un commercial admin voit les
// chiffres de toute l'équipe sur le dashboard, au lieu de ses seuls chiffres.
try { db.exec('ALTER TABLE commercial_users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch(e) {}
// Migration : userId DocuSign du commercial (GUID), résolu automatiquement
// depuis l'email de son compte au premier envoi de BDC (docusignSend.js) —
// chaque commercial envoie ses enveloppes depuis SON compte DocuSign.
try { db.exec('ALTER TABLE commercial_users ADD COLUMN docusign_user_id TEXT'); } catch(e) {}
// Migration : userId DocuSign de l'expéditeur, stocké sur chaque envoi pour
// rafraîchir le statut de l'enveloppe avec SON token (c'est son enveloppe).
try { db.exec('ALTER TABLE bdc_envois ADD COLUMN sender_ds_user_id TEXT'); } catch(e) {}

// ── RÔLES + ÉQUIPES DE VENTE (login unique, fusion OpenDashboard) ────────────
// role : 'commercial' (ses seuls chiffres) | 'manager' (chiffres de son équipe)
// | 'edito' | 'communication' (pas d'accès dashboard, atterrissent sur /planning)
// | 'admin' (tout voir, ancien is_admin). team_id : équipe de vente (sales_teams),
// utilisée pour scoper les managers — distincte de equipes_edito (équipes
// éditoriales, pour l'assignation resp_edit des émissions, non liée aux rôles).
try { db.exec("ALTER TABLE commercial_users ADD COLUMN role TEXT DEFAULT 'commercial'"); } catch(e) {}
try { db.exec('ALTER TABLE commercial_users ADD COLUMN team_id TEXT'); } catch(e) {}
// Migration : les anciens comptes is_admin=1 deviennent role='admin' (une seule fois)
try { db.exec("UPDATE commercial_users SET role='admin' WHERE is_admin=1 AND (role IS NULL OR role='commercial')"); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS sales_teams (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── OBJECTIFS INDIVIDUELS (dashboard) ────────────────────────────────────────
// Objectif de CA mensuel par commercial (montant "courant", pas d'historique
// mois par mois pour cette v1 — même logique simple que monthlyRevenueObjective
// dans dashboard_settings, mais par personne). Éditable depuis ⚙️ Paramètres
// (React, client/src/App.js) par un compte admin.
db.exec(`
  CREATE TABLE IF NOT EXISTS commercial_objectives (
    commercial_id INTEGER PRIMARY KEY REFERENCES commercial_users(id) ON DELETE CASCADE,
    monthly_amount REAL NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
// Migration : manager désigné de l'équipe (FK logique vers commercial_users.id,
// pas de vraie contrainte SQL — même convention que commercial_users.team_id).
// Avant, "qui manage l'équipe X" ne se déduisait qu'implicitement du fait
// qu'un compte role='manager' partageait le même team_id qu'elle ; rien ne le
// rendait explicite ni visible depuis la fiche équipe elle-même.
try { db.exec('ALTER TABLE sales_teams ADD COLUMN manager_id INTEGER'); } catch(e) {}
// Seed unique (première fusion) : reprend les 4 équipes qui existaient jusque-là
// uniquement en mémoire côté dashboard (server/teamsStore.js), pour ne pas perdre
// la config existante — table vide = jamais seedée.
try {
  const seeded = db.prepare('SELECT COUNT(*) as n FROM sales_teams').get();
  if (seeded.n === 0) {
    const seedTeams = db.prepare('INSERT INTO sales_teams (id,label) VALUES (?,?)');
    seedTeams.run('lisa', 'Équipe Lisa');
    seedTeams.run('quentin', 'Équipe Quentin');
    seedTeams.run('david', 'Équipe David');
    seedTeams.run('paul', 'Équipe Paul');
  }
} catch(e) {}

// Seed setting: horizon de visibilité commercial (en mois), 3 par défaut
try {
  const exists = db.prepare("SELECT 1 FROM config WHERE key='horizon_mois'").get();
  if (!exists) db.prepare("INSERT INTO config (key,value) VALUES ('horizon_mois','3')").run();
} catch(e) {}

const SLOTS_PAR_MEDIA = {
  'TIME': 1,
  'BFMTV': 2,
  'BFM Business 1&2': 2,
  'BFM Business 3&4': 2,
  'Le Figaro HP + HP Eco': 1,
  'Le Figaro HP Eco': 3,
  'Capital': 1,
  'Challenges': 2,
  'Médias spécialisés': 99
};

const FORMATS_PAR_MEDIA = {
  'BFMTV': ['Immersion', 'Article digital'],
  'BFM Business 1&2': ['Plateau TV', 'Immersion', 'Article digital'],
  'BFM Business 3&4': ['Plateau TV', 'Immersion', 'Article digital'],
  'Capital': ['Plateau TV', 'Immersion', 'Article digital', 'Article print'],
  'Le Figaro HP + HP Eco': ['Plateau TV', 'Immersion', 'Article digital'],
  'Le Figaro HP Eco': ['Plateau TV', 'Immersion', 'Article digital'],
  'Challenges': ['Article digital', 'Article print'],
  'TIME': ['Immersion', 'Article digital', 'Article print'],
  'Médias spécialisés': ['Article digital']
};

const MEDIAS = Object.keys(SLOTS_PAR_MEDIA);

// ── RÉTROPLANNING COMMUNICATION (nouveau projet) ─────────────────────────────
// Canaux de publication pour l'équipe communication (Instagram/LinkedIn/
// YouTube/Newsletter) — même convention que MEDIAS ci-dessus (liste
// hardcodée, exposée via /api/meta pour peupler le select du formulaire).
const CHANNELS = ['Instagram', 'LinkedIn', 'YouTube', 'Newsletter'];
// Statuts du rétroplanning — 3 états simples pour une v1 ("essaye un truc") :
// à faire (pas commencé) -> prêt (rédigé/validé, en attente de publication)
// -> publié (fait). Pas de workflow plus fin pour l'instant.
const SOCIAL_POST_STATUSES = ['a_faire', 'pret', 'publie'];

// Sous-picklist des titres regroupés sous "Médias spécialisés" (import Excel Donatien).
// Chaque titre liste les formats qu'il accepte réellement, différents d'un titre à l'autre.
const SOUS_MEDIAS_SPECIALISES = {
  "Figaro Sport": ["Article digital", "Immersion"],
  "Figaro Bourse": ["Article digital"],
  "RMC Sport": ["Article digital", "Immersion"],
  "Le Point": ["Article digital", "Immersion"],
  "Challenges": ["Article digital", "Article print"],
  "Cnews": ["Article digital", "Immersion", "Spot TV"],
  "Le Progrès": ["Article digital"],
  "Le Dauphiné Libéré": ["Article digital"],
  "La Tribune": ["Article digital"],
  "L'Usine Nouvelle": ["Article digital"],
  "L'Usine Digitale": ["Article digital"],
  "LSA": ["Article digital"],
  "Le Moniteur": ["Article digital"],
  "La Gazette": ["Article digital"],
  "Madame Figaro": ["Article digital"],
  "Marie France": ["Article digital"],
  "Biba": ["Article digital"],
  "Figaro Santé": ["Article digital"],
  "Science et Avenir": ["Article digital"],
  "Maison et Travaux": ["Article digital"],
  "Le journal de la Maison": ["Article digital"],
  "Mon Jardin et Ma Maison": ["Article digital"],
  "Auto Plus": ["Article digital"],
  "Auto Plus Classique": ["Article digital"],
  "L'Auto-Journal": ["Article digital"],
  "Sport Auto": ["Article digital"],
  "Grazia": ["Article digital"],
  "Modes & Travaux": ["Article digital"],
  "Psychologies": ["Article digital"],
  "Nous Deux": ["Article digital"],
  "Beauté test": ["Article digital"],
  "au feminin": ["Article digital"],
  "Fraiches": ["Article digital"],
  "Paroles de Mamans": ["Article digital"],
  "Top Santé": ["Article digital"],
  "Pleine Vie": ["Article digital"],
  "juste mieux": ["Article digital"],
  "Doctissimo": ["Article digital"],
  "Gourmand": ["Article digital"],
  "Gueuleton": ["Article digital"],
  "Super Bon": ["Article digital"],
  "Vital food": ["Article digital"],
  "marmiton": ["Article digital"],
  "Science & Vie": ["Article digital"],
  "Science & Vie Junior": ["Article digital"],
  "Science & Vie Découvertes": ["Article digital"],
  "Closer": ["Article digital"],
  "Mission Patrimoine": ["Article digital"],
  "Entre Nous": ["Article digital"],
  "Télé Star": ["Article digital"],
  "Télé Star Jeux": ["Article digital"],
  "Télé Poche": ["Article digital"],
  "Télé magazine": ["Article digital"],
  "Melty": ["Article digital"],
  "Next plz": ["Article digital"],
  "La crème du Gaming": ["Article digital"],
  "Super Soluce": ["Article digital"],
  "Les Numériques": ["Article digital"],
  "Gamekult": ["Article digital"],
  "Minute Buzz": ["Article digital"],
  "Industrie Pharma": ["Article digital"],
  "Emballages Magazine": ["Article digital"],
  "Le Moniteur des Artisans": ["Article digital"],
  "Le Moniteur Matériels": ["Article digital"]
};
const SOUS_MEDIAS_LIST = Object.keys(SOUS_MEDIAS_SPECIALISES);

module.exports = { db, SLOTS_PAR_MEDIA, FORMATS_PAR_MEDIA, MEDIAS, SOUS_MEDIAS_SPECIALISES, SOUS_MEDIAS_LIST, CHANNELS, SOCIAL_POST_STATUSES };
