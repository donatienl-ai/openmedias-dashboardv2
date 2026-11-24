const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'planning.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 1. CRÉATION DES TABLES PRINCIPALES (Ordre de dépendance respecté) ─────────
db.exec(`
CREATE TABLE IF NOT EXISTS config (
key TEXT PRIMARY KEY,
value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipes_edito (
id INTEGER PRIMARY KEY AUTOINCREMENT,
nom TEXT UNIQUE NOT NULL,
created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales_teams (
id TEXT PRIMARY KEY,
label TEXT NOT NULL,
manager_id INTEGER,
created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commercial_users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
nom TEXT NOT NULL,
sf_user_id TEXT,
equipe_edito_id INTEGER REFERENCES equipes_edito(id) ON DELETE SET NULL,
team_id TEXT REFERENCES sales_teams(id) ON DELETE SET NULL,
role TEXT DEFAULT 'commercial',
is_admin INTEGER DEFAULT 0,
docusign_user_id TEXT,
reset_token TEXT,
reset_token_expires TEXT,
actif INTEGER DEFAULT 1,
created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commercial_objectives (
commercial_id INTEGER PRIMARY KEY REFERENCES commercial_users(id) ON DELETE CASCADE,
monthly_amount REAL NOT NULL DEFAULT 0,
updated_at TEXT DEFAULT (datetime('now'))
);

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
upsell REAL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS social_ideas (
id INTEGER PRIMARY KEY AUTOINCREMENT,
title TEXT NOT NULL,
channel TEXT,
notes TEXT,
created_at TEXT DEFAULT (datetime('now'))
);

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
sender_ds_user_id TEXT,
emission_id INTEGER REFERENCES emissions(id) ON DELETE SET NULL,
date_diffusion TEXT,
created_at TEXT DEFAULT (datetime('now')),
updated_at TEXT DEFAULT (datetime('now'))
);
`);

// ── 2. MIGRATIONS SCHÉMA (Rattrapage pour bases existantes) ────────────────────
try { db.exec('ALTER TABLE social_posts ADD COLUMN drive_link TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE social_posts ADD COLUMN image_data TEXT'); } catch(e) {}

try { db.exec('ALTER TABLE emissions ADD COLUMN montant REAL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE emissions ADD COLUMN upsell REAL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE emissions ADD COLUMN sous_media TEXT'); } catch(e) {}
try { db.exec("UPDATE emissions SET statut='a_programmer' WHERE statut='a_deplacer'"); } catch(e) {}

try { db.exec('ALTER TABLE commercial_users ADD COLUMN reset_token TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE commercial_users ADD COLUMN reset_token_expires TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE commercial_users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE commercial_users ADD COLUMN docusign_user_id TEXT'); } catch(e) {}
try { db.exec("ALTER TABLE commercial_users ADD COLUMN role TEXT DEFAULT 'commercial'"); } catch(e) {}
try { db.exec('ALTER TABLE commercial_users ADD COLUMN team_id TEXT'); } catch(e) {}

try { db.exec('ALTER TABLE bdc_envois ADD COLUMN sender_ds_user_id TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE bdc_envois ADD COLUMN emission_id INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE bdc_envois ADD COLUMN date_diffusion TEXT'); } catch(e) {}

try { db.exec('ALTER TABLE sales_teams ADD COLUMN manager_id INTEGER'); } catch(e) {}

try { db.exec("UPDATE commercial_users SET role='admin' WHERE is_admin=1 AND (role IS NULL OR role='commercial')"); } catch(e) {}

// Seed des équipes de ventes initiales
try {
const seeded = db.prepare('SELECT COUNT(*) as n FROM sales_teams').get();
if (seeded && seeded.n === 0) {
const seedTeams = db.prepare('INSERT INTO sales_teams (id,label) VALUES (?,?)');
seedTeams.run('lisa', 'Équipe Lisa');
seedTeams.run('quentin', 'Équipe Quentin');
seedTeams.run('david', 'Équipe David');
seedTeams.run('paul', 'Équipe Paul');
}
} catch(e) {}

// ── 3. TABLES RECOUVREMENT / PENNYLANE ───────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS pennylane_customers (
id TEXT PRIMARY KEY,
name TEXT,
email TEXT,
phone TEXT,
contact_name TEXT,
contact_email TEXT,
contact_phone TEXT,
synced_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pennylane_invoices (
id TEXT PRIMARY KEY,
invoice_number TEXT,
customer_id TEXT REFERENCES pennylane_customers(id) ON DELETE CASCADE,
date_emission TEXT,
deadline TEXT,
deadline_manual INTEGER DEFAULT 0,
deadline_status_id INTEGER,
amount REAL DEFAULT 0,
remaining_amount REAL DEFAULT 0,
amount_ht REAL DEFAULT 0,
remaining_amount_ht REAL DEFAULT 0,
status TEXT,
internal_status TEXT DEFAULT 'a_relancer',
assigned_to TEXT,
synced_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pennylane_invoices_customer ON pennylane_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_pennylane_invoices_deadline ON pennylane_invoices(deadline);

CREATE TABLE IF NOT EXISTS finance_relances (
id INTEGER PRIMARY KEY AUTOINCREMENT,
invoice_id TEXT NOT NULL REFERENCES pennylane_invoices(id) ON DELETE CASCADE,
canal TEXT,
note TEXT,
auteur TEXT,
created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_relances_invoice ON finance_relances(invoice_id);

CREATE TABLE IF NOT EXISTS finance_invoice_comments (
id INTEGER PRIMARY KEY AUTOINCREMENT,
invoice_id TEXT NOT NULL REFERENCES pennylane_invoices(id) ON DELETE CASCADE,
auteur TEXT,
comment TEXT NOT NULL,
updated_at TEXT,
created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_comments_invoice ON finance_invoice_comments(invoice_id);

CREATE TABLE IF NOT EXISTS finance_installment_statuses (
id INTEGER PRIMARY KEY AUTOINCREMENT,
label TEXT NOT NULL,
color TEXT NOT NULL DEFAULT '#64748b',
sort_order INTEGER DEFAULT 0,
compte_regle INTEGER DEFAULT 0,
created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finance_invoice_installments (
id INTEGER PRIMARY KEY AUTOINCREMENT,
invoice_id TEXT NOT NULL REFERENCES pennylane_invoices(id) ON DELETE CASCADE,
label TEXT,
due_date TEXT NOT NULL,
amount REAL NOT NULL,
paid INTEGER DEFAULT 0,
paid_amount REAL DEFAULT 0,
status_id INTEGER REFERENCES finance_installment_statuses(id) ON DELETE SET NULL,
created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_installments_invoice ON finance_invoice_installments(invoice_id);
`);

// Migrations défensives Recouvrement
try { db.exec('ALTER TABLE finance_invoice_comments ADD COLUMN updated_at TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_customers ADD COLUMN contact_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_customers ADD COLUMN contact_email TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_customers ADD COLUMN contact_phone TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN amount_ht REAL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN remaining_amount_ht REAL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN deadline_manual INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE finance_invoice_installments ADD COLUMN status_id INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE finance_invoice_installments ADD COLUMN paid_amount REAL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN deadline_status_id INTEGER'); } catch(e) {}
// Mention spéciale Pennylane : c'est là que sont écrits les acomptes / échéances (13/10/2026)
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN special_mention TEXT'); } catch(e) {}

let justAddedCompteRegle = false;
try {
db.exec('ALTER TABLE finance_installment_statuses ADD COLUMN compte_regle INTEGER DEFAULT 0');
justAddedCompteRegle = true;
} catch(e) {}

if (justAddedCompteRegle) {
try {
db.prepare("UPDATE finance_installment_statuses SET compte_regle=1 WHERE label='Soldée'").run();
} catch(e) {}
}

// Seed statuts d'échéance par défaut
try {
const statusCount = db.prepare('SELECT COUNT(*) AS n FROM finance_installment_statuses').get();
if (statusCount && statusCount.n === 0) {
const seed = [
['À venir', '#64748b', 0],
['Douteux', '#b45309', 1],
['Relancée', '#d4a017', 2],
['Partiellement réglée', '#0d9488', 3],
['Litige', '#dc2626', 4],
['Soldée', '#16a34a', 5],
];
const insert = db.prepare('INSERT INTO finance_installment_statuses (label, color, sort_order, compte_regle) VALUES (?,?,?,?)');
seed.forEach(([label, color, order]) => insert.run(label, color, order, 0));
db.prepare("UPDATE finance_installment_statuses SET compte_regle=1 WHERE label='Soldée'").run();
}
} catch(e) {}

// Backfills ponctuels
try {
const backfillDone = db.prepare("SELECT 1 FROM config WHERE key='finance_deadline_status_backfill_done'").get();
if (!backfillDone) {
const soldee = db.prepare('SELECT id FROM finance_installment_statuses WHERE compte_regle=1 ORDER BY sort_order ASC LIMIT 1').get();
if (soldee) {
const r1 = db.prepare("UPDATE pennylane_invoices SET deadline_status_id=? WHERE internal_status='solde' AND deadline_status_id IS NULL").run(soldee.id);
const r2 = db.prepare(`
UPDATE finance_invoice_installments
SET status_id=?, paid=1, paid_amount=amount
WHERE status_id IS NULL
AND invoice_id IN (SELECT id FROM pennylane_invoices WHERE internal_status='solde')
`).run(soldee.id);
console.log(`[FINANCE] Rattrapage "Soldée" : ${r1.changes} échéance(s) 1 + ${r2.changes} échéance(s) 2/3/4 alignée(s) sur le statut d'échéance.`);
}
db.prepare("INSERT INTO config (key,value) VALUES ('finance_deadline_status_backfill_done','1')").run();
}
} catch(e) {}

try {
const douteuxBackfillDone = db.prepare("SELECT 1 FROM config WHERE key='finance_douteux_default_backfill_done'").get();
if (!douteuxBackfillDone) {
const douteux = db.prepare("SELECT id FROM finance_installment_statuses WHERE label='Douteux' ORDER BY sort_order ASC LIMIT 1").get();
if (douteux) {
const r1 = db.prepare('UPDATE pennylane_invoices SET deadline_status_id=? WHERE deadline_status_id IS NULL').run(douteux.id);
const r2 = db.prepare('UPDATE finance_invoice_installments SET status_id=? WHERE status_id IS NULL').run(douteux.id);
console.log(`[FINANCE] Rattrapage "Douteux" par défaut : ${r1.changes} échéance(s) 1 + ${r2.changes} échéance(s) 2/3/4 basculée(s) de "Sans statut" à "Douteux".`);
}
db.prepare("INSERT INTO config (key,value) VALUES ('finance_douteux_default_backfill_done','1')").run();
}
} catch(e) {}

try {
const exists = db.prepare("SELECT 1 FROM config WHERE key='horizon_mois'").get();
if (!exists) db.prepare("INSERT INTO config (key,value) VALUES ('horizon_mois','3')").run();
} catch(e) {}

// ── 4. CONSTANTES ET EXPORTS ──────────────────────────────────────────────────
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
const CHANNELS = ['Instagram', 'LinkedIn', 'YouTube', 'Newsletter'];
const SOCIAL_POST_STATUSES = ['a_faire', 'pret', 'publie'];
// report_projet ajouté le 15/10/2026 (demande Lina) : projet reporté, suivi à part comme un litige.
const FINANCE_INTERNAL_STATUSES = ['a_relancer', 'en_cours', 'douteux', 'litige', 'report_projet', 'promesse_paiement', 'solde'];

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
"Gala": ["Article digital"],
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
"Le Moniteur Matériels": ["Article digital"],
"Batinfo": ["Article digital"]
};
const SOUS_MEDIAS_LIST = Object.keys(SOUS_MEDIAS_SPECIALISES);

module.exports = {
db,
SLOTS_PAR_MEDIA,
FORMATS_PAR_MEDIA,
MEDIAS,
SOUS_MEDIAS_SPECIALISES,
SOUS_MEDIAS_LIST,
CHANNELS,
SOCIAL_POST_STATUSES,
FINANCE_INTERNAL_STATUSES
};
