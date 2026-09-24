// ── ROUTER PLANNING (OpenPlanning) ────────────────────────────────────────────
// Anciennement server.js Express autonome (planning-diff-openmedias), converti
// en express.Router() pour être monté à l'intérieur du serveur unique
// OpenDashboard (voir openmedias-dashboard/server/index.js). Ne fait plus son
// propre app.listen()/cors()/express.json()/static — tout ça est centralisé
// côté host. dotenv est aussi chargé une seule fois côté host.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cronBdc = require('node-cron');
const zlib = require('zlib');
const { db, SLOTS_PAR_MEDIA, FORMATS_PAR_MEDIA, MEDIAS, SOUS_MEDIAS_SPECIALISES, SOUS_MEDIAS_LIST, CHANNELS, SOCIAL_POST_STATUSES, FINANCE_INTERNAL_STATUSES } = require('./db');
const { setupReports } = require('./reports');
const salesforce = require('./salesforce');
const pennylane = require('./pennylane');

const app = express.Router();

const PIN_EDIT    = process.env.PIN_EDIT    || '5678';
const PIN_COM     = process.env.PIN_COM     || '1977';
// PIN personnels, accès édito identique en tout point (mêmes droits que PIN_EDIT)
const PIN_EVA     = process.env.PIN_EVA     || '2602';
const PIN_FLAVIE  = process.env.PIN_FLAVIE  || '0702';
// Vue "C-level" : accès identique à l'édito (avec CA), notif 3 colonnes Flavie/Eva/Lola
const PIN_CLEVEL  = process.env.PIN_CLEVEL  || '1973';
const SF_WEBHOOK_SECRET = process.env.SF_WEBHOOK_SECRET || 'changeme';

// Reporting config (porte dérobée)
const REPORT_EMAIL_EDITO = process.env.REPORT_EMAIL_EDITO || '';
const REPORT_EMAIL_GROWTH = process.env.REPORT_EMAIL_GROWTH || '';
// Destinataire unique de l'alerte "BDC en attente" (hors liste de diffusion générale
// REPORT_EMAIL_EDITO/GROWTH, qui inclut Lola et d'autres) — Donatien doit être seul dessus.
const EMAIL_ADMIN = process.env.EMAIL_ADMIN || 'donatien.l@openmedias.fr';

// ── MOTS DE PASSE (comptes commerciaux) ───────────────────────────────────────
// Partagé avec le host OpenDashboard depuis la fusion — voir ./auth.js.
const { hashPassword, verifyCommercialLogin, getCommercialById } = require('./auth');
const salesTeams = require('./teams');

// ── JOURS DE DIFFUSION AUTORISÉS : lundi, mercredi, vendredi ─────────────────
// Le calendrier n'affiche que ces 3 jours : une diffusion datée un mardi,
// jeudi ou week-end était acceptée par l'API puis INVISIBLE dans l'interface
// (cas réel : une diffusion "bloquée" au jeudi 10/12/2026 via le webhook
// Salesforce). Règle métier : toute diffusion hors lun/mer/ven est renvoyée
// vers "à programmer" — appliquée au webhook, au PATCH, et par un balayage
// de réparation au démarrage (ci-dessous).
const JOURS_DIFFUSION = new Set([1, 3, 5]); // getDay() : 1=lundi, 3=mercredi, 5=vendredi
const NOMS_JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

function jourSemaine(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getDay();
}
// Renvoie le nom du jour si la date n'est PAS diffusable, null sinon.
function jourNonDiffusable(dateStr) {
  const j = jourSemaine(dateStr);
  if (j === null || JOURS_DIFFUSION.has(j)) return null;
  return NOMS_JOURS[j];
}

// Balayage de réparation : idempotent et rejoué à chaque démarrage — si une
// écriture future contourne les gardes, elle sera rattrapée au prochain boot.
try {
  const fuyardes = db.prepare("SELECT id, date_diffusion FROM emissions WHERE statut NOT IN ('annule','a_programmer')").all()
    .filter((e) => jourNonDiffusable(e.date_diffusion));
  const upd = db.prepare("UPDATE emissions SET statut='a_programmer', notes=COALESCE(notes || char(10), '') || ?, updated_at=datetime('now') WHERE id=?");
  for (const e of fuyardes) {
    upd.run(`📌 Jour de diffusion impossible (${e.date_diffusion} tombe un ${jourNonDiffusable(e.date_diffusion)} — diffusions lun/mer/ven uniquement) — renvoyée automatiquement`, e.id);
  }
  if (fuyardes.length) console.log(`[PLANNING] ${fuyardes.length} diffusion(s) hors lun/mer/ven renvoyée(s) en "à programmer"`);
} catch (e) { console.error('[PLANNING] balayage jours de diffusion KO :', e.message); }

function getHorizonMois() {
  const row = db.prepare("SELECT value FROM config WHERE key='horizon_mois'").get();
  return row ? parseInt(row.value, 10) : 3;
}

function requireEdit(req, res, next) {
  if (req.headers.role !== 'edit') return res.status(403).json({ error: 'Accès refusé' });
  next();
}

// Rétroplanning communication : doit être utilisable par la communication
// elle-même (role==='com'), pas seulement édito/admin (role==='edit') —
// requireEdit seul les exclurait, d'où ce middleware dédié.
function requireContentTeam(req, res, next) {
  if (req.headers.role !== 'edit' && req.headers.role !== 'com') return res.status(403).json({ error: 'Accès refusé' });
  next();
}

function requireCommercial(req, res, next) {
  const id = req.headers['x-commercial-id'];
  if (!id) return res.status(401).json({ error: 'Non authentifié' });
  const user = getCommercialById(id);
  if (!user) return res.status(401).json({ error: 'Compte introuvable ou désactivé' });
  req.commercial = user;
  next();
}

// Recouvrement (Pennylane) : accès réservé au rôle 'finance' et aux comptes
// admin (qui, comme partout ailleurs dans l'app, voient tout) — on vérifie le
// rôle RÉEL du compte (req.commercial.role), pas le header 'role' historique
// edit/com du système PIN, sans rapport avec ce nouvel outil.
function requireFinance(req, res, next) {
  requireCommercial(req, res, () => {
    if (req.commercial.role === 'finance' || req.commercial.role === 'admin') return next();
    return res.status(403).json({ error: 'Accès refusé' });
  });
}

// ── LIMITEUR DE FRÉQUENCE (mémoire, sans dépendance externe) ──────────────────
// Protège /api/auth/forgot-password, seul endpoint public non authentifié qui
// déclenche un envoi d'email : sans limite, n'importe qui peut soit bombarder
// la boîte mail d'un compte de liens de réinitialisation (en boucle sur le
// même email), soit tester une liste d'emails pour essayer d'en deviner
// (même si la réponse reste générique, une absence de limite laisse quand
// même faire des milliers d'essais). Un seul process Node (pas de Redis
// nécessaire) : une Map en mémoire suffit, avec purge paresseuse des entrées
// expirées à chaque appel plutôt qu'un cron dédié.
const rateLimitBuckets = new Map(); // clé -> { count, resetAt }
function checkRateLimit(key, max, windowMs) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}
// IP réelle derrière le proxy Render (pas de `trust proxy` global posé côté
// host — on lit X-Forwarded-For nous-mêmes ici pour ne pas toucher au
// comportement de req.ip ailleurs dans l'appli).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ── PONT COMPTES → RÔLE PIN (login unique) ────────────────────────────────────
// Toutes les routes existantes vérifient `req.headers.role` (valeurs historiques
// 'edit'/'com', posées par le PIN côté front). Plutôt que de retoucher chaque
// route une par une, on fait en sorte qu'un compte commercial (x-commercial-id)
// avec le bon rôle produise le MÊME header, de façon transparente — les PIN
// continuent aussi de fonctionner en parallèle le temps de la bascule complète.
app.use((req, res, next) => {
  if (req.headers.role !== 'edit' && req.headers.role !== 'com') {
    const id = req.headers['x-commercial-id'];
    if (id) {
      const user = getCommercialById(id);
      if (user) {
        if (user.role === 'edito' || user.role === 'admin') req.headers.role = 'edit';
        else if (user.role === 'communication') req.headers.role = 'com';
      }
    }
  }
  next();
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  if (pin === PIN_EVA)    return res.json({ role: 'edit', nom: 'Eva' });
  if (pin === PIN_FLAVIE) return res.json({ role: 'edit', nom: 'Flavie' });
  if (pin === PIN_CLEVEL) return res.json({ role: 'edit', clevel: true });
  if (pin === PIN_EDIT)   return res.json({ role: 'edit' });
  if (pin === PIN_COM)  return res.json({ role: 'com' });
  res.status(401).json({ error: 'PIN incorrect' });
});

// ── AUTH COMMERCIALE (comptes individuels) ────────────────────────────────────
app.post('/api/auth/commercial', (req, res) => {
  const user = verifyCommercialLogin(req.body.email, req.body.password || '');
  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  // `role: 'sales'` conservé pour compat (ancien champ, valeur historique unique) —
  // `accountRole` porte le VRAI rôle du compte (commercial/manager/edito/communication/admin),
  // que le front traduit via planningRoleFor() vers ses capacités internes.
  res.json({ role: 'sales', accountRole: user.role || 'commercial', commercial_id: user.id, nom: user.nom, email: user.email, isAdmin: !!user.is_admin });
});

// Définition du mot de passe par le commercial lui-même, via le lien reçu par email
// à la création de son compte (ou après un renvoi d'invitation par l'édito).
app.post('/api/auth/set-password', (req, res) => {
  const token = String(req.body.token || '').trim();
  const password = req.body.password || '';
  if (!token) return res.status(400).json({ error: 'Lien invalide' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères minimum)' });
  const user = db.prepare('SELECT * FROM commercial_users WHERE reset_token=?').get(token);
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'Ce lien est invalide ou a expiré. Demande à l\'édito de te renvoyer une invitation.' });
  }
  db.prepare('UPDATE commercial_users SET password_hash=?, reset_token=NULL, reset_token_expires=NULL WHERE id=?')
    .run(hashPassword(password), user.id);
  res.json({ role: 'sales', accountRole: user.role || 'commercial', commercial_id: user.id, nom: user.nom, email: user.email });
});

// Mot de passe oublié (self-service) — réutilise exactement le même mécanisme
// que l'invitation de bienvenue (reset_token/reset_token_expires + lien
// ?invite=TOKEN, déjà géré côté front par checkInviteToken()/pin-card-invite) :
// un seul écran "choisis ton nouveau mot de passe" pour les deux usages, au
// lieu d'en construire un second qui ferait doublon.
// Réponse volontairement générique dans tous les cas (compte trouvé ou non) :
// ne pas laisser deviner si un email existe dans la base (énumération de comptes).
app.post('/api/auth/forgot-password', (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const genericMsg = 'Si un compte existe avec cet email, un lien de réinitialisation vient de lui être envoyé.';
  if (!email) return res.status(400).json({ error: 'Email requis' });
  // Deux limites indépendantes : par IP (empêche de mitrailler des emails au
  // hasard) et par email visé (empêche de bombarder UN compte précis, même
  // depuis des IP différentes) — 5 essais / 15 min par IP, 3 / 15 min par email.
  const FIFTEEN_MIN = 15 * 60 * 1000;
  if (!checkRateLimit(`ip:${clientIp(req)}`, 5, FIFTEEN_MIN) || !checkRateLimit(`email:${email}`, 3, FIFTEEN_MIN)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans quelques minutes.' });
  }
  const user = db.prepare('SELECT * FROM commercial_users WHERE lower(email)=? AND actif=1').get(email);
  if (!user) return res.json({ success: true, message: genericMsg }); // même réponse, compte inexistant
  const token = crypto.randomBytes(32).toString('hex');
  // Expiration courte (2h) — plus resserrée que l'invitation de bienvenue (7 jours),
  // qui doit rester valable le temps qu'un nouveau compte pense à l'ouvrir.
  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE commercial_users SET reset_token=?, reset_token_expires=? WHERE id=?').run(token, expires, user.id);
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const lien = `${baseUrl}/planning/?invite=${token}`;
  const prenom = user.nom.split(' ')[0];
  const html = `
  <div style="background:#f3f4f6;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
    <table role="presentation" style="max-width:480px;width:100%;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
      <tr>
        <td style="background:#2563EB;padding:28px 32px">
          <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.3px">Planning <span style="font-weight:400;opacity:0.85">Diffusion</span></div>
          <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#bfdbfe;font-weight:700;margin-top:4px">OpenMedias</div>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 32px 8px;color:#111827">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6">Bonjour ${prenom},</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6">
            Une réinitialisation de mot de passe a été demandée pour ton compte OpenMedias.
            Si ce n'est pas toi, tu peux ignorer cet email sans risque — ton mot de passe actuel reste valable.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 32px;text-align:center">
          <a href="${lien}" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 28px;border-radius:9px">
            Choisir un nouveau mot de passe
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 28px">
          <div style="height:1px;background:#e5e7eb;margin-bottom:20px"></div>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af">
            Ce lien est valable 2 heures et ne peut être utilisé qu'une seule fois.
          </p>
        </td>
      </tr>
    </table>
  </div>`;
  reports.sendMailOnly(`Réinitialisation de ton mot de passe OpenMedias`, html, [user.email])
    .catch((e) => console.error('[FORGOT-PASSWORD] échec envoi email:', e.message));
  res.json({ success: true, message: genericMsg });
});

// Restaure une session déjà ouverte (SSO OpenDashboard ↔ OpenPlanning, ou retour
// sur cette page) sans redemander les identifiants — le front appelle cette
// route avec le x-commercial-id déjà connu (localStorage) au chargement.
app.get('/api/auth/me', requireCommercial, (req, res) => {
  res.json({
    commercial_id: req.commercial.id,
    nom: req.commercial.nom,
    email: req.commercial.email,
    accountRole: req.commercial.role || 'commercial',
    isAdmin: !!req.commercial.is_admin,
    teamId: req.commercial.team_id || null,
  });
});

// ── WEBHOOK SALESFORCE ────────────────────────────────────────────────────────

// Normalisation d'un nom de média : casse, accents, espaces, "&" / " ET " / "+" / "/"
function normMedia(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+ET\s+/g, '&')
    .replace(/\s*&\s*/g, '&')
    .replace(/\s*\+\s*/g, '+')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

// Médias canoniques du planning, indexés par forme normalisée
// → "CAPITAL" matche "Capital", "BFM BUSINESS 1&2" matche "BFM Business 1&2", etc.
const MEDIA_CANON = {};
for (const m of MEDIAS) MEDIA_CANON[normMedia(m)] = m;

// Valeurs SF volontairement hors planning (comme dans le seed Excel) : aucune émission créée
const MEDIA_IGNORES = new Set(['FORBES'].map(normMedia));

// Alias picklist Salesforce → média planning.
// park: true → média ou dispatch incertain : l'émission est quand même créée,
// en statut "à déplacer" avec la valeur SF brute en note, au lieu d'être rejetée.
const MEDIA_ALIASES_RAW = {
  // TIME
  'TIME IMMERSION':                   { media: 'TIME', format: 'Immersion' },
  'TIME PRINT':                       { media: 'TIME', format: 'Article print' },
  'TIME ARTICLE':                     { media: 'TIME', format: 'Article digital' },
  // BFMTV
  'BFMTV ÉMISSION':                   { media: 'BFMTV', format: 'Immersion' },
  'BFMTV IMMERSION / BFMBUSINESS TV': { media: 'BFMTV', format: 'Immersion', park: true },
  // BFM Business legacy — impossible de trancher 1&2 vs 3&4 → à reclasser
  'BFM BUSINESS ARTICLE':             { media: 'BFM Business 1&2', format: 'Article digital', park: true },
  'BFM BUSINESS PLATEAU TV':          { media: 'BFM Business 1&2', format: 'Plateau TV', park: true },
  'BFM BUSINESS TV':                  { media: 'BFM Business 1&2', format: 'Plateau TV', park: true },
  // Presse & médias spécialisés
  'USINE NOUVELLE':          { media: 'Médias spécialisés' },
  'USINE DIGITALE':          { media: 'Médias spécialisés' },
  'MARIE-FRANCE':            { media: 'Médias spécialisés' },
  'BIBA':                    { media: 'Médias spécialisés' },
  'LES ECHOS SOLUTIONS':     { media: 'Médias spécialisés' },
  'LA TRIBUNE':              { media: 'Médias spécialisés' },
  'GRAZIA':                  { media: 'Médias spécialisés' },
  'LE JOURNAL DE LA MAISON': { media: 'Médias spécialisés' },
  'MAISON & TRAVAUX':        { media: 'Médias spécialisés' },
  'MON JARDIN & MA MAISON':  { media: 'Médias spécialisés' },
  'SCIENCE & VIE':           { media: 'Médias spécialisés' },
  'SCIENCES & AVENIR':       { media: 'Médias spécialisés' },
  'CLOSER':                  { media: 'Médias spécialisés' },
  "CHEF D'ENTREPRISE":       { media: 'Médias spécialisés' },
  'TOP SANTÉ':               { media: 'Médias spécialisés' },
  'TÉLÉ STAR':               { media: 'Médias spécialisés' },
  'LE PROGRÈS':              { media: 'Médias spécialisés' },
  'LE POINT':                { media: 'Médias spécialisés', sousMedia: 'Le Point' },
  // Incertains → créés en "à déplacer" (ajuste la cible si besoin)
  'CNEWS ARTICLE':           { media: 'Médias spécialisés', park: true },
  'CNEWS PLATEAU':           { media: 'Médias spécialisés', park: true },
  'FIGARO SPORT 24':         { media: 'Médias spécialisés', park: true },
  'RMC SPORT':               { media: 'Médias spécialisés', park: true }
};
const MEDIA_ALIASES = {};
for (const [k, v] of Object.entries(MEDIA_ALIASES_RAW)) MEDIA_ALIASES[normMedia(k)] = v;

// Sous-médias "Médias spécialisés", indexés par forme normalisée → titre exact du planning.
// Permet de résoudre automatiquement toute valeur SF (picklist Média) qui correspond à un
// titre de presse déjà connu du planning, sans devoir ajouter un alias manuel un par un.
const SOUS_MEDIA_CANON = {};
for (const sm of SOUS_MEDIAS_LIST) SOUS_MEDIA_CANON[normMedia(sm)] = sm;

// Résout une valeur média venue de SF vers un média du planning
function resolveMedia(raw, payload = {}) {
  const n = normMedia(raw);
  if (MEDIA_IGNORES.has(n)) return { ignore: true };
  if (MEDIA_CANON[n]) return { media: MEDIA_CANON[n] };
  // LE FIGARO : on tranche HP+HP Eco vs HP Eco via les cases homepage de l'oppo
  if (n === 'LE FIGARO' || n === 'FIGARO') {
    if (payload.homepage) return { media: 'Le Figaro HP + HP Eco' };
    if (payload.homepage_eco) return { media: 'Le Figaro HP Eco' };
    return { media: 'Le Figaro HP Eco', park: true, raison: 'Figaro sans info homepage' };
  }
  // Titre de presse reconnu directement (nouveau picklist SF aligné sur le planning)
  if (SOUS_MEDIA_CANON[n]) return { media: 'Médias spécialisés', sousMedia: SOUS_MEDIA_CANON[n] };
  if (MEDIA_ALIASES[n]) return { ...MEDIA_ALIASES[n] };
  // Valeur totalement inconnue (ex: nouvelle entrée picklist) → jamais perdue
  return { media: 'Médias spécialisés', park: true, raison: 'valeur SF inconnue du planning' };
}

// Alertes communes insertion / réactivation
function computeAlertes({ date_diffusion, media, secteur, homepage, homepage_eco }, excludeId = null) {
  const alertes = [];
  const not = excludeId ? ` AND id!=${Number(excludeId)}` : '';
  if (homepage || homepage_eco) {
    const c = db.prepare(`SELECT entreprise FROM emissions WHERE date_diffusion=? AND media=? AND (homepage=1 OR homepage_eco=1) AND statut!='annule'${not}`).all(date_diffusion, media);
    if (c.length) alertes.push(`⚠️ Homepage déjà occupée: ${c.map(e=>e.entreprise).join(', ')}`);
  }
  if (secteur) {
    const c = db.prepare(`SELECT entreprise FROM emissions WHERE date_diffusion=? AND media=? AND secteur=? AND statut!='annule'${not}`).all(date_diffusion, media, secteur);
    if (c.length) alertes.push(`⚠️ Même secteur (${secteur}): ${c.map(e=>e.entreprise).join(', ')}`);
  }
  const slots = SLOTS_PAR_MEDIA[media];
  if (slots < 99) {
    const count = db.prepare(`SELECT COUNT(*) as n FROM emissions WHERE date_diffusion=? AND media=? AND statut NOT IN ('annule','a_programmer')${not}`).get(date_diffusion, media);
    if (count.n >= slots) alertes.push(`⚠️ Slots complets pour ${media} le ${date_diffusion}`);
  }
  return alertes;
}

// Normalise un nom d'entreprise pour comparaison tolérante (casse, accents, espaces).
function normEntreprise(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Compare un nom de commercial de façon tolérante entre deux sources qui n'ont
// pas le même format : le webhook Salesforce n'envoie que le prénom du owner
// ({!$Record.Owner.FirstName}), alors que le créneau "BDC en attente" bloqué
// manuellement stocke le nom complet du compte commercial ("Quentin PUREN").
// Une égalité stricte ne matchait donc quasiment jamais, ce qui créait un
// doublon au lieu d'écraser le créneau réservé (ex: "Quentin" vs "Quentin PUREN").
function commercialMatch(a, b) {
  if (!a || !b) return true;
  const na = normEntreprise(a);
  const nb = normEntreprise(b);
  if (na === nb) return true;
  const firstA = na.split(' ')[0];
  const firstB = nb.split(' ')[0];
  return !!firstA && firstA === firstB;
}

// Résout/valide le sous-média (titre précis sous "Médias spécialisés").
// Retourne { sousMedia, error? }. Ignore silencieusement la valeur si le média
// parent n'est pas "Médias spécialisés" (évite un sous-média fantôme affiché à tort).
function resolveSousMedia(media, sous_media) {
  if (media !== 'Médias spécialisés' || !sous_media) return { sousMedia: null };
  if (!SOUS_MEDIAS_LIST.includes(sous_media)) return { error: `Média spécialisé inconnu: ${sous_media}` };
  return { sousMedia: sous_media };
}

function insertEmission(payload, isBdc = false) {
  const {
    sf_opportunity_id, entreprise, secteur, format, media,
    date_diffusion, sans_date, commercial, homepage, homepage_eco, montant, sous_media, resp_edit
  } = payload;

  const manquants = ['entreprise', 'media'].filter(f => !payload[f]);
  if (manquants.length) return { error: `Champs manquants: ${manquants.join(', ')}`, status: 400 };

  const resolu = resolveMedia(media, payload);
  if (resolu.ignore) return { ignored: true, message: `Média hors planning (${media}), ignoré`, status: 200 };

  const mediaFinal = resolu.media;
  const sousMediaResolu = resolveSousMedia(mediaFinal, sous_media || resolu.sousMedia);
  if (sousMediaResolu.error) return { error: sousMediaResolu.error, status: 400 };
  const sousMediaFinal = sousMediaResolu.sousMedia;

  // Date de diffusion manquante côté SF — soit accidentellement (Opportunité passée en
  // Fermée Gagnée sans que le champ soit rempli), soit volontairement (case "Pas de date
  // de diffusion" cochée côté SF, deal signé mais date pas encore connue) : plutôt que de
  // rejeter le deal — perdu sans trace — on le crée avec une date provisoire (aujourd'hui)
  // et on le pose dans le panneau "à programmer", en attendant que l'édito lui donne sa
  // vraie date de diffusion.
  const sansDateExplicite = sans_date === true || sans_date === 'true' || sans_date === '1' || sans_date === 1;
  const dateManquante = !date_diffusion || sansDateExplicite;
  const dateEff = (!sansDateExplicite && date_diffusion) || new Date().toISOString().slice(0, 10);

  const formatFinal = format || resolu.format || null;
  // Une émission qui arrive de Salesforce (webhook Closed Won) est confirmée
  // d'office, sauf si une info bloquante manque (date de diffusion, média
  // reconnu, format) — auquel cas elle est mise de côté en "à programmer"
  // via les raisons ci-dessous. "À assigner" reste un statut manuel possible
  // depuis l'interface, mais n'est plus la valeur par défaut à la création.
  let statut = isBdc ? 'bdc_attente' : 'confirme';
  let noteAuto = null;
  const raisons = [];
  if (resolu.park) raisons.push(`Média SF: "${media}"${resolu.raison ? ' — ' + resolu.raison : ''}`);
  if (dateManquante) raisons.push(sansDateExplicite ? 'Date de diffusion pas encore connue (case cochée côté Salesforce)' : 'Date de diffusion manquante côté Salesforce');
  if (!dateManquante && jourNonDiffusable(dateEff)) raisons.push(`Date de diffusion un ${jourNonDiffusable(dateEff)} (diffusions lun/mer/ven uniquement)`);
  if (!formatFinal) raisons.push('Format manquant côté Salesforce');
  if (raisons.length) {
    statut = 'a_programmer';
    noteAuto = `📌 ${raisons.join(' / ')} — à reclasser${isBdc ? ' (BDC en attente)' : ''}`;
  }

  // Doublon SF : réactivation si l'émission avait été annulée, 409 sinon
  if (sf_opportunity_id) {
    const ex = db.prepare('SELECT * FROM emissions WHERE sf_opportunity_id = ?').get(sf_opportunity_id);
    if (ex && ex.statut !== 'annule') return { error: 'Déjà enregistré', id: ex.id, mediaResolu: mediaFinal, status: 409 };
    if (ex) {
      const alertes = computeAlertes({ date_diffusion: dateEff, media: mediaFinal, secteur, homepage, homepage_eco }, ex.id);
      db.prepare(`
        UPDATE emissions SET
          entreprise=?, secteur=?, format=?, media=?, sous_media=?, date_diffusion=?, date_diffusion_originale=?,
          commercial=?, homepage=?, homepage_eco=?, montant=?, statut=?, resp_edit=COALESCE(?,resp_edit),
          notes=CASE WHEN ? IS NULL THEN notes ELSE COALESCE(notes || char(10), '') || ? END,
          updated_at=datetime('now')
        WHERE id=?
      `).run(entreprise, secteur || null, formatFinal, mediaFinal, sousMediaFinal, dateEff, dateEff,
        commercial || null, homepage ? 1 : 0, homepage_eco ? 1 : 0, montant || 0, statut, resp_edit || null,
        noteAuto, noteAuto, ex.id);
      return { id: ex.id, reactivee: true, mediaResolu: mediaFinal, aProgrammer: statut === 'a_programmer', alertes, status: 200 };
    }
  }

  // Créneau "BDC en attente" bloqué manuellement par le commercial AVANT que le
  // deal soit gagné dans Salesforce (via /api/emissions/bdc) : ce créneau n'a
  // pas de sf_opportunity_id, donc le matching ci-dessus ne le trouve jamais.
  // Sans ce bloc, la conversion Salesforce (closed-won) créait une 2e émission
  // en doublon au lieu d'écraser le créneau bloqué — et comme les slots/jour
  // sont limités par média, le doublon faisait passer artificiellement le
  // créneau en "complet".
  if (!isBdc) {
    const entNorm = normEntreprise(entreprise);
    const candidats = db.prepare(`
      SELECT * FROM emissions
      WHERE statut='bdc_attente' AND media=? AND (sf_opportunity_id IS NULL OR sf_opportunity_id='')
    `).all(mediaFinal);
    const match = candidats.find((c) => normEntreprise(c.entreprise) === entNorm
      && commercialMatch(commercial, c.commercial));
    if (match) {
      const alertes = computeAlertes({ date_diffusion: dateEff, media: mediaFinal, secteur, homepage, homepage_eco }, match.id);
      db.prepare(`
        UPDATE emissions SET
          sf_opportunity_id=?, entreprise=?, secteur=?, format=?, media=?, sous_media=?, date_diffusion=?, date_diffusion_originale=?,
          commercial=?, homepage=?, homepage_eco=?, montant=?, statut=?, resp_edit=COALESCE(?,resp_edit),
          notes=CASE WHEN ? IS NULL THEN notes ELSE COALESCE(notes || char(10), '') || ? END,
          updated_at=datetime('now')
        WHERE id=?
      `).run(sf_opportunity_id || null, entreprise, secteur || null, formatFinal, mediaFinal, sousMediaFinal, dateEff, dateEff,
        commercial || match.commercial || null, homepage ? 1 : 0, homepage_eco ? 1 : 0, montant || 0, statut, resp_edit || null,
        noteAuto, noteAuto, match.id);
      return { id: match.id, convertie: true, mediaResolu: mediaFinal, aProgrammer: statut === 'a_programmer', alertes, status: 200 };
    }
  }

  const alertes = computeAlertes({ date_diffusion: dateEff, media: mediaFinal, secteur, homepage, homepage_eco });

  const r = db.prepare(`
    INSERT INTO emissions (sf_opportunity_id,entreprise,secteur,format,media,sous_media,date_diffusion,date_diffusion_originale,commercial,homepage,homepage_eco,montant,notes,statut,resp_edit)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(sf_opportunity_id || null, entreprise, secteur || null, formatFinal, mediaFinal, sousMediaFinal, dateEff, dateEff, commercial || null, homepage ? 1 : 0, homepage_eco ? 1 : 0, montant || 0, noteAuto, statut, resp_edit || null);

  return { id: r.lastInsertRowid, mediaResolu: mediaFinal, aProgrammer: statut === 'a_programmer', alertes, status: 201 };
}

app.post('/api/webhook/salesforce', async (req, res) => {
  const secret = req.headers['x-sf-secret'];
  const isBdc = req.headers['x-sf-type'] === 'bdc';
  const isManual = secret === 'manual-edit';
  if (!isManual && secret !== SF_WEBHOOK_SECRET) {
    console.warn(`[SF-WEBHOOK] 403 secret invalide (opp=${(req.body && req.body.sf_opportunity_id) || '-'})`);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  let b = req.body || {};

  // Le payload envoyé par le Flow Salesforce s'est avéré à plusieurs reprises
  // incorrect (ex: Média renvoyé à "Médias spécialisés" alors que le champ
  // réel sur l'Opportunité était bon — vraisemblablement un champ mal
  // référencé côté Flow, ou une lecture avant que la modif soit committée).
  // Plutôt que de corriger au cas par cas après coup (resync manuel), on
  // relit systématiquement l'Opportunité en direct via l'API SF déjà
  // connectée dès qu'on a un Id — le payload du Flow ne sert alors que de
  // déclencheur ("il vient de se passer quelque chose sur cette Opportunité"),
  // jamais de source de vérité pour les champs. Ça doit être bon dès le
  // premier passage, pas seulement après un clic sur "Resynchroniser".
  if (!isManual && b.sf_opportunity_id) {
    try {
      const opp = await salesforce.getOpportunity(b.sf_opportunity_id);
      if (opp) {
        b = { ...b, ...opp };
      } else {
        console.warn(`[SF-WEBHOOK] Opportunité ${b.sf_opportunity_id} introuvable via l'API — on garde le payload du Flow tel quel`);
      }
    } catch (err) {
      console.error(`[SF-WEBHOOK] relecture live échouée (${err.message}) — on garde le payload du Flow tel quel`);
    }
  }

  const result = insertEmission(b, isBdc);
  const issue = result.error ? result.error
    : result.ignored ? 'ignorée (média hors planning)'
    : result.reactivee ? `réactivée id=${result.id}`
    : result.convertie ? `créneau BDC en attente converti id=${result.id}`
    : `créée id=${result.id}${result.aProgrammer ? ' → panneau "à programmer"' : ''}`;
  console.log(`[SF-WEBHOOK] ${result.status} opp=${b.sf_opportunity_id || '-'} "${b.entreprise || '?'}" media="${b.media || '?'}"${result.mediaResolu ? ` → "${result.mediaResolu}"` : ''} — ${issue}`);
  res.status(result.status).json(result);
});

// ── RESYNCHRONISATION DEPUIS SALESFORCE (à la demande) ────────────────────────
// Le webhook SF ne capture l'Opportunité qu'UNE fois, au moment précis du
// passage en "Fermée Gagnée" (Flow déclenché sur ce seul changement d'état).
// Toute modif ultérieure côté Salesforce (Média, Format, Date...) n'est donc
// jamais répercutée automatiquement dans le planning. Cette route permet à
// l'édito de forcer une relecture live de l'Opportunité via l'API SF déjà
// connectée (backend/salesforce.js) et d'écraser les champs obsolètes —
// sans toucher au statut/notes gérés manuellement dans le planning.
app.post('/api/emissions/:id/resync-sf', requireEdit, async (req, res) => {
  const e = db.prepare('SELECT * FROM emissions WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Non trouvé' });
  if (!e.sf_opportunity_id) return res.status(400).json({ error: "Cette émission n'est pas liée à une Opportunité Salesforce" });

  let opp;
  try {
    opp = await salesforce.getOpportunity(e.sf_opportunity_id);
  } catch (err) {
    console.error('[RESYNC-SF] erreur API Salesforce:', err.message);
    return res.status(502).json({ error: `Salesforce injoignable: ${err.message}` });
  }
  if (!opp) return res.status(404).json({ error: "Opportunité introuvable côté Salesforce (supprimée ?)" });

  const resolu = resolveMedia(opp.media, opp);
  if (resolu.ignore) return res.status(409).json({ error: `Média Salesforce actuel hors planning (${opp.media})` });
  const mediaFinal = resolu.media;
  const sousMediaResolu = resolveSousMedia(mediaFinal, resolu.sousMedia);
  if (sousMediaResolu.error) return res.status(400).json({ error: sousMediaResolu.error });

  const sansDateExplicite = !!opp.sans_date;
  const dateManquante = !opp.date_diffusion || sansDateExplicite;
  const dateEff = (!sansDateExplicite && opp.date_diffusion) || e.date_diffusion;
  const formatFinal = opp.format || resolu.format || null;

  const avant = { media: e.media, sous_media: e.sous_media, format: e.format, date_diffusion: e.date_diffusion, secteur: e.secteur, montant: e.montant };
  const apres = { media: mediaFinal, sous_media: sousMediaResolu.sousMedia, format: formatFinal, date_diffusion: dateEff, secteur: opp.secteur, montant: opp.montant };

  const changements = Object.keys(avant).filter(k => String(avant[k] || '') !== String(apres[k] || ''));

  // Si l'émission était en "à programmer" faute de date/média connu, et que la
  // resynchro vient justement de combler ce manque (dateManquante bascule à
  // false), on la reclasse automatiquement — sinon elle reste indéfiniment
  // affichée en "à programmer" avec une note "date manquante" qui ne l'est
  // plus, ce qui est trompeur (la date affichée est alors confondue avec une
  // vraie date de diffusion alors qu'elle vient d'être corrigée).
  let statutFinal = e.statut;
  let alerteSlot = null;
  if (e.statut === 'a_programmer' && !dateManquante) {
    const slots = SLOTS_PAR_MEDIA[mediaFinal];
    const count = slots < 99
      ? db.prepare(`SELECT COUNT(*) as n FROM emissions WHERE date_diffusion=? AND media=? AND statut!='annule' AND id!=?`).get(dateEff, mediaFinal, e.id)
      : { n: 0 };
    if (slots < 99 && count.n >= slots) {
      alerteSlot = `⚠️ Reclassement auto impossible : slots complets pour ${mediaFinal} le ${dateEff} — à reclasser manuellement`;
    } else {
      statutFinal = 'confirme';
    }
  }
  if (statutFinal !== e.statut) changements.push('statut');

  const note = changements.length
    ? `🔄 Resynchronisé depuis Salesforce le ${new Date().toISOString().slice(0,10)} — modifié: ${changements.join(', ')}${alerteSlot ? `\n${alerteSlot}` : ''}`
    : (alerteSlot || null);

  // Si on reclasse, la note "📌 ... — à reclasser" posée à la création n'a
  // plus lieu d'être : on la retire pour ne pas laisser un message obsolète
  // sur une émission désormais confirmée avec une vraie date.
  const notesBase = statutFinal === 'confirme'
    ? (e.notes || '').split('\n').filter(l => !(l.startsWith('📌') && l.includes('à reclasser'))).join('\n')
    : (e.notes || '');
  const notesFinal = note ? (notesBase ? `${notesBase}\n${note}` : note) : (notesBase || null);

  db.prepare(`
    UPDATE emissions SET
      secteur=?, format=?, media=?, sous_media=?, date_diffusion=?, montant=?, statut=?, notes=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(opp.secteur || null, formatFinal, mediaFinal, sousMediaResolu.sousMedia, dateEff, opp.montant || e.montant, statutFinal, notesFinal, e.id);

  const updated = db.prepare('SELECT * FROM emissions WHERE id=?').get(e.id);
  console.log(`[RESYNC-SF] id=${e.id} opp=${e.sf_opportunity_id} — ${changements.length ? changements.join(', ') : 'aucun changement'}`);
  res.json({ emission: updated, changements, dateManquante, reclassee: statutFinal === 'confirme' && e.statut === 'a_programmer' });
});

// Importe (ou retente) une Opportunité Salesforce par Id ou par URL, à la demande.
// Comble le cas où le webhook SF n'a jamais créé l'émission du tout — pas seulement
// le cas où elle existe avec des valeurs obsolètes (voir /resync-sf ci-dessus).
// Utile quand le Flow SF échoue silencieusement (ex: cold start Render sur le plan
// gratuit au moment précis du passage en Fermée Gagnée) ou ne se redéclenche pas
// (ex: repassage par Fermée Perdue puis reconfirmation en Fermée Gagnée).
app.post('/api/admin/import-sf-opportunity', requireEdit, async (req, res) => {
  const raw = String(req.body.sf_id || '').trim();
  const match = raw.match(/([a-zA-Z0-9]{15,18})(?:\/view)?\/?(?:\?.*)?$/);
  const sfId = match ? match[1] : '';
  if (!sfId) return res.status(400).json({ error: "Id ou URL Salesforce invalide (attendu : l'Id de l'Opportunité, ou son lien complet)" });

  let opp;
  try {
    opp = await salesforce.getOpportunity(sfId);
  } catch (err) {
    console.error('[IMPORT-SF] erreur API Salesforce:', err.message);
    return res.status(502).json({ error: `Salesforce injoignable: ${err.message}` });
  }
  if (!opp) return res.status(404).json({ error: "Opportunité introuvable côté Salesforce (Id invalide, ou droits d'accès insuffisants)" });

  const result = insertEmission(opp, false);
  console.log(`[IMPORT-SF] opp=${sfId} "${opp.entreprise}" — ${result.error || (result.reactivee ? 'réactivée' : result.convertie ? 'créneau BDC converti' : 'créée')} id=${result.id || '-'}`);
  res.status(result.status || 200).json(result);
});

// ── BDC — BLOCAGE DE CRÉNEAU PAR LE COMMERCIAL (compte individuel) ────────────
// Formulaire ultra-simple côté commercial : Entreprise, Média, Date, Format.
// Le commercial et l'équipe édito sont déduits automatiquement du compte connecté.
const MAX_BDC_ACTIFS_PAR_COMMERCIAL = 5;

app.post('/api/emissions/bdc', requireCommercial, (req, res) => {
  const { entreprise, media, date_diffusion, format, sous_media } = req.body;
  if (!entreprise || !media || !date_diffusion) {
    return res.status(400).json({ error: 'Champs manquants (entreprise, média et date sont requis)' });
  }
  if (!MEDIAS.includes(media)) return res.status(400).json({ error: `Média inconnu: ${media}` });
  const sousMediaResolu = resolveSousMedia(media, sous_media);
  if (sousMediaResolu.error) return res.status(400).json({ error: sousMediaResolu.error });

  // Jours de diffusion autorisés : lundi, mercredi, vendredi uniquement.
  // Vérifié ici côté serveur — le contrôle côté navigateur seul peut être contourné.
  const jourSemaine = new Date(date_diffusion + 'T12:00:00').getDay();
  if (![1, 3, 5].includes(jourSemaine)) {
    return res.status(400).json({ error: 'Les diffusions ne peuvent être calées que les lundis, mercredis ou vendredis.' });
  }

  const horizonMois = getHorizonMois();
  const maxDate = new Date(); maxDate.setMonth(maxDate.getMonth() + horizonMois);
  if (new Date(date_diffusion) > maxDate) {
    return res.status(403).json({ error: `Date au-delà de l'horizon autorisé (${horizonMois} mois).` });
  }

  const actifs = db.prepare(`SELECT COUNT(*) as n FROM emissions WHERE commercial=? AND statut='bdc_attente'`).get(req.commercial.nom);
  if (actifs.n >= MAX_BDC_ACTIFS_PAR_COMMERCIAL) {
    return res.status(403).json({ error: `Limite atteinte : ${MAX_BDC_ACTIFS_PAR_COMMERCIAL} créneaux BDC en attente maximum. Finalise ou libère-en un avant d'en bloquer un nouveau.` });
  }

  // Slots complets : blocage dur pour le commercial (pas de "mode forcé" comme côté édito).
  const slots = SLOTS_PAR_MEDIA[media];
  if (slots < 99) {
    const count = db.prepare(`SELECT COUNT(*) as n FROM emissions WHERE date_diffusion=? AND media=? AND statut!='annule'`).get(date_diffusion, media);
    if (count.n >= slots) {
      return res.status(409).json({ error: `Créneau complet pour ${media} le ${date_diffusion} (${count.n}/${slots}). Choisis une autre date.` });
    }
  }

  const equipe = req.commercial.equipe_edito_id
    ? db.prepare('SELECT nom FROM equipes_edito WHERE id=?').get(req.commercial.equipe_edito_id)
    : null;

  const r = db.prepare(`
    INSERT INTO emissions (entreprise,format,media,sous_media,date_diffusion,date_diffusion_originale,commercial,resp_edit,statut)
    VALUES (?,?,?,?,?,?,?,?,'bdc_attente')
  `).run(entreprise, format || null, media, sousMediaResolu.sousMedia, date_diffusion, date_diffusion, req.commercial.nom, equipe ? equipe.nom : null);

  console.log(`[BDC-COMMERCIAL] créneau bloqué id=${r.lastInsertRowid} par ${req.commercial.nom} — ${entreprise} / ${media} / ${date_diffusion}`);
  res.status(201).json({ id: r.lastInsertRowid });
});

// Nombre de créneaux BDC actifs du commercial connecté (pour affichage "3/5" côté front)
app.get('/api/emissions/bdc/mes-creneaux', requireCommercial, (req, res) => {
  const rows = db.prepare(`SELECT * FROM emissions WHERE commercial=? AND statut='bdc_attente' ORDER BY date_diffusion ASC`).all(req.commercial.nom);
  res.json({ actifs: rows.length, max: MAX_BDC_ACTIFS_PAR_COMMERCIAL, emissions: rows });
});

// Annulation d'un créneau BDC par le commercial lui-même (prospect décalé/perdu).
// Scopé strictement à ses propres créneaux, et uniquement tant qu'ils sont "en attente"
// (une fois le BDC signé/confirmé par l'édito, seul l'édito peut annuler).
app.delete('/api/emissions/bdc/:id', requireCommercial, (req, res) => {
  const e = db.prepare('SELECT * FROM emissions WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Non trouvé' });
  if (e.commercial !== req.commercial.nom) return res.status(403).json({ error: "Ce créneau n'est pas le vôtre" });
  if (e.statut !== 'bdc_attente') return res.status(403).json({ error: 'Ce créneau a déjà été traité par l\'édito et ne peut plus être annulé ici' });
  db.prepare("UPDATE emissions SET statut='annule', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  console.log(`[BDC-COMMERCIAL] créneau id=${e.id} annulé par ${req.commercial.nom} — ${e.entreprise}`);
  res.json({ success: true });
});

// ── BDC — GENERATION DU DOCUMENT PDF (fusionne depuis bdc-generator) ─────────
// Meme moteur Handlebars + Puppeteer que l'app standalone bdc-generator,
// integre ici pour eviter toute redirection vers un autre service/domaine.
// Vue dediee cote front : view-bdc (onglet "BDC", visible pour les comptes
// commerciaux). Voir backend/bdc/render.js pour les templates disponibles.
const { renderBdcPdf, renderBdcHtml, TEMPLATES: BDC_TEMPLATES } = require('./bdc/render');

function bdcFieldsFromInput(input) {
  return {
    entreprise: input.entreprise,
    contact: input.contact,
    adresse: input.adresse,
    thematique: input.thematique,
    dateDiffusion: input.dateDiffusion,
    respEmission: input.respEmission,
    montantHT: input.montantHT,
    dateDuJour: input.dateDuJour,
    noTva: input.noTva,
    delaiReglementLigne1: input.delaiReglementLigne1,
    delaiReglementLigne2: input.delaiReglementLigne2,
    delaiReglementLigne3: input.delaiReglementLigne3,
    delaiReglementLigne4: input.delaiReglementLigne4,
    descriptionItems: input.descriptionItems,
  };
}

// Import "Piste Salesforce" pour pre-remplir le formulaire BDC -- reutilise le
// connecteur Salesforce deja configure pour ce projet (salesforce.js, meme org,
// memes identifiants que getCommerciaux/getOpportunity).
app.get('/api/bdc/salesforce/lead', requireCommercial, async (req, res) => {
  try {
    const result = await salesforce.getLeadForBdc(req.query.idOrUrl);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get('/api/bdc/template-defaults', requireCommercial, (req, res) => {
  const templateKey = req.query.templateKey || 'figaro-48h-hp';
  const cfg = BDC_TEMPLATES[templateKey];
  if (!cfg) return res.status(404).json({ error: 'Template inconnu: ' + templateKey });
  res.json({ descriptionItems: cfg.descriptionItems });
});

// Liste des templates pour le sélecteur du générateur (groupés par média).
// Les 3 templates historiques n'ont pas de label/groupe dans render.js ->
// métadonnées en dur ici ; les 47 autres viennent du registre généré.
const BDC_TEMPLATE_META = {
  'figaro-48h-hp': { label: 'Le Figaro — 48H Home Page', group: 'Le Figaro', lang: 'fr' },
  'bfm-business-vision': { label: 'BFM Business — Vision d’Entreprises', group: 'BFM', lang: 'fr' },
  'capital-emission': { label: 'Capital — L’Émission', group: 'Capital', lang: 'fr' },
};
const BDC_GROUP_ORDER = ['BFM', 'Le Figaro', 'Capital', 'Challenges', 'TIME', 'Médias spécialisés'];

app.get('/api/bdc/templates', requireCommercial, (req, res) => {
  const list = Object.entries(BDC_TEMPLATES).map(([key, cfg]) => {
    const meta = BDC_TEMPLATE_META[key] || {};
    return {
      key,
      label: meta.label || cfg.label || key,
      group: meta.group || cfg.group || 'Médias spécialisés',
      lang: meta.lang || cfg.lang || 'fr',
    };
  });
  list.sort((a, b) => {
    const ga = BDC_GROUP_ORDER.indexOf(a.group), gb = BDC_GROUP_ORDER.indexOf(b.group);
    if (ga !== gb) return (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb);
    return a.label.localeCompare(b.label, 'fr');
  });
  res.json(list);
});

app.get('/api/bdc/preview', requireCommercial, async (req, res) => {
  try {
    const templateKey = req.query.templateKey || 'figaro-48h-hp';
    const html = await renderBdcHtml(templateKey, bdcFieldsFromInput(req.query));
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('<p style="font-family:sans-serif;color:#b91c1c;padding:16px;">Erreur de preview : ' + String(e.message || e) + '</p>');
  }
});

app.post('/api/bdc/generate', requireCommercial, async (req, res) => {
  try {
    const templateKey = req.body.templateKey || 'figaro-48h-hp';
    const pdf = await renderBdcPdf(templateKey, bdcFieldsFromInput(req.body));
    const safeName = (req.body.entreprise || 'BDC').replace(/[^a-z0-9]+/gi, '_');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="BDC_' + safeName + '.pdf"');
    res.send(pdf);
  } catch (e) {
    console.error('[BDC-GENERATE]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── BDC — ENVOI POUR SIGNATURE VIA DOCUSIGN ───────────────────────────────────
// Le PDF envoyé est exactement celui du bouton « Générer le PDF » (même moteur).
// L'authentification DocuSign réutilise les mêmes variables d'env que le
// connecteur reporting du dashboard (même service, même compte). Le suivi vit
// dans la table bdc_envois ; les statuts sont rafraîchis à la demande (pas de
// webhook DocuSign Connect configuré).
const docusignSend = require('./docusignSend');

const DS_STATUT_MAP = { sent: 'envoye', delivered: 'envoye', completed: 'signe', declined: 'refuse', voided: 'annule' };

// Template BDC -> média du planning de diffusion (noms de SLOTS_PAR_MEDIA).
// Sert à poser le créneau jaune "BDC en attente" sur le bon média à l'envoi.
// Les templates générés depuis les PDF sources portent planningMedia /
// planningSousMedia dans le registre ; les 3 historiques sont en dur ici.
// planningMedia null = pas de média correspondant sur le planning (pas de créneau).
const BDC_TEMPLATE_MEDIA = {
  'figaro-48h-hp': { media: 'Le Figaro HP + HP Eco', sousMedia: null },
  'bfm-business-vision': { media: 'BFM Business 1&2', sousMedia: null },
  'capital-emission': { media: 'Capital', sousMedia: null },
};
for (const [key, cfg] of Object.entries(BDC_TEMPLATES)) {
  if (BDC_TEMPLATE_MEDIA[key] || cfg.planningMedia === undefined) continue;
  if (cfg.planningMedia) BDC_TEMPLATE_MEDIA[key] = { media: cfg.planningMedia, sousMedia: cfg.planningSousMedia || null };
}

// À l'envoi DocuSign, le BDC apparaît aussi sur le planning de diffusion en
// jaune (bdc_attente) — même rendu qu'un créneau bloqué à la main. Dédupliqué :
// si le commercial avait déjà bloqué ce créneau (même entreprise/média/date),
// on le réutilise au lieu d'en créer un second. Sans date précise (période
// libre, ou jour non diffusable), l'émission part en "à programmer" avec une
// note et une DATE PROVISOIRE (aujourd'hui) — même convention que le webhook
// Salesforce, car date_diffusion est NOT NULL (un INSERT à NULL échouait
// silencieusement : bug vu en prod, aucun créneau créé).
function upsertEmissionPourBdcEnvoye({ entreprise, templateKey, dateDiffusion, montantHT, commercial }) {
  const mapping = BDC_TEMPLATE_MEDIA[templateKey] || null;
  if (!mapping) return { id: null, statut: null, cree: false };
  const media = mapping.media;
  // Inséré tel quel (valeurs du registre BDC, déjà validées contre
  // SOUS_MEDIAS_SPECIALISES) — on ne passe PAS par resolveSousMedia qui
  // n'accepte que les sous-médias de "Médias spécialisés".
  const sousMedia = mapping.sousMedia || null;

  const entNorm = entreprise.toLowerCase().trim();
  const dateValide = /^\d{4}-\d{2}-\d{2}$/.test(dateDiffusion || '') && !jourNonDiffusable(dateDiffusion)
    ? dateDiffusion : null;

  // Dédup : créneau jaune existant (date précise), ou entrée "à programmer"
  // déjà créée par un envoi DocuSign précédent (repérée par sa note).
  const existante = dateValide
    ? db.prepare(`SELECT id FROM emissions WHERE statut='bdc_attente' AND LOWER(TRIM(entreprise))=? AND media=? AND commercial=? AND date_diffusion=?`)
        .get(entNorm, media, commercial.nom, dateValide)
    : db.prepare(`SELECT id FROM emissions WHERE statut='a_programmer' AND LOWER(TRIM(entreprise))=? AND media=? AND commercial=? AND notes LIKE '📌 BDC envoyé via DocuSign%'`)
        .get(entNorm, media, commercial.nom);
  if (existante) return { id: existante.id, statut: dateValide ? 'bdc_attente' : 'a_programmer', cree: false };

  const equipe = commercial.equipe_edito_id
    ? db.prepare('SELECT nom FROM equipes_edito WHERE id=?').get(commercial.equipe_edito_id)
    : null;
  const statutEm = dateValide ? 'bdc_attente' : 'a_programmer';
  const dateBdd = dateValide || new Date().toISOString().slice(0, 10); // provisoire (NOT NULL)
  const note = dateValide ? null
    : '📌 BDC envoyé via DocuSign — date de diffusion à caler (période libre ou jour non diffusable)';

  const r = db.prepare(`
    INSERT INTO emissions (entreprise,media,sous_media,date_diffusion,date_diffusion_originale,commercial,resp_edit,statut,montant,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(entreprise, media, sousMedia, dateBdd, dateBdd, commercial.nom, equipe ? equipe.nom : null,
         statutEm, Number(montantHT || 0), note);
  console.log(`[BDC-DOCUSIGN] créneau planning ${statutEm} id=${r.lastInsertRowid} — ${entreprise} / ${media} / ${dateValide || 'sans date'}`);
  return { id: r.lastInsertRowid, statut: statutEm, cree: true };
}

app.post('/api/bdc/docusign/send', requireCommercial, async (req, res) => {
  try {
    const signerEmail = String(req.body.signerEmail || '').trim();
    const signerName = String(req.body.signerName || req.body.contact || '').trim();
    if (!signerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(signerEmail)) {
      return res.status(400).json({ error: 'Email du signataire manquant ou invalide' });
    }
    if (!signerName) return res.status(400).json({ error: 'Nom du signataire manquant (champ Contact)' });
    if (!String(req.body.entreprise || '').trim()) return res.status(400).json({ error: 'Entreprise manquante' });

    // L'enveloppe part du compte DocuSign DU COMMERCIAL : on résout son userId
    // DocuSign depuis l'email de son compte planning (une fois, puis stocké).
    let senderUserId = req.commercial.docusign_user_id;
    if (!senderUserId) {
      try {
        senderUserId = await docusignSend.resolveDocuSignUserId(req.commercial.email);
        if (senderUserId) {
          db.prepare('UPDATE commercial_users SET docusign_user_id=? WHERE id=?').run(senderUserId, req.commercial.id);
        }
      } catch (e) {
        console.warn('[BDC-DOCUSIGN] résolution userId:', e.message);
      }
      if (!senderUserId) {
        return res.status(400).json({
          error: `Aucun compte DocuSign actif trouvé pour ${req.commercial.email}. Demande à Donatien de vérifier que tu as un accès DocuSign avec cet email.`,
        });
      }
    }

    const templateKey = req.body.templateKey || 'figaro-48h-hp';
    const pdf = await renderBdcPdf(templateKey, bdcFieldsFromInput(req.body));
    const { envelopeId, status } = await docusignSend.sendBdcEnvelope({
      pdfBuffer: pdf,
      entreprise: String(req.body.entreprise || '').trim(),
      signerName,
      signerEmail,
      message: String(req.body.signerMessage || '').trim() || undefined,
      senderUserId,
    });

    // Créneau jaune "BDC en attente" sur le planning de diffusion (dédupliqué).
    // Ne doit JAMAIS faire échouer l'envoi : le BDC est déjà parti chez DocuSign.
    let emission = { id: null, statut: null, cree: false };
    try {
      emission = upsertEmissionPourBdcEnvoye({
        entreprise: String(req.body.entreprise || '').trim(),
        templateKey,
        dateDiffusion: String(req.body.dateDiffusion || ''),
        montantHT: req.body.montantHT,
        commercial: req.commercial,
      });
    } catch (e) {
      console.warn('[BDC-DOCUSIGN] créneau planning non créé:', e.message);
    }

    db.prepare(`INSERT INTO bdc_envois (envelope_id, entreprise, contact, email, template, montant_ht, statut, docusign_status, commercial, sender_ds_user_id, emission_id, date_diffusion)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(envelopeId, String(req.body.entreprise || '').trim(), signerName, signerEmail,
           templateKey, Number(req.body.montantHT || 0), 'envoye', status || 'sent', req.commercial.nom, senderUserId, emission.id,
           String(req.body.dateDiffusion || '').trim() || null);
    console.log(`[BDC-DOCUSIGN] enveloppe ${envelopeId} envoyée par ${req.commercial.nom} (depuis son compte) — ${req.body.entreprise} → ${signerEmail}`);
    res.json({ ok: true, envelopeId, emission });
  } catch (e) {
    // Consentement individuel DocuSign pas encore accordé : le front affiche
    // le lien d'autorisation (à ouvrir une seule fois, connecté à SON DocuSign).
    if (e.code === 'CONSENT_REQUIRED') {
      return res.status(428).json({ error: 'consent_required', consentUrl: e.consentUrl });
    }
    console.error('[BDC-DOCUSIGN]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Liste des envois (le commercial voit les siens, l'édito/admin voit tout) +
// rafraîchissement à la demande des statuts encore "envoyé" (max 10 par appel
// pour rester raisonnable avec le rate limit DocuSign).
app.get('/api/bdc/docusign/envois', requireCommercial, async (req, res) => {
  const isPriv = req.headers.role === 'edit' || req.commercial.role === 'admin';
  const rows = isPriv
    ? db.prepare('SELECT * FROM bdc_envois ORDER BY created_at DESC LIMIT 100').all()
    : db.prepare('SELECT * FROM bdc_envois WHERE commercial=? ORDER BY created_at DESC LIMIT 100').all(req.commercial.nom);

  const upd = db.prepare("UPDATE bdc_envois SET statut=?, docusign_status=?, updated_at=datetime('now') WHERE id=?");
  let refreshed = 0;

  // Réparation : les envois sans emission_id (faits avant la création
  // automatique du créneau, ou dont la création a échoué — ex. bug du INSERT
  // à date NULL) se voient recréer leur créneau ici, de façon idempotente
  // grâce à la déduplication d'upsertEmissionPourBdcEnvoye.
  const updEmission = db.prepare('UPDATE bdc_envois SET emission_id=? WHERE id=?');
  for (const r of rows) {
    if (r.emission_id || !r.template || !r.entreprise) continue;
    try {
      const compte = db.prepare('SELECT * FROM commercial_users WHERE nom=?').get(r.commercial) || { nom: r.commercial };
      const em = upsertEmissionPourBdcEnvoye({
        entreprise: r.entreprise, templateKey: r.template,
        dateDiffusion: r.date_diffusion || '', montantHT: r.montant_ht, commercial: compte,
      });
      if (em.id) updEmission.run(em.id, r.id);
    } catch (e) {
      console.warn(`[BDC-DOCUSIGN] réparation créneau envoi ${r.id}: ${e.message}`);
    }
  }

  for (const r of rows) {
    if (r.statut !== 'envoye' || refreshed >= 10) continue;
    try {
      // Le statut se lit avec le token de l'expéditeur (c'est son enveloppe) ;
      // à défaut (anciens envois centralisés), avec le compte central.
      const { status } = await docusignSend.getEnvelopeStatus(r.envelope_id, r.sender_ds_user_id || undefined);
      const mapped = DS_STATUT_MAP[status] || r.statut;
      if (mapped !== r.statut || status !== r.docusign_status) upd.run(mapped, status, r.id);
      r.statut = mapped; r.docusign_status = status;
      refreshed++;
    } catch (e) {
      console.warn(`[BDC-DOCUSIGN] refresh enveloppe ${r.envelope_id}: ${e.message}`);
    }
  }
  res.json(rows);
});

// ── EMISSIONS - LECTURE ───────────────────────────────────────────────────────
app.get('/api/emissions', (req, res) => {
  const { media, mois, annee, search, statut, resp_edit } = req.query;
  if (req.headers.role !== 'edit' && mois && annee) {
    const horizonMois = getHorizonMois();
    const maxDate = new Date(); maxDate.setMonth(maxDate.getMonth() + horizonMois);
    const reqDate = new Date(`${annee}-${String(mois).padStart(2,'0')}-01`);
    if (reqDate > maxDate) return res.json([]);
  }
  let query = "SELECT * FROM emissions WHERE 1=1";
  const params = [];
  // Par défaut, les "à programmer" n'apparaissent pas dans la grille (sauf demande explicite via ?statut=a_programmer)
  if (!statut) { query += " AND statut != 'a_programmer'"; }
  if (media)  { query += ' AND media=?'; params.push(media); }
  if (mois && annee) { query += " AND strftime('%Y-%m',date_diffusion)=?"; params.push(`${annee}-${String(mois).padStart(2,'0')}`); }
  if (search) { query += ' AND (entreprise LIKE ? OR secteur LIKE ?)'; params.push(`%${search}%`,`%${search}%`); }
  if (statut) { query += ' AND statut=?'; params.push(statut); }
  if (resp_edit) { query += resp_edit === '_none' ? ' AND (resp_edit IS NULL OR resp_edit=\'\')' : ' AND resp_edit=?'; if(resp_edit!=='_none') params.push(resp_edit); }
  query += ' ORDER BY date_diffusion ASC, media ASC';
  res.json(db.prepare(query).all(...params));
});

// ── ALERTE "À ASSIGNER EN RETARD" ─────────────────────────────────────────────
app.get('/api/emissions/alerte-retard', (req, res) => {
  const limite = new Date(); limite.setDate(limite.getDate() + 5);
  const fmt = d => d.toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT * FROM emissions
    WHERE statut NOT IN ('annule','a_programmer')
      AND (resp_edit IS NULL OR resp_edit='')
      AND date_diffusion <= ?
    ORDER BY date_diffusion ASC
  `).all(fmt(limite));
  res.json(rows);
});

// ── EMISSIONS - "À PROGRAMMER" (média ambigu ou date de diffusion manquante côté SF) ──
app.get('/api/a-programmer', (req, res) => {
  const { resp_edit } = req.query;
  let query = "SELECT * FROM emissions WHERE statut='a_programmer'";
  const params = [];
  if (resp_edit) {
    query += resp_edit === '_none' ? " AND (resp_edit IS NULL OR resp_edit='')" : ' AND resp_edit=?';
    if (resp_edit !== '_none') params.push(resp_edit);
  }
  query += ' ORDER BY entreprise ASC';
  res.json(db.prepare(query).all(...params));
});

// Notif perso "à programmer" (utilisée pour le badge/popup in-app d'Eva et Flavie)
app.get('/api/a-programmer/perso', (req, res) => {
  const { nom } = req.query;
  if (!nom) return res.status(400).json({ error: 'nom requis' });
  const assignees = db.prepare(`SELECT * FROM emissions WHERE statut='a_programmer' AND resp_edit=? ORDER BY entreprise ASC`).all(nom);
  const nonAssignees = db.prepare(`SELECT * FROM emissions WHERE statut='a_programmer' AND (resp_edit IS NULL OR resp_edit='') ORDER BY entreprise ASC`).all();
  res.json({ assignees, nonAssignees });
});

// Notif "C-level" : répartition "à programmer" par personne (Flavie/Eva/Lola)
app.get('/api/a-programmer/clevel', (req, res) => {
  const noms = ['Flavie', 'Eva', 'Lola'];
  const out = {};
  for (const nom of noms) {
    out[nom] = db.prepare(`SELECT * FROM emissions WHERE statut='a_programmer' AND resp_edit=? ORDER BY entreprise ASC`).all(nom);
  }
  res.json(out);
});

app.get('/api/emissions/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM emissions WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Non trouvé' });
  res.json(e);
});

app.get('/api/slots', (req, res) => {
  const { media, mois, annee } = req.query;
  let query = `SELECT date_diffusion,media,COUNT(*) as utilises FROM emissions WHERE statut NOT IN ('annule','a_programmer')`;
  const params = [];
  if (media) { query += ' AND media=?'; params.push(media); }
  if (mois && annee) { query += " AND strftime('%Y-%m',date_diffusion)=?"; params.push(`${annee}-${String(mois).padStart(2,'0')}`); }
  query += ' GROUP BY date_diffusion,media';
  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({ ...r, total: SLOTS_PAR_MEDIA[r.media]||99, complet: r.utilises>=(SLOTS_PAR_MEDIA[r.media]||99) })));
});

// ── EMISSIONS - ÉDITION ───────────────────────────────────────────────────────
app.patch('/api/emissions/:id', (req, res) => {
  if (req.headers.role !== 'edit') return res.status(403).json({ error: 'Accès refusé' });
  const { date_diffusion, resp_edit, notes, homepage, homepage_eco, statut, secteur, format, montant, upsell, media, entreprise, commercial } = req.body;
  const sous_media = req.body.sous_media;
  const id = req.params.id;
  const e = db.prepare('SELECT * FROM emissions WHERE id=?').get(id);
  if (!e) return res.status(404).json({ error: 'Non trouvé' });
  if (media && !MEDIAS.includes(media)) return res.status(400).json({ error: `Média inconnu: ${media}` });
  if (entreprise !== undefined && !entreprise.trim()) return res.status(400).json({ error: 'Entreprise ne peut pas être vide' });

  const alertes = [];
  const newDate = date_diffusion || e.date_diffusion;
  const newMedia = media || e.media;

  // Garde-fou jours de diffusion (lun/mer/ven uniquement) : une nouvelle date
  // tombant un mardi/jeudi/week-end n'est PAS appliquée — la diffusion est
  // renvoyée vers "à programmer" avec une alerte explicite.
  let forceAProgrammer = false;
  if (date_diffusion && date_diffusion !== e.date_diffusion) {
    const jourKO = jourNonDiffusable(date_diffusion);
    if (jourKO) {
      alertes.push(`📌 Un ${jourKO} n'est pas un jour de diffusion (lun/mer/ven uniquement) — la diffusion a été renvoyée vers « À programmer »`);
      forceAProgrammer = true;
    }
  }

  // Sous-média : validé si fourni, et forcé à null si le média parent change vers autre chose que "Médias spécialisés"
  const clearSousMedia = media && newMedia !== 'Médias spécialisés';
  let touchSousMedia = 0, sousMediaVal = null;
  if (clearSousMedia) {
    touchSousMedia = 1; sousMediaVal = null;
  } else if (sous_media !== undefined) {
    const check = resolveSousMedia(newMedia, sous_media || null);
    if (check.error) return res.status(400).json({ error: check.error });
    touchSousMedia = 1; sousMediaVal = check.sousMedia;
  }

  if ((date_diffusion && date_diffusion !== e.date_diffusion) || (media && media !== e.media)) {
    const slots = SLOTS_PAR_MEDIA[newMedia];
    if (slots < 99) {
      const count = db.prepare(`SELECT COUNT(*) as n FROM emissions WHERE date_diffusion=? AND media=? AND statut!='annule' AND id!=?`).get(newDate, newMedia, id);
      if (count.n >= slots) alertes.push(`⚠️ Slots complets pour ${newMedia} le ${newDate}`);
    }
  }

  const newHp = homepage !== undefined ? homepage : e.homepage;
  const newHpEco = homepage_eco !== undefined ? homepage_eco : e.homepage_eco;
  if (newHp || newHpEco) {
    const conflict = db.prepare(`SELECT entreprise FROM emissions WHERE date_diffusion=? AND media=? AND (homepage=1 OR homepage_eco=1) AND statut!='annule' AND id!=?`).all(newDate, newMedia, id);
    if (conflict.length) alertes.push(`⚠️ Homepage déjà occupée: ${conflict.map(x=>x.entreprise).join(', ')}`);
  }

  db.prepare(`UPDATE emissions SET
    date_diffusion=COALESCE(?,date_diffusion), resp_edit=COALESCE(?,resp_edit),
    notes=COALESCE(?,notes), homepage=COALESCE(?,homepage), homepage_eco=COALESCE(?,homepage_eco),
    statut=COALESCE(?,statut), secteur=COALESCE(?,secteur), format=COALESCE(?,format),
    montant=COALESCE(?,montant), upsell=COALESCE(?,upsell), media=COALESCE(?,media),
    entreprise=COALESCE(?,entreprise), commercial=COALESCE(?,commercial),
    sous_media=CASE WHEN ?=1 THEN ? ELSE sous_media END,
    updated_at=datetime('now') WHERE id=?
  `).run(forceAProgrammer ? null : (date_diffusion||null), resp_edit||null, notes||null,
    homepage!==undefined?(homepage?1:0):null, homepage_eco!==undefined?(homepage_eco?1:0):null,
    forceAProgrammer ? 'a_programmer' : (statut||null), secteur||null, format||null, montant!==undefined?montant:null, upsell!==undefined?upsell:null, media||null,
    entreprise||null, commercial||null, touchSousMedia, sousMediaVal, id);

  res.json({ success: true, alertes });
});

app.delete('/api/emissions/:id', (req, res) => {
  if (req.headers.role !== 'edit') return res.status(403).json({ error: 'Accès refusé' });
  db.prepare("UPDATE emissions SET statut='annule',updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// Suppression définitive (hard delete) — distincte de l'annulation (statut='annule').
// L'annulation garde une trace ; ceci l'efface complètement de la base. Édito uniquement.
app.delete('/api/emissions/:id/hard', (req, res) => {
  if (req.headers.role !== 'edit') return res.status(403).json({ error: 'Accès refusé' });
  const e = db.prepare('SELECT * FROM emissions WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Non trouvé' });
  db.prepare('DELETE FROM emissions WHERE id=?').run(req.params.id);
  console.log(`[HARD-DELETE] id=${req.params.id} "${e.entreprise}" (${e.media}, ${e.date_diffusion}) supprimée définitivement`);
  res.json({ success: true });
});

// ── JOURS BLOQUÉS ─────────────────────────────────────────────────────────────
app.get('/api/jours-bloques', (req, res) => res.json(db.prepare('SELECT * FROM jours_bloques ORDER BY date ASC').all()));

app.post('/api/jours-bloques', (req, res) => {
  if (req.headers.role !== 'edit') return res.status(403).json({ error: 'Accès refusé' });
  const { date, media, raison } = req.body;
  const r = db.prepare('INSERT INTO jours_bloques (date,media,raison) VALUES (?,?,?)').run(date, media||null, raison||null);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.delete('/api/jours-bloques/:id', (req, res) => {
  if (req.headers.role !== 'edit') return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM jours_bloques WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── REPORTING ─────────────────────────────────────────────────────────────────
app.get('/api/reporting', (req, res) => {
  const { mois, annee, debut, fin } = req.query;

  let where = "statut NOT IN ('annule','bdc_attente','a_programmer')";
  const params = [];
  let period = null;

  if (debut && fin) {
    where += " AND date_diffusion >= ? AND date_diffusion <= ?";
    params.push(debut, fin);
    period = `${debut}_${fin}`;
  } else if (mois && annee) {
    period = `${annee}-${String(mois).padStart(2,'0')}`;
    where += " AND strftime('%Y-%m',date_diffusion)=?";
    params.push(period);
  }

  const byMedia = db.prepare(`
    SELECT media,
      COUNT(*) as nb_emissions,
      SUM(montant) as ca_diffusion,
      SUM(IFNULL(upsell,0)) as ca_upsell,
      COUNT(CASE WHEN statut='confirme' THEN 1 END) as nb_confirme
    FROM emissions WHERE ${where}
    GROUP BY media ORDER BY (SUM(montant) + SUM(IFNULL(upsell,0))) DESC
  `).all(...params);

  const total = byMedia.reduce((a,b) => ({
    nb: a.nb+(b.nb_emissions||0),
    caDiffusion: a.caDiffusion+(b.ca_diffusion||0),
    caUpsell: a.caUpsell+(b.ca_upsell||0)
  }), { nb:0, caDiffusion:0, caUpsell:0 });

  res.json({ byMedia, total, period });
});

app.get('/api/reporting/semaine', (req, res) => {
  // Cette semaine Lun/Mer/Ven
  const today = new Date();
  const dow = today.getDay() || 7;
  const lundi = new Date(today); lundi.setDate(today.getDate() - (dow - 1));
  const vendredi = new Date(lundi); vendredi.setDate(lundi.getDate() + 4);
  const fmt = d => d.toISOString().slice(0,10);

  const emissions = db.prepare(`
    SELECT * FROM emissions
    WHERE date_diffusion >= ? AND date_diffusion <= ? AND statut NOT IN ('annule','a_programmer')
    ORDER BY date_diffusion ASC, media ASC
  `).all(fmt(lundi), fmt(vendredi));

  res.json({ emissions, semaine_debut: fmt(lundi), semaine_fin: fmt(vendredi) });
});

// ── META ──────────────────────────────────────────────────────────────────────
app.get('/api/meta', (req, res) => res.json({ medias: MEDIAS, slots: SLOTS_PAR_MEDIA, formats: FORMATS_PAR_MEDIA, horizonMois: getHorizonMois(), sousMediasSpecialises: SOUS_MEDIAS_SPECIALISES, sousMediasListe: SOUS_MEDIAS_LIST, channels: CHANNELS, socialPostStatuses: SOCIAL_POST_STATUSES, financeInternalStatuses: FINANCE_INTERNAL_STATUSES }));

// ── RÉTROPLANNING COMMUNICATION (nouveau projet, v1) ─────────────────────────
// Calendrier de posts à publier (Instagram/LinkedIn/YouTube/Newsletter),
// séparé des "emissions" (diffusion radio/TV) : simple liste avec statut,
// consultable/éditable par édito + communication (requireContentTeam),
// lecture seule pour le reste (pas de restriction en lecture pour l'instant,
// cohérent avec /api/emissions qui n'exige pas non plus de rôle précis).
app.get('/api/social-posts', (req, res) => {
  res.json(db.prepare('SELECT * FROM social_posts ORDER BY scheduled_date ASC').all());
});

// Un post peut viser plusieurs réseaux à la fois (ex: même visuel posté sur
// Instagram ET LinkedIn) — stocké en une seule colonne TEXT "channel" avec les
// canaux séparés par virgule ("Instagram,LinkedIn"), plutôt qu'une table de
// jointure séparée : plus simple pour ce volume, cohérent avec le style du
// reste du fichier (pas de sur-ingénierie pour une v1).
function parseChannels(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(arr.map((c) => String(c).trim()).filter((c) => CHANNELS.includes(c)))];
}

app.post('/api/social-posts', requireContentTeam, (req, res) => {
  const channels = parseChannels(req.body.channel);
  const title = String(req.body.title || '').trim();
  const scheduledDate = String(req.body.scheduledDate || '').trim();
  const notes = req.body.notes ? String(req.body.notes).trim() : null;
  const assignedTo = req.body.assignedTo ? String(req.body.assignedTo).trim() : null;
  const driveLink = req.body.driveLink ? String(req.body.driveLink).trim() : null;
  // Image de preview envoyée en data URL base64 (ex: "data:image/jpeg;base64,...")
  // — compressée côté client avant envoi, voir imageDataUrlFromFile() dans le front.
  const imageData = req.body.imageData ? String(req.body.imageData) : null;
  const status = SOCIAL_POST_STATUSES.includes(req.body.status) ? req.body.status : 'a_faire';
  if (!channels.length) return res.status(400).json({ error: 'Sélectionne au moins un canal' });
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  if (!scheduledDate) return res.status(400).json({ error: 'Date requise' });
  const r = db.prepare(
    'INSERT INTO social_posts (channel, title, notes, scheduled_date, status, assigned_to, drive_link, image_data) VALUES (?,?,?,?,?,?,?,?)'
  ).run(channels.join(','), title, notes, scheduledDate, status, assignedTo, driveLink, imageData);
  res.status(201).json(db.prepare('SELECT * FROM social_posts WHERE id=?').get(r.lastInsertRowid));
});

app.patch('/api/social-posts/:id', requireContentTeam, (req, res) => {
  const post = db.prepare('SELECT * FROM social_posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post introuvable' });
  const channels = req.body.channel !== undefined ? parseChannels(req.body.channel) : parseChannels(post.channel);
  const status = req.body.status !== undefined ? req.body.status : post.status;
  if (!channels.length) return res.status(400).json({ error: 'Sélectionne au moins un canal' });
  if (!SOCIAL_POST_STATUSES.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  db.prepare(`
    UPDATE social_posts SET
      channel=?, title=COALESCE(?,title), notes=?, scheduled_date=COALESCE(?,scheduled_date),
      status=?, assigned_to=?, drive_link=?, image_data=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    channels.join(','),
    req.body.title !== undefined ? String(req.body.title).trim() : null,
    req.body.notes !== undefined ? String(req.body.notes).trim() : post.notes,
    req.body.scheduledDate !== undefined ? String(req.body.scheduledDate).trim() : null,
    status,
    req.body.assignedTo !== undefined ? String(req.body.assignedTo).trim() : post.assigned_to,
    req.body.driveLink !== undefined ? String(req.body.driveLink).trim() : post.drive_link,
    req.body.imageData !== undefined ? (req.body.imageData ? String(req.body.imageData) : null) : post.image_data,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM social_posts WHERE id=?').get(req.params.id));
});

app.delete('/api/social-posts/:id', requireContentTeam, (req, res) => {
  db.prepare('DELETE FROM social_posts WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── BOÎTE À IDÉES (v1) ────────────────────────────────────────────────────────
// Idées de posts pas encore datées : panneau latéral du rétroplanning, sur le
// même principe que "à programmer" (calendrier diffusion) — on glisse une
// carte sur un jour du calendrier social pour la transformer en social_posts
// (voir openCreateSocialPostModal côté front), puis l'idée est supprimée ici.
// Même accès que social_posts : requireContentTeam en écriture, lecture ouverte.
app.get('/api/social-ideas', (req, res) => {
  res.json(db.prepare('SELECT * FROM social_ideas ORDER BY created_at DESC').all());
});

app.post('/api/social-ideas', requireContentTeam, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  const channels = parseChannels(req.body.channel);
  const notes = req.body.notes ? String(req.body.notes).trim() : null;
  const r = db.prepare(
    'INSERT INTO social_ideas (title, channel, notes) VALUES (?,?,?)'
  ).run(title, channels.join(',') || null, notes);
  res.status(201).json(db.prepare('SELECT * FROM social_ideas WHERE id=?').get(r.lastInsertRowid));
});

app.patch('/api/social-ideas/:id', requireContentTeam, (req, res) => {
  const existing = db.prepare('SELECT * FROM social_ideas WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Idée introuvable' });
  const title = req.body.title !== undefined ? String(req.body.title).trim() : existing.title;
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  const channels = req.body.channel !== undefined ? parseChannels(req.body.channel) : null;
  const channel = channels !== null ? (channels.join(',') || null) : existing.channel;
  const notes = req.body.notes !== undefined ? (String(req.body.notes).trim() || null) : existing.notes;
  db.prepare('UPDATE social_ideas SET title=?, channel=?, notes=? WHERE id=?').run(title, channel, notes, req.params.id);
  res.json(db.prepare('SELECT * FROM social_ideas WHERE id=?').get(req.params.id));
});

app.delete('/api/social-ideas/:id', requireContentTeam, (req, res) => {
  db.prepare('DELETE FROM social_ideas WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Comptes "communication" pour l'assignation des posts — avant, le champ
// "Assigné à" réutilisait RESP_EDIT_LIST (l'équipe édito, pour l'assignation
// des ÉMISSIONS), ce qui n'a aucun rapport avec qui doit publier un post
// réseaux sociaux. On expose ici les comptes role='communication' actifs.
app.get('/api/social-team', requireContentTeam, (req, res) => {
  res.json(db.prepare(
    "SELECT id, nom FROM commercial_users WHERE role='communication' AND actif=1 ORDER BY nom ASC"
  ).all());
});

// ── RECOUVREMENT / PENNYLANE (nouveau projet) ────────────────────────────────
// Toutes les routes /api/finance/* (factures, KPI, relances, commentaires,
// échéances personnalisées + statuts configurables) vivent dans ce module
// dédié, plutôt qu'en ligne ici — plus lisible, et surtout : évite la
// duplication qu'il y avait avant (une ancienne copie de ces routes était
// restée en dur dans ce fichier après l'extraction vers financeRoutes.js,
// et comme Express prend toujours le PREMIER handler enregistré sur une
// route, c'était cette vieille copie — sans les échéances/statuts
// personnalisés — qui répondait réellement, jamais la nouvelle).
require('./financeRoutes')(app, { db, pennylane, requireFinance, FINANCE_INTERNAL_STATUSES });

// ── SEED ──────────────────────────────────────────────────────────────────────
const seedFile = path.join(__dirname, 'seed_excel.sql');
const seedDone = db.prepare("SELECT COUNT(*) as n FROM emissions").get();
if (seedDone.n === 0 && fs.existsSync(seedFile)) {
  try { db.exec(fs.readFileSync(seedFile, 'utf8')); console.log('✅ Seed Excel importé'); }
  catch(e) { console.error('Seed error:', e.message); }
}

// ── ADMIN - RESEED (remplacement complet depuis seed_excel.sql) ───────────────
// Protégé par le même secret que le webhook SF. Écrase toutes les émissions.
app.post('/api/admin/reseed', (req, res) => {
  const secret = req.headers['x-sf-secret'];
  if (secret !== SF_WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!fs.existsSync(seedFile)) return res.status(404).json({ error: 'seed_excel.sql introuvable' });
  try {
    db.exec(fs.readFileSync(seedFile, 'utf8'));
    const count = db.prepare("SELECT COUNT(*) as n FROM emissions").get();
    res.json({ success: true, total_emissions: count.n });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// (plus de app.listen ici — le router est monté par le host OpenDashboard)

// ── ADMIN - PARAMÈTRES ─────────────────────────────────────────────────────────
app.get('/api/admin/settings', requireEdit, (req, res) => {
  res.json({ horizonMois: getHorizonMois() });
});
app.post('/api/admin/settings', requireEdit, (req, res) => {
  const horizonMois = parseInt(req.body.horizonMois, 10);
  if (!horizonMois || horizonMois < 1 || horizonMois > 24) return res.status(400).json({ error: 'Valeur invalide (1 à 24 mois)' });
  db.prepare(`INSERT INTO config (key,value) VALUES ('horizon_mois',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(horizonMois));
  res.json({ success: true, horizonMois });
});

// ── ADMIN - ÉQUIPES ÉDITO ────────────────────────────────────────────────────
app.get('/api/admin/equipes', requireEdit, (req, res) => {
  res.json(db.prepare('SELECT * FROM equipes_edito ORDER BY nom ASC').all());
});
app.post('/api/admin/equipes', requireEdit, (req, res) => {
  const nom = String(req.body.nom || '').trim();
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  try {
    const r = db.prepare('INSERT INTO equipes_edito (nom) VALUES (?)').run(nom);
    res.status(201).json({ id: r.lastInsertRowid, nom });
  } catch (e) {
    res.status(400).json({ error: 'Cette équipe existe déjà' });
  }
});
app.delete('/api/admin/equipes/:id', requireEdit, (req, res) => {
  db.prepare('UPDATE commercial_users SET equipe_edito_id=NULL WHERE equipe_edito_id=?').run(req.params.id);
  db.prepare('DELETE FROM equipes_edito WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── ADMIN - SALESFORCE : liste des commerciaux à rattacher ────────────────────
app.get('/api/admin/salesforce-commerciaux', requireEdit, async (req, res) => {
  try {
    const commerciaux = await salesforce.getCommerciaux();
    res.json(commerciaux);
  } catch (e) {
    console.error('[SF-COMMERCIAUX]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN - COMPTES COMMERCIAUX ───────────────────────────────────────────────
const VALID_ROLES = ['commercial', 'manager', 'edito', 'communication', 'finance', 'admin'];

app.get('/api/admin/commerciaux', requireEdit, (req, res) => {
  res.json(db.prepare(`
    SELECT cu.id, cu.email, cu.nom, cu.actif, cu.is_admin, cu.role, cu.team_id,
           cu.equipe_edito_id, e.nom as equipe_nom, st.label as team_label
    FROM commercial_users cu
    LEFT JOIN equipes_edito e ON e.id = cu.equipe_edito_id
    LEFT JOIN sales_teams st ON st.id = cu.team_id
    ORDER BY cu.nom ASC
  `).all());
});

// ── ÉQUIPES DE VENTE (rôle manager) ───────────────────────────────────────────
app.get('/api/admin/sales-teams', requireEdit, (req, res) => {
  res.json(salesTeams.listSalesTeams());
});
app.post('/api/admin/sales-teams', requireEdit, (req, res) => {
  try {
    const { label, managerId, memberIds } = req.body;
    res.status(201).json(salesTeams.createSalesTeam(label, managerId || null, Array.isArray(memberIds) ? memberIds : []));
  }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.patch('/api/admin/sales-teams/:id', requireEdit, (req, res) => {
  try {
    const { label, managerId, memberIds } = req.body;
    res.json(salesTeams.updateSalesTeam(req.params.id, {
      label,
      managerId: managerId === undefined ? undefined : (managerId || null),
      memberIds: Array.isArray(memberIds) ? memberIds : undefined,
    }));
  }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.delete('/api/admin/sales-teams/:id', requireEdit, (req, res) => {
  try { salesTeams.deleteSalesTeam(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// Génère un token d'invitation (7 jours de validité) et envoie le mail
// "définis ton mot de passe" au commercial, via le mailer Mailjet déjà en place
// (backend/reports.js). Réutilisé à la création du compte et pour un renvoi manuel.
function envoyerInvitation(req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE commercial_users SET reset_token=?, reset_token_expires=? WHERE id=?').run(token, expires, user.id);
  // Depuis la fusion, le planning est servi sous /planning (plus à la racine
  // du domaine) — le lien d'invitation doit pointer vers /planning/?invite=...
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const lien = `${baseUrl}/planning/?invite=${token}`;
  const prenom = user.nom.split(' ')[0];
  const html = `
  <div style="background:#f3f4f6;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
    <table role="presentation" style="max-width:480px;width:100%;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
      <tr>
        <td style="background:#2563EB;padding:28px 32px">
          <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.3px">Planning <span style="font-weight:400;opacity:0.85">Diffusion</span></div>
          <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#bfdbfe;font-weight:700;margin-top:4px">OpenMedias</div>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 32px 8px;color:#111827">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6">Bonjour ${prenom},</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6">
            Un compte commercial vient d'être créé pour toi sur le planning de diffusion.
            Il ne reste qu'une étape : choisir ton mot de passe pour y accéder.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 32px;text-align:center">
          <a href="${lien}" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 28px;border-radius:9px">
            Définir mon mot de passe
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 28px">
          <div style="height:1px;background:#e5e7eb;margin-bottom:20px"></div>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af">
            Ce lien est valable 7 jours et ne peut être utilisé qu'une seule fois.
            Si tu n'es pas à l'origine de cette demande, tu peux ignorer cet email sans risque.
          </p>
        </td>
      </tr>
    </table>
  </div>`;
  reports.sendMailOnly(`Bienvenue sur le planning OpenMedias — définis ton mot de passe`, html, [user.email])
    .catch((e) => console.error('[INVITATION] échec envoi email:', e.message));
}

app.post('/api/admin/commerciaux', requireEdit, (req, res) => {
  const nom = String(req.body.nom || '').trim();
  const email = String(req.body.email || '').toLowerCase().trim();
  const equipe_edito_id = req.body.equipe_edito_id || null;
  const sf_user_id = req.body.sf_user_id || null;
  const team_id = req.body.team_id || null;
  // role : commercial (défaut, ses seuls chiffres) | manager (chiffres de son
  // équipe) | edito | communication (pas d'accès dashboard) | admin (tout voir).
  const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'commercial';
  // is_admin conservé pour compat ascendante (anciens comptes) — équivalent à role='admin'.
  const is_admin = role === 'admin' ? 1 : (req.body.is_admin ? 1 : 0);
  if (!nom || !email) return res.status(400).json({ error: 'Nom et email requis' });
  try {
    // Mot de passe temporaire aléatoire et inconnu de tous : le commercial le remplace
    // via le lien reçu par email avant de pouvoir se connecter.
    const placeholder = crypto.randomBytes(32).toString('hex');
    const r = db.prepare(`INSERT INTO commercial_users (email,password_hash,nom,sf_user_id,equipe_edito_id,is_admin,role,team_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(email, hashPassword(placeholder), nom, sf_user_id, equipe_edito_id, is_admin, role, team_id);
    const user = { id: r.lastInsertRowid, nom, email };
    envoyerInvitation(req, user);
    res.status(201).json({ id: r.lastInsertRowid, invitationEnvoyee: true });
  } catch (e) {
    res.status(400).json({ error: 'Un compte existe déjà avec cet email' });
  }
});

// Renvoie l'email d'invitation (ex: le premier est resté sans réponse, ou perdu).
app.post('/api/admin/commerciaux/:id/resend-invite', requireEdit, (req, res) => {
  const user = db.prepare('SELECT * FROM commercial_users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Compte introuvable' });
  envoyerInvitation(req, user);
  res.json({ success: true });
});
app.patch('/api/admin/commerciaux/:id', requireEdit, (req, res) => {
  const { equipe_edito_id, actif, password, is_admin, role, team_id } = req.body;
  if (role !== undefined && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Rôle invalide (attendu: ${VALID_ROLES.join(', ')})` });
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères minimum)' });
    db.prepare('UPDATE commercial_users SET password_hash=? WHERE id=?').run(hashPassword(password), req.params.id);
  }
  // Si le rôle change, is_admin (ancien flag, conservé pour compat) SUIT le
  // rôle explicitement — sinon un compte rétrogradé depuis 'admin' garderait
  // is_admin=1 en mémoire et conserverait un accès admin fantôme.
  const isAdminFinal = role !== undefined ? (role === 'admin' ? 1 : 0) : (is_admin !== undefined ? (is_admin ? 1 : 0) : null);
  db.prepare(`UPDATE commercial_users SET
    equipe_edito_id = CASE WHEN ? THEN ? ELSE equipe_edito_id END,
    actif = COALESCE(?, actif),
    is_admin = COALESCE(?, is_admin),
    role = COALESCE(?, role),
    team_id = CASE WHEN ? THEN ? ELSE team_id END
    WHERE id=?`
  ).run(
    equipe_edito_id !== undefined ? 1 : 0, equipe_edito_id || null,
    actif !== undefined ? (actif ? 1 : 0) : null,
    isAdminFinal,
    role !== undefined ? role : null,
    team_id !== undefined ? 1 : 0, team_id || null,
    req.params.id
  );
  res.json({ success: true });
});
app.delete('/api/admin/commerciaux/:id', requireEdit, (req, res) => {
  db.prepare('DELETE FROM commercial_users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── REPORTING AUTOMATIQUE ───────────────────────────────────────────────────
const reports = setupReports(db);

// ── SYNCHRONISATION PENNYLANE AUTOMATIQUE (recouvrement) ───────────────────
// Voir le projet Claude "OpenMedias Dashboard", doc
// claude/prompt-dev-synchro-recouvrement.md, pour le détail des décisions
// (demande Lina 09/2026, "0 risque de suppression", check quasi instantané
// sans toucher à quelles factures/clients sont lus). Deux mécanismes
// complémentaires :
// (1) check rapide ~20s — ne relit JAMAIS l'ensemble des factures, voir
//     pennylane.js/syncInvoiceChanges (changelog Pennylane, curseur mémorisé
//     dans la table config) ;
// (2) synchro complète de secours — tous les dimanches à 3h, SEULEMENT si
//     la dernière synchro complète (manuelle OU automatique) date de plus
//     de 13 jours (marge sous la limite de 4 semaines d'historique du
//     changelog Pennylane) — voir pennylane.js/syncFinance, marqueur
//     'pennylane_last_full_sync_at'. Un échec un dimanche se retente donc
//     automatiquement le dimanche suivant (le marqueur n'a pas bougé).
//     Alerte email à Lina en cas d'échec.
// Le bouton manuel "Synchroniser Pennylane" (POST /api/finance/sync, voir
// financeRoutes.js) reste INCHANGÉ — il continue d'appeler syncFinance
// directement, et sert désormais de filet de secours manuel si jamais
// l'automatisation du dimanche est en panne.
if (!process.env.PENNYLANE_API_TOKEN) {
  console.warn('⚠️ PENNYLANE_API_TOKEN absent — check rapide et synchro complète automatique de recouvrement désactivés (le bouton manuel restera aussi en erreur tant que la variable n\'est pas configurée)');
} else {
  let pennylaneChangesRunning = false;
  setInterval(() => {
    if (pennylaneChangesRunning) return; // ne jamais chevaucher deux ticks si un appel précédent traîne
    pennylaneChangesRunning = true;
    pennylane.syncInvoiceChanges(db)
      .catch((e) => console.error('[PENNYLANE][CHANGES] tick en échec :', e.message))
      .finally(() => { pennylaneChangesRunning = false; });
  }, 20 * 1000);

  cronBdc.schedule('0 3 * * 0', async () => {
    const row = db.prepare("SELECT value FROM config WHERE key='pennylane_last_full_sync_at'").get();
    const lastAt = row ? new Date(row.value) : null;
    const daysSince = lastAt && !Number.isNaN(lastAt.getTime()) ? (Date.now() - lastAt.getTime()) / 86400000 : Infinity;
    if (daysSince < 13) {
      console.log(`[PENNYLANE][SYNC COMPLET AUTO] sautée — dernière synchro complète il y a ${daysSince.toFixed(1)} j (<13)`);
      return;
    }
    try {
      const result = await pennylane.syncFinance(db);
      console.log(`[PENNYLANE][SYNC COMPLET AUTO] OK — ${result.invoicesSynced} facture(s), ${result.customersSynced} client(s)`);
    } catch (e) {
      console.error('[PENNYLANE][SYNC COMPLET AUTO] échec :', e.message);
      reports.sendMailOnly(
        '⚠️ Échec de la synchro Pennylane automatique',
        `<p>La synchro complète automatique de recouvrement (dimanche) a échoué :</p><pre>${e.message}</pre><p>Le bouton manuel "Synchroniser Pennylane" reste disponible en attendant. Elle sera retentée automatiquement dimanche prochain. Si ça se reproduit plusieurs dimanches de suite, le check rapide risque d'approcher la limite des 4 semaines d'historique côté Pennylane.</p>`,
        ['lina.e@openmedias.fr']
      );
    }
  }, { timezone: 'Europe/Paris' });

  console.log('🔄 Synchro Pennylane automatique configurée (check ~20s + synchro complète dimanche si >13j)');
}


// Déclenchement manuel pour test (protégé par le secret SF OU par le rôle édito depuis l'app)
// POST /api/admin/test-report  body: { "type": "mensuel" | "hebdo" | "apercu" | "kickoff" | "aprogrammer" | "clevel" | "relances" }
app.post('/api/admin/test-report', (req, res) => {
  const secret = req.headers['x-sf-secret'];
  const isEditRole = req.headers.role === 'edit';
  if (secret !== SF_WEBHOOK_SECRET && !isEditRole) return res.status(403).json({ error: 'Unauthorized' });
  const type = req.body.type;
  // force:true — le déclenchement manuel de test doit pouvoir renvoyer un
  // rapport même si la déduplication anti-doublon l'a déjà marqué "envoyé".
  const map = {
    mensuel: () => reports.reportMensuel({ force: true }),
    hebdo: () => reports.reportHebdo({ force: true }),
    apercu: () => reports.reportApercuMoisSuivant({ force: true }),
    kickoff: () => reports.reportKickoffLundi({ force: true }),
    aprogrammer: () => reports.reportAProgrammerLundi({ force: true }),
    clevel: () => reports.reportAProgrammerClevel({ force: true }),
    relances: () => reports.reportRelancesQuotidien({ force: true })
  };
  if (!map[type]) return res.status(400).json({ error: 'type invalide (mensuel|hebdo|apercu|kickoff|aprogrammer|clevel|relances)' });
  map[type]();
  res.json({ success: true, message: `Rapport "${type}" déclenché, vérifie ta boîte mail` });
});

// ── ALERTE BDC EN ATTENTE > 5 JOURS OUVRÉS ────────────────────────────────────
function joursOuvresDepuis(dateStr) {
  const start = new Date(dateStr); start.setHours(0,0,0,0);
  const today = new Date(); today.setHours(0,0,0,0);
  let n = 0;
  const d = new Date(start);
  while (d < today) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

function checkBdcEnRetard() {
  const rows = db.prepare(`SELECT * FROM emissions WHERE statut='bdc_attente'`).all();
  for (const e of rows) {
    const dateRef = (e.created_at || e.date_diffusion_originale || e.date_diffusion || '').slice(0, 10);
    if (!dateRef) continue;
    const jours = joursOuvresDepuis(dateRef);
    if (jours < 5) continue;

    const commercial = e.commercial ? db.prepare('SELECT email FROM commercial_users WHERE nom=? AND actif=1').get(e.commercial) : null;
    const extra = commercial && commercial.email ? [commercial.email] : [];

    const html = `<h2>⏰ BDC en attente depuis ${jours} jours ouvrés</h2>
      <p><b>${e.entreprise}</b> — ${e.media} — bloqué par <b>${e.commercial || 'commercial inconnu'}</b>${e.date_diffusion ? ' pour le ' + e.date_diffusion : ''}.</p>
      <p>Merci de finaliser le BDC (signature) ou de libérer le créneau si l'opération ne se fait plus.</p>
      <p style="color:#aaa;font-size:10px;margin-top:16px">instance ${require('os').hostname()} · service ${process.env.RENDER_SERVICE_NAME || 'local'} · pid ${process.pid} · rev ${(process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev'}</p>`;
    // sendMailOnly (et non sendMail) : cette alerte ne doit PAS partir à la liste de
    // diffusion générale (REPORT_EMAIL_EDITO/GROWTH, qui inclut Lola) — seulement à
    // Donatien (EMAIL_ADMIN) + au commercial concerné.
    const dest = [EMAIL_ADMIN, ...extra];
    reports.sendMailOnly(`⏰ BDC en attente — ${e.entreprise} (${jours}j ouvrés)`, html, dest);
    console.log(`[BDC-ALERTE] id=${e.id} "${e.entreprise}" — ${jours}j ouvrés — mail envoyé à ${dest.filter(Boolean).join(',')}`);
  }
}

// Alerte quotidienne "BDC en attente" — MISE EN PAUSE (26/08/2026, demande de
// Donatien : un mail par créneau et par jour ouvré = spam de boîte mail).
// La fonction et l'endpoint de test restent disponibles ; pour réactiver
// l'envoi automatique : variable d'env BDC_ALERTES_MAIL=1 sur Render.
if (process.env.BDC_ALERTES_MAIL === '1') {
  cronBdc.schedule('0 9 * * 1-5', checkBdcEnRetard, { timezone: 'Europe/Paris' });
  console.log('📧 Alertes BDC en attente ACTIVÉES (BDC_ALERTES_MAIL=1, lun-ven 9h)');
} else {
  console.log('⏸️  Alertes BDC en attente EN PAUSE (mettre BDC_ALERTES_MAIL=1 pour réactiver)');
}

// Déclenchement manuel pour test (édito uniquement)
app.post('/api/admin/test-bdc-alerte', requireEdit, (req, res) => {
  checkBdcEnRetard();
  res.json({ success: true, message: 'Vérification BDC lancée, vérifie les logs et boîtes mail' });
});

// ── SAUVEGARDE AUTOMATIQUE DE LA BASE ───────────────────────────────────────
// Snapshot gzipé de planning.db chaque matin sur le disque persistant Render
// (/var/data/backups/ en prod — survit aux redéploiements), 30 jours de
// rétention. Le lundi, le snapshot part aussi en pièce jointe à Donatien
// (copie HORS du disque — la seule protection contre une perte du volume).
// db.serialize() fige la base de façon cohérente (WAL compris), pas besoin
// d'arrêter le service.
const BACKUP_DIR = path.join(path.dirname(db.name), 'backups');

function backupPlanningDb() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const jour = new Date().toISOString().slice(0, 10);
  const dest = path.join(BACKUP_DIR, `planning-${jour}.db.gz`);
  const gz = zlib.gzipSync(db.serialize());
  fs.writeFileSync(dest, gz);
  // Rétention : on ne garde que les 30 derniers jours
  const limite = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const m = /^planning-(\d{4}-\d{2}-\d{2})\.db\.gz$/.exec(f);
    if (m && m[1] < limite) fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
  console.log(`[BACKUP] ${dest} écrit (${(gz.length / 1024).toFixed(0)} Ko)`);
  return { dest, size: gz.length, jour };
}

cronBdc.schedule('17 6 * * *', async () => {
  try {
    const b = backupPlanningDb();
    // Le lundi : copie externalisée par email (limite pièce jointe Mailjet ~15 Mo)
    if (new Date().getDay() === 1 && EMAIL_ADMIN) {
      if (b.size > 10 * 1024 * 1024) {
        console.warn(`[BACKUP] ${(b.size / 1048576).toFixed(1)} Mo — trop gros pour l'email, snapshot local conservé`);
      } else {
        await reports.sendMailOnly(
          `💾 Backup planning — semaine du ${b.jour}`,
          `<p>Sauvegarde hebdomadaire automatique de la base du planning (fichier SQLite gzipé). Pour restaurer : dézipper et renommer en planning.db.</p><p>Les snapshots quotidiens (30 jours) sont aussi sur le disque persistant Render, dossier <code>backups/</code>.</p>`,
          [EMAIL_ADMIN],
          [{ ContentType: 'application/gzip', Filename: path.basename(b.dest), Base64Content: fs.readFileSync(b.dest).toString('base64') }]
        );
      }
    }
  } catch (e) { console.error('[BACKUP] échec :', e.message); }
}, { timezone: 'Europe/Paris' });

// Téléchargement manuel du dernier snapshot. Protégé par la clé SERVEUR
// (x-sf-secret) et volontairement PAS par le header "role" envoyé par le
// navigateur — la base contient toutes les données, elle ne doit pas être
// exposée derrière une simple déclaration côté client. Endpoint désactivé si
// le secret n'a pas été configuré (valeur par défaut 'changeme').
app.get('/api/admin/backup/latest', (req, res) => {
  if (SF_WEBHOOK_SECRET === 'changeme') return res.status(503).json({ error: 'Backup désactivé : SF_WEBHOOK_SECRET non configuré' });
  if (req.headers['x-sf-secret'] !== SF_WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const fichiers = fs.readdirSync(BACKUP_DIR).filter(f => /^planning-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f)).sort();
    if (!fichiers.length) return res.status(404).json({ error: 'Aucun backup pour le moment' });
    res.download(path.join(BACKUP_DIR, fichiers[fichiers.length - 1]));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Exposé au host OpenDashboard : le router Express (à monter, ex. sous /planning)
// et checkBdcEnRetard (déjà scheduled ci-dessus via node-cron, mais utile si le
// host veut aussi l'exposer/tester directement).
module.exports = app;
module.exports.checkBdcEnRetard = checkBdcEnRetard;
module.exports.backupPlanningDb = backupPlanningDb;
