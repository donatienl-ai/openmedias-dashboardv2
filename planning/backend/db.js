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

-- Boîte à idées du rétroplanning communication (v1) : idées de posts pas
-- encore datées, glissées sur le calendrier pour devenir un social_posts
-- (voir /api/social-ideas). channel/notes optionnels dès la v1 pour ne pas
-- avoir à migrer la table plus tard, mais la saisie rapide côté panneau ne
-- demande qu'un titre.
CREATE TABLE IF NOT EXISTS social_ideas (
id INTEGER PRIMARY KEY AUTOINCREMENT,
title TEXT NOT NULL,
channel TEXT,
notes TEXT,
created_at TEXT DEFAULT (datetime('now'))
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
// Migration : émission créée sur le planning à l'envoi du BDC (créneau jaune
// "BDC en attente") — le lien permet d'éviter les doublons et, plus tard,
// d'automatiser des transitions de statut.
try { db.exec('ALTER TABLE bdc_envois ADD COLUMN emission_id INTEGER'); } catch(e) {}
// Migration : date de diffusion saisie sur le BDC au moment de l'envoi — sert
// à recaler le créneau planning à la bonne date et aux réparations.
try { db.exec('ALTER TABLE bdc_envois ADD COLUMN date_diffusion TEXT'); } catch(e) {}

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

// ── RECOUVREMENT / PENNYLANE (nouveau projet) ────────────────────────────────
// Outil interne de suivi des impayés, connecté en lecture à l'API Pennylane
// (source de vérité facturation — voir ./pennylane.js pour la synchro).
// Les factures/clients ci-dessous sont un CACHE local (on ne réécrit jamais
// rien côté Pennylane) : ça évite de retaper l'API à chaque affichage du
// dashboard, et ça permet de stocker des infos qui n'existent QUE côté nous
// (statut interne de recouvrement, attribution, historique de relances).
// id en TEXT : on reste agnostique du format d'id renvoyé par l'API Pennylane
// (numérique aujourd'hui, mais rien ne garantit que ça reste un integer).
db.exec(`
CREATE TABLE IF NOT EXISTS pennylane_customers (
id TEXT PRIMARY KEY,
name TEXT,
email TEXT,
phone TEXT,
synced_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pennylane_invoices (
id TEXT PRIMARY KEY,
invoice_number TEXT,
customer_id TEXT,
date_emission TEXT,
deadline TEXT,
amount REAL DEFAULT 0,
remaining_amount REAL DEFAULT 0,
status TEXT,
-- Statut de recouvrement interne (distinct du statut Pennylane ci-dessus,
-- qui ne dit rien du suivi de relance) : a_relancer -> en_cours -> soit
-- solde (payée), soit litige/promesse_paiement en cas de blocage.
internal_status TEXT DEFAULT 'a_relancer',
-- Attribution par collaborateur abandonnée (une seule personne gère le
-- recouvrement) — colonne conservée pour compat mais plus lue/écrite.
assigned_to TEXT,
synced_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pennylane_invoices_customer ON pennylane_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_pennylane_invoices_deadline ON pennylane_invoices(deadline);

-- Historique des relances (multi-canal) faites sur une facture — ce que
-- l'Excel + Trello actuels ne permettent pas de garder proprement.
CREATE TABLE IF NOT EXISTS finance_relances (
id INTEGER PRIMARY KEY AUTOINCREMENT,
invoice_id TEXT NOT NULL,
canal TEXT,
note TEXT,
auteur TEXT,
created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_relances_invoice ON finance_relances(invoice_id);

-- Commentaires libres sur une facture (distinct des relances ci-dessus :
-- une relance = une action de contact datée par canal ; un commentaire =
-- une simple note libre, ex. "client dit payer vendredi", "erreur sur BDC").
CREATE TABLE IF NOT EXISTS finance_invoice_comments (
id INTEGER PRIMARY KEY AUTOINCREMENT,
invoice_id TEXT NOT NULL,
auteur TEXT,
comment TEXT NOT NULL,
created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_comments_invoice ON finance_invoice_comments(invoice_id);
-- Migration : un commentaire peut désormais être modifié après coup (ouvert
-- à tout compte finance/admin, pas restreint — décision Lina 09/2026) ;
-- updated_at reste NULL tant que le commentaire n'a jamais été modifié, ce
-- qui permet d'afficher "modifié" uniquement quand c'est vraiment le cas.
try { db.exec('ALTER TABLE finance_invoice_comments ADD COLUMN updated_at TEXT'); } catch(e) {}

-- Échéances de paiement propres à l'outil (Pennylane ne renvoie qu'une
-- seule deadline par facture — le champ "installments" de son API est en
-- alpha et renvoie null pour l'instant) : permet de saisir à la main un
-- paiement fractionné (ex: 30% à la signature, 70% à 30 jours) et de suivre
-- chaque échéance séparément.
CREATE TABLE IF NOT EXISTS finance_invoice_installments (
id INTEGER PRIMARY KEY AUTOINCREMENT,
invoice_id TEXT NOT NULL,
label TEXT,
due_date TEXT NOT NULL,
amount REAL NOT NULL,
paid INTEGER DEFAULT 0,
created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_installments_invoice ON finance_invoice_installments(invoice_id);

-- Statuts d'échéance personnalisables (Paramètres > Recouvrement) : contrairement
-- à internal_status côté facture (figé dans le code, cf. FINANCE_INTERNAL_STATUSES
-- plus bas), cette liste est éditable par l'équipe elle-même sans redéploiement —
-- chaque échéance (finance_invoice_installments) référence un statut d'ici via
-- status_id. sort_order pilote l'ordre d'affichage (select, colonnes du tableau).
CREATE TABLE IF NOT EXISTS finance_installment_statuses (
id INTEGER PRIMARY KEY AUTOINCREMENT,
label TEXT NOT NULL,
color TEXT NOT NULL DEFAULT '#64748b',
sort_order INTEGER DEFAULT 0,
created_at TEXT DEFAULT (datetime('now'))
);
`);
// Migration : contact réel (nom/mail/tel d'une personne, cf. sous-endpoint
// Pennylane /customers/{id}/contacts) — distinct de email/phone ci-dessus,
// qui restent les coordonnées de la SOCIÉTÉ (fallback si pas de contact).
try { db.exec('ALTER TABLE pennylane_customers ADD COLUMN contact_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_customers ADD COLUMN contact_email TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_customers ADD COLUMN contact_phone TEXT'); } catch(e) {}
// Migration : montants HT en plus du TTC déjà stocké (amount/remaining_amount
// restent le TTC, cf. pennylane.js) — demandé pour affichage HT et TTC.
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN amount_ht REAL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN remaining_amount_ht REAL DEFAULT 0'); } catch(e) {}
// Migration : correction manuelle de l'échéance depuis l'appli (ex. délai
// négocié avec le client) — deadline_manual=1 protège `deadline` d'un écrasement
// par la prochaine synchro Pennylane (cf. upsertInvoice dans pennylane.js).
// Le montant dû, lui, n'est jamais touché par cette correction : seule la
// date qui sert au calcul du retard change (voir PATCH /api/finance/invoices/:id).
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN deadline_manual INTEGER DEFAULT 0'); } catch(e) {}
// Migration : suivi fin par échéance — un statut personnalisable (cf.
// finance_installment_statuses ci-dessus) et le montant déjà réglé sur CETTE
// tranche (le solde restant = amount - paid_amount se calcule à la volée,
// jamais stocké). `paid` (0/1) reste lu par du code plus ancien éventuel et
// se garde en synchro automatique avec paid_amount (voir financeRoutes.js).
try { db.exec('ALTER TABLE finance_invoice_installments ADD COLUMN status_id INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE finance_invoice_installments ADD COLUMN paid_amount REAL DEFAULT 0'); } catch(e) {}
// Migration : l'échéance 1 (= la deadline principale de la facture, jusqu'ici
// une simple date sans statut propre) peut désormais recevoir la même pastille
// de statut personnalisable que les échéances 2/3/4, pour rentrer dans la même
// chaîne de validation (voir computeEcheanceReference dans financeRoutes.js).
try { db.exec('ALTER TABLE pennylane_invoices ADD COLUMN deadline_status_id INTEGER'); } catch(e) {}
// Migration : un statut d'échéance peut être marqué "compte comme réglée" —
// c'est ce flag (et non le libellé "Soldée" en dur) qui fait avancer la
// référence de retard à l'échéance suivante et qui déclenche le passage
// automatique de la facture en statut "Soldée" une fois TOUTES ses échéances
// (1, 2, 3, 4...) à un statut ainsi marqué. Reste éditable dans Paramètres :
// on peut cocher/décocher cette case sur n'importe quel statut, y compris en
// créer un autre que "Soldée" qui compte aussi comme réglé.
let justAddedCompteRegle = false;
try { db.exec('ALTER TABLE finance_installment_statuses ADD COLUMN compte_regle INTEGER DEFAULT 0'); justAddedCompteRegle = true; } catch(e) {}
if (justAddedCompteRegle) {
// Statut par défaut : seul "Soldée" comptait implicitement comme réglé
// avant ce flag — on le coche une seule fois, à la création de la colonne,
// pour ne pas écraser un choix que l'équipe aurait fait depuis Paramètres.
try { db.prepare("UPDATE finance_installment_statuses SET compte_regle=1 WHERE label='Soldée'").run(); } catch(e) {}
}

// Seed : statuts d'échéance par défaut, uniquement si la liste est encore
// vide (première mise en route de la fonctionnalité) — l'équipe est ensuite
// libre de les renommer/recolorer/réordonner/supprimer depuis Paramètres.
try {
const noStatuses = db.prepare('SELECT COUNT(*) AS n FROM finance_installment_statuses').get().n === 0;
if (noStatuses) {
// "Soldée" est seedée avec compte_regle=1 (seule case cochée par défaut) —
// même règle que le rattrapage ci-dessus, mais pour une base neuve où la
// colonne existe déjà dès la création de la table.
// "Douteux" (ajouté 09/2026) : nouveau statut par défaut pour une échéance
// jamais renseignée, à la place de l'ancien état "Sans statut" (aucun
// status_id) — voir financeRoutes.js (resolveStatusId) et pennylane.js
// (upsertInvoice) qui pointent désormais vers ce statut par défaut au lieu
// de laisser status_id/deadline_status_id à NULL.
const seed = [
['À venir', '#64748b', 0],
['Douteux', '#b45309', 1],
['Relancée', '#d4a017', 2],
['Partiellement réglée', '#0d9488', 3],
['Litige', '#dc2626', 4],
['Soldée', '#16a34a', 5],
];
const insert = db.prepare('INSERT INTO finance_installment_statuses (label, color, sort_order, compte_regle) VALUES (?,?,?,?)');
seed.forEach(([label, color, order], i) => insert.run(label, color, order, 0));
// La dernière ligne du seed ("Soldée") doit rester compte_regle=1 — le
// forEach ci-dessus insère tout à 0 puis on corrige explicitement, pour
// ne pas dépendre de l'ordre du tableau si jamais il est réordonné plus tard.
try { db.prepare("UPDATE finance_installment_statuses SET compte_regle=1 WHERE label='Soldée'").run(); } catch(e) {}
}
} catch(e) {}

// Migration ponctuelle (une seule fois, marqueur dans `config`) : les
// factures déjà marquées "Soldée" avant l'ajout de la pastille de statut sur
// l'échéance 1 et sur les échéances 2/3/4 n'ont pas ce statut renseigné —
// sans ce rattrapage, leurs échéances afficheraient "Sans statut" alors que
// la facture entière est déjà soldée (relevé par Donatien après la mise en
// route de la chaîne de validation). Ne touche que les échéances SANS statut
// du tout, pour ne jamais écraser un choix déjà fait depuis l'appli.
try {
const backfillDone = db.prepare("SELECT 1 FROM config WHERE key='finance_deadline_status_backfill_done'").get();
if (!backfillDone) {
const soldee = db.prepare('SELECT id FROM finance_installment_statuses WHERE compte_regle=1 ORDER BY sort_order ASC LIMIT 1').get();
if (soldee) {
const r1 = db.prepare("UPDATE pennylane_invoices SET deadline_status_id=? WHERE internal_status='solde' AND deadline_status_id IS NULL")
.run(soldee.id);
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

// Migration ponctuelle (une seule fois, marqueur dans `config`) : depuis le
// 09/2026, toute échéance sans statut ("Sans statut", status_id/
// deadline_status_id NULL) doit afficher "Douteux" par défaut au lieu de rien
// — voir le seed ci-dessus qui a créé ce statut. Ce rattrapage aligne UNE
// SEULE FOIS les échéances déjà en base et encore sans statut (ne touche
// jamais une échéance qui a déjà un statut choisi, même "À venir").
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

// ── RECOUVREMENT / PENNYLANE (nouveau projet) ────────────────────────────────
// Statut de recouvrement interne d'une facture (voir pennylane_invoices) :
// a_relancer (pas encore contactée) -> en_cours (au moins une relance faite,
// posé automatiquement à la première relance, affiché "Relancé" côté UI
// depuis 09/2026 — voir recouvrement/frontend/app.js, FINANCE_STATUS_LABEL ;
// la clé technique en_cours n'a volontairement pas changé) -> soit solde
// (payée, posé à la main en attendant qu'un futur sync détecte
// remaining_amount<=0 côté Pennylane), soit litige/promesse_paiement en cas
// de blocage.
const FINANCE_INTERNAL_STATUSES = ['a_relancer', 'en_cours', 'litige', 'promesse_paiement', 'solde'];

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

module.exports = { db, SLOTS_PAR_MEDIA, FORMATS_PAR_MEDIA, MEDIAS, SOUS_MEDIAS_SPECIALISES, SOUS_MEDIAS_LIST, CHANNELS, SOCIAL_POST_STATUSES, FINANCE_INTERNAL_STATUSES };
