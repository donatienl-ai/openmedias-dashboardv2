// ==========================================
//  SERVEUR PRINCIPAL - OPENMEDIAS DASHBOARD
// ==========================================
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCalls, prewarmCalls, refreshRecent, getCacheStats as getAircallCacheStats } from './aircall.js';
import { getRdvInRange, getRdvBookedInRange, getSalesforgeRdv, getNewsletterRdv, getUpcomingRdvForHost, getCacheStats as getCalendlyCacheStats } from './calendly.js';
import { getNewsletterStats } from './mailjet.js';
import {
  getSignatures,
  getRevenue,
  getRevenueByMonth,
  getPropals,
  getPropalsComptes,
  getCacheStats as getSalesforceCacheStats,
} from './salesforce.js';
import { resolveRange, comparisonRange, previousQuarterStart } from './dateRange.js';
import { getBdc, getCacheStats as getDocusignCacheStats } from './docusign.js';
import { getRawUsers } from './aircall.js';
import { getRawHosts } from './calendly.js';
import { SALES } from './roster.js';
import { sendEmail, getMessageStatus } from './mailer.js';
import { buildReportHtml } from './reportHtml.js';
import { startScheduler, getSchedulerState } from './scheduler.js';
import { createDashboardCache } from './dashboardCache.js';
import { scopeDataToCommercial, resolveDisplayName, resolveTeamDisplayNames } from './scopeByCommercial.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(compression());
// Limite relevée (défaut 100kb) : le rétroplanning communication envoie l'image
// de preview d'un post en base64 dans le JSON (pas d'upload multipart), un
// visuel compressé côté client dépasse vite la limite par défaut.
app.use(express.json({ limit: '5mb' }));

const PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-moi';

// ── AUTH PARTAGÉE AVEC OPENPLANNING (fusion) ──────────────────────────────────
// Les comptes commerciaux (email + mot de passe, table commercial_users) sont
// désormais LE système d'auth du dashboard aussi — mêmes comptes que le
// planning. Le mot de passe unique historique (DASHBOARD_PASSWORD) reste
// accepté en parallèle comme filet de sécurité temporaire pendant la bascule
// (accès admin complet), à retirer une fois les comptes commerciaux validés.
const { verifyCommercialLogin, getCommercialById } = (await import('../planning/backend/auth.js')).default;
// Handle SQLite brut, réutilisé uniquement pour un ping de santé (SELECT 1) sur
// /api/admin/cache — détecte un disque persistant Render non monté / hors service
// avant que ça ne se voie comme une erreur confuse ailleurs dans l'appli.
const { db: planningDb } = (await import('../planning/backend/db.js')).default;
// ── ÉQUIPES + RÉGLAGES ADMIN : mêmes modules partagés que le planning (SQLite
// persisté), pour n'avoir qu'un seul backend admin quelle que soit la page
// depuis laquelle on les modifie (remplace teamsStore.js et settings.js,
// tous deux volatiles en mémoire).
const {
  listSalesTeams, getTeamMembers, createSalesTeam, renameSalesTeam, deleteSalesTeam,
  findAccountByRosterName, setAccountTeam,
} = (await import('../planning/backend/teams.js')).default;
const {
  getReportSettings, updateReportSettings, recordLoginEvent, getLoginEvents,
} = (await import('../planning/backend/adminSettings.js')).default;

// --- Middleware d'authentification : compte commercial OU mot de passe unique (legacy) ---
// Le front envoie soit "x-commercial-id" (compte individuel), soit
// "x-dashboard-password" (filet de sécurité, accès admin complet).
function requireAuth(req, res, next) {
  const legacyPw = req.headers['x-dashboard-password'];
  if (legacyPw && legacyPw === PASSWORD) {
    req.isLegacyAdmin = true;
    return next();
  }
  const id = req.headers['x-commercial-id'];
  if (id) {
    const user = getCommercialById(id);
    if (user) { req.commercial = user; return next(); }
  }
  return res.status(401).json({ error: 'Non authentifié' });
}

// --- Middleware d'authentification : réservé aux comptes admin ---
// (role='admin', ou l'ancien flag is_admin des comptes migrés) ou au mot de
// passe unique legacy (qui garde un accès complet le temps de la bascule).
function isAdminAccount(commercial) {
  return !!commercial && (commercial.role === 'admin' || !!commercial.is_admin);
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.isLegacyAdmin || isAdminAccount(req.commercial)) return next();
    return res.status(403).json({ error: 'Accès réservé aux comptes admin' });
  });
}

// --- Journal des connexions (persisté SQLite, 200 derniers événements) ---
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket?.remoteAddress || '').trim() || 'inconnue';
}
function recordLogin(req, ok) {
  recordLoginEvent(ok, clientIp(req), req.headers['user-agent']);
}

// --- Route de connexion : compte commercial (email+mdp) OU mot de passe unique (legacy) ---
app.post('/api/login', (req, res) => {
  const { password, email } = req.body || {};
  // Legacy : mot de passe unique (pas d'email transmis) — filet de sécurité pendant la bascule.
  if (email === undefined) {
    if (password === PASSWORD) {
      recordLogin(req, true);
      return res.json({ ok: true, legacy: true });
    }
    recordLogin(req, false);
    return res.status(401).json({ ok: false, error: 'Mot de passe incorrect' });
  }
  // Nouveau : compte commercial individuel (même compte que sur le planning).
  const user = verifyCommercialLogin(email, password || '');
  if (!user) {
    recordLogin(req, false);
    return res.status(401).json({ ok: false, error: 'Email ou mot de passe incorrect' });
  }
  recordLogin(req, true);
  const role = user.role || (user.is_admin ? 'admin' : 'commercial');
  res.json({
    ok: true,
    commercialId: user.id,
    nom: user.nom,
    email: user.email,
    isAdmin: !!user.is_admin || role === 'admin',
    role,
    teamId: user.team_id || null,
  });
});

// --- Console admin : journal des connexions ---
app.get('/api/admin/logins', requireAdmin, (req, res) => {
  res.json({ events: getLoginEvents(200) });
});

// ---------- ÉQUIPES (lecture ouverte à tout compte connecté ; édition réservée aux admins) ----------
// Mêmes équipes que "Équipes de vente" côté planning (table sales_teams,
// appartenance via commercial_users.team_id) — une seule source de vérité,
// affichée ici sous forme de {id, label, members: [noms du roster]} pour ne
// rien changer côté React (SettingsModal, TvView, FilterDropdown...).
function teamsWithRosterMembers() {
  return listSalesTeams().map((t) => ({
    id: t.id,
    label: t.label,
    members: getTeamMembers(t.id)
      .map((u) => resolveDisplayName(u.nom) || u.nom)
      .filter(Boolean),
  }));
}
app.get('/api/teams', requireAuth, (req, res) => {
  res.json({ teams: teamsWithRosterMembers() });
});
// Liste des noms du roster (pour construire les cases à cocher membres d'équipe
// côté planning, qui n'a pas accès à server/roster.js directement).
app.get('/api/admin/roster', requireAdmin, (req, res) => {
  res.json({ names: SALES.map((s) => s.display) });
});
app.post('/api/admin/teams', requireAdmin, (req, res) => {
  try {
    const created = createSalesTeam((req.body || {}).label);
    res.status(201).json({ ...created, members: [] });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.patch('/api/admin/teams/:id', requireAdmin, (req, res) => {
  try {
    const { label, members } = req.body || {};
    if (typeof label === 'string' && label.trim()) renameSalesTeam(req.params.id, label);
    if (Array.isArray(members)) {
      const current = new Set(getTeamMembers(req.params.id).map((u) => resolveDisplayName(u.nom) || u.nom));
      const next = new Set(members);
      // Ajouts : il faut un compte existant pour ce nom (les groupements sont
      // désormais basés sur les comptes, plus sur une simple liste de noms).
      for (const name of next) {
        if (current.has(name)) continue;
        const entry = SALES.find((s) => s.display === name);
        const account = findAccountByRosterName(name, entry?.last);
        if (!account) throw new Error(`Aucun compte pour « ${name} » — créez-lui d'abord un compte dans Comptes.`);
        setAccountTeam(account.id, req.params.id);
      }
      // Retraits
      for (const name of current) {
        if (next.has(name)) continue;
        const entry = SALES.find((s) => s.display === name);
        const account = findAccountByRosterName(name, entry?.last);
        if (account) setAccountTeam(account.id, null);
      }
    }
    res.json(teamsWithRosterMembers().find((t) => t.id === req.params.id));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.delete('/api/admin/teams/:id', requireAdmin, (req, res) => {
  try {
    deleteSalesTeam(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// --- Route principale : agrège toutes les sources sur une plage de dates ---
// ---------- DEBUG : noms bruts des sources (diagnostic matching) ----------
// Auth : header x-dashboard-password OU ?pw= (pratique navigateur).
// Usage : /api/debug/names?preset=this_week&pw=LE_MOT_DE_PASSE
app.get('/api/debug/names', async (req, res) => {
  const pw = req.headers['x-dashboard-password'] || req.query.pw;
  if (pw !== PASSWORD) return res.status(401).json({ error: 'Mot de passe invalide' });
  try {
    const r = resolveRange(req.query.preset || 'this_week', req.query.start, req.query.end);
    const [aircall, calendly] = await Promise.allSettled([
      getRawUsers(r),
      getRawHosts(r),
    ]);
    const rosterNames = SALES.map((s) => s.display);
    const annotate = (rows) =>
      rows.map((x) => ({ ...x, matched: rosterNames.includes(x.matchedTo) }));
    res.json({
      range: { label: r.label },
      aircall: aircall.status === 'fulfilled' ? annotate(aircall.value) : { error: String(aircall.reason?.message || aircall.reason) },
      calendly: calendly.status === 'fulfilled' ? annotate(calendly.value) : { error: String(calendly.reason?.message || calendly.reason) },
      hint: 'matched:false = ce nom brut ne correspond à personne du roster → ses données sont perdues du détail.',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Agrège toutes les sources pour une plage donnée.
// Utilisé par la route /api/dashboard ET par le reporting email.
async function collectData(preset, range) {
  const r = { start: range.start, end: range.end };

  // On lance tous les appels en parallèle. Si une source plante,
  // on renvoie quand même les autres avec une erreur partielle.
  const results = await Promise.allSettled([
    getCalls(r),              // 0
    getRdvInRange(r),         // 1
    getRdvBookedInRange(r),   // 2
    getPropals(r),            // 3
    getSignatures(r),         // 4
    getRevenue(r),            // 5
    getSalesforgeRdv(r),      // 6 (UTM salesforge via Calendly, suit la période)
    getBdc(r),                // 7 (BDC envoyés/signés via DocuSign)
    getPropalsComptes(r),     // 8 (propositions sur Comptes, Salesforce)
  ]);

  const pick = (i, fallback) =>
    results[i].status === 'fulfilled' ? results[i].value : fallback;

  const errors = {};
  const labels = ['calls', 'rdvToday', 'rdvBooked', 'propals', 'signatures', 'revenue', 'salesforge', 'bdc', 'propalsComptes'];
  results.forEach((res2, i) => {
    if (res2.status === 'rejected') errors[labels[i]] = String(res2.reason?.message || res2.reason);
  });

  const rdvToday = pick(1, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } });
  const rdvBooked = pick(2, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } });

  const revenue = pick(5, { totalAmount: 0, detail: [] });
  const signatures = pick(4, { total: 0, totalAmount: 0, detail: [] });

  // Repère "mois en cours" affiché sous CA & Signatures, indépendant de la période.
  // Si la période sélectionnée EST déjà ce mois, on réutilise (pas de requête en plus).
  let monthRevenue = revenue;
  let monthSignatures = signatures;
  if (preset !== 'this_month') {
    const m = resolveRange('this_month');
    const [mr, ms] = await Promise.allSettled([
      getRevenue({ start: m.start, end: m.end }),
      getSignatures({ start: m.start, end: m.end }),
    ]);
    if (mr.status === 'fulfilled') monthRevenue = mr.value;
    if (ms.status === 'fulfilled') monthSignatures = ms.value;
  }

  return {
    generatedAt: new Date().toISOString(),
    range: { preset, label: range.label, start: range.start.toISOString(), end: range.end.toISOString() },
    calls: pick(0, { total: 0, detail: [] }),
    rdvToday,
    rdvBooked,
    propals: pick(3, { total: 0, totalAmount: 0, detail: [] }),
    signatures,
    revenue,
    monthRevenue,
    monthSignatures,
    salesforge: pick(6, { total: 0, detail: [] }),
    bdc: pick(7, { sent: { total: 0, detail: [] }, signed: { total: 0, detail: [] }, pending: { total: 0, detail: [] } }),
    propalsComptes: pick(8, { total: 0, detail: [] }),
    // Objectif de CA mensuel (alerte de seuil sur la tuile CA, cf. client) —
    // exposé à TOUT compte connecté (pas juste admin) puisque c'est juste un
    // repère informatif, contrairement au reste de la console admin.
    settings: { monthlyRevenueObjective: getReportSettings().monthlyRevenueObjective },
    errors: Object.keys(errors).length ? errors : null,
  };
}

// Données de comparaison (totaux/détails des 6 KPIs principaux, hors SalesForge)
async function collectCompareData(range) {
  const r = { start: range.start, end: range.end };
  const results = await Promise.allSettled([
    getCalls(r),               // 0
    getRdvInRange(r),          // 1 (R1/R2 tenus)
    getRdvBookedInRange(r),    // 2 (R1/R2 pris)
    getPropals(r),             // 3
    getPropalsComptes(r),      // 4
    getSignatures(r),          // 5
    getRevenue(r),             // 6
  ]);
  const v = (idx, fb) => (results[idx].status === 'fulfilled' ? results[idx].value : fb);
  return {
    calls: v(0, { total: 0, detail: [] }),
    rdvToday: v(1, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } }),
    rdvBooked: v(2, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } }),
    propals: v(3, { total: 0, totalAmount: 0, detail: [] }),
    propalsComptes: v(4, { total: 0, detail: [] }),
    signatures: v(5, { total: 0, totalAmount: 0, detail: [] }),
    revenue: v(6, { totalAmount: 0, detail: [] }),
  };
}

// Construit le payload complet du dashboard (données + comparatif) pour une plage.
// C'est la fonction "lourde" (appels APIs) que le cache enveloppe.
async function computeDashboard(preset, range) {
  // Comparatif désactivé sur les très longues périodes (>70j) pour préserver les quotas
  const durationDays = (range.end - range.start) / 86400000;
  const wantCompare = durationDays <= 70;
  const compRange = wantCompare ? comparisonRange(preset, range) : null;

  const [data, compare] = await Promise.all([
    collectData(preset, range),
    compRange ? collectCompareData(compRange).catch(() => null) : Promise.resolve(null),
  ]);

  return { ...data, compare };
}

// Cache mémoire + rafraîchissement en arrière-plan (voir dashboardCache.js).
// On pré-chauffe les périodes les plus consultées ; les autres (yesterday,
// last_week, last_30, custom...) sont mises en cache à la première ouverture
// puis servies instantanément ensuite (stale-while-revalidate).
const dashboardCache = createDashboardCache({
  compute: computeDashboard,
  resolveRange,
  warmPresets: ['last_month', 'this_month', 'this_week', 'today'],
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    // Édito / communication n'ont pas accès au dashboard — leur landing page
    // est le planning (voir App.js, redirection juste après connexion).
    if (req.commercial && ['edito', 'communication'].includes(req.commercial.role)) {
      return res.status(403).json({ error: "Ce compte n'a pas accès au dashboard — rendez-vous sur /planning" });
    }
    const preset = req.query.preset || 'today';
    const range = resolveRange(preset, req.query.start, req.query.end);
    const full = await dashboardCache.get(preset, range);
    // Mot de passe legacy et comptes admin gardent la vue complète (toute l'équipe).
    if (req.commercial && !isAdminAccount(req.commercial)) {
      if (req.commercial.role === 'manager' && req.commercial.team_id) {
        const members = getTeamMembers(req.commercial.team_id);
        const names = resolveTeamDisplayNames(members.length ? members : [req.commercial]);
        if (!names.length) {
          console.warn(`[SCOPE] équipe "${req.commercial.team_id}" du manager "${req.commercial.nom}" — aucun membre reconnu dans roster.js SALES, verra des données vides.`);
        }
        return res.json(scopeDataToCommercial(full, names.length ? names : [req.commercial.nom]));
      }
      const displayName = resolveDisplayName(req.commercial);
      if (!displayName) {
        console.warn(`[SCOPE] commercial "${req.commercial.nom}" (id=${req.commercial.id}) introuvable dans roster.js SALES — verra des données vides sur /api/dashboard.`);
      }
      return res.json(scopeDataToCommercial(full, displayName || req.commercial.nom));
    }
    res.json(full);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- CA MENSUEL SUR N MOIS GLISSANTS (graphique d'évolution) ----------
app.get('/api/revenue-by-month', requireAuth, async (req, res) => {
  try {
    if (req.commercial && ['edito', 'communication'].includes(req.commercial.role)) {
      return res.status(403).json({ error: "Ce compte n'a pas accès au dashboard" });
    }
    const months = parseInt(req.query.months, 10) || 12;
    let scopeNames = null;
    if (req.commercial && !isAdminAccount(req.commercial)) {
      if (req.commercial.role === 'manager' && req.commercial.team_id) {
        const members = getTeamMembers(req.commercial.team_id);
        scopeNames = resolveTeamDisplayNames(members.length ? members : [req.commercial]);
      } else {
        const displayName = resolveDisplayName(req.commercial);
        scopeNames = displayName ? [displayName] : [req.commercial.nom];
      }
    }
    const data = await getRevenueByMonth({ months, scopeNames });
    res.json({ months: data });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- MES RDV À VENIR (vue perso "Ma semaine" du commercial connecté) ----------
// Seule pièce réellement nouvelle pour cette vue : une LISTE d'événements
// individuels datés (pas juste un compteur). Les autres chiffres de "Ma
// semaine" (calls, propals) sont récupérés côté client depuis /api/dashboard
// (déjà scopé au commercial connecté via scopeDataToCommercial).
app.get('/api/mes-rdv-a-venir', requireAuth, async (req, res) => {
  if (!req.commercial) {
    return res.status(400).json({ error: 'Réservé aux comptes commerciaux individuels (pas au mot de passe legacy)' });
  }
  const displayName = resolveDisplayName(req.commercial);
  if (!displayName) return res.json({ displayName: null, upcoming: [] });
  try {
    const days = Math.max(1, Math.min(14, parseInt(req.query.days, 10) || 7));
    const end = new Date(Date.now() + days * 86400000);
    const upcoming = await getUpcomingRdvForHost({ end, displayName });
    res.json({ displayName, upcoming });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- NEWSLETTER STATS (Mailjet EXT + Calendly utm_source=newsletter) ----------
app.get('/api/newsletter-stats', requireAuth, async (req, res) => {
  try {
    const preset = req.query.preset || 'this_month';
    const range = resolveRange(preset, req.query.start, req.query.end);
    const r = { start: range.start, end: range.end };

    const [mjResult, nlRdvResult] = await Promise.allSettled([
      getNewsletterStats(r),
      getNewsletterRdv(r),
    ]);

    const newsletters = mjResult.status === 'fulfilled'
      ? mjResult.value
      : { campaigns: [], totals: { sent: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, openRate: 0, clickRate: 0, unsubRate: 0, count: 0 } };

    const nlRdv = nlRdvResult.status === 'fulfilled'
      ? nlRdvResult.value
      : { total: 0, detail: [] };

    const errors = {};
    if (mjResult.status === 'rejected') errors.mailjet = String(mjResult.reason?.message || mjResult.reason);
    if (nlRdvResult.status === 'rejected') errors.calendly = String(nlRdvResult.reason?.message || nlRdvResult.reason);

    res.json({
      range: { preset, label: range.label, start: range.start.toISOString(), end: range.end.toISOString() },
      newsletters,
      nlRdv,
      errors: Object.keys(errors).length ? errors : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- REPORTING EMAIL (remplace Make à terme) ----------
// Génère le reporting sur la période demandée et l'envoie aux destinataires.
async function sendReportNow({ to, theme, preset = 'today', start, end }) {
  const range = resolveRange(preset, start, end);
  const month = resolveRange('this_month');
  const data = await collectData(preset, range);
  // CA du mois (cumul depuis le 1er, indépendant de la période du rapport)
  let monthRevenue = { totalAmount: 0, detail: [] };
  try { monthRevenue = await getRevenue({ start: month.start, end: month.end }); } catch (e) { /* section vide si KO */ }

  // Comparatif (même logique que computeDashboard : désactivé sur >70j pour
  // préserver les quotas API) — alimente la section "Points notables" (anomalies).
  const durationDays = (range.end - range.start) / 86400000;
  const compRange = durationDays <= 70 ? comparisonRange(preset, range) : null;
  const compare = compRange ? await collectCompareData(compRange).catch(() => null) : null;

  const html = buildReportHtml({ data, monthRevenue, monthLabel: month.label, theme, preset, range, compare });
  const sameDay = range.start.toDateString() === new Date(range.end.getTime() - 1).toDateString();
  const subjectLabel = sameDay
    ? range.start.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : range.label;
  const subject = `📊 Reporting commercial — ${subjectLabel}`;
  const sent = await sendEmail({ to, subject, html });
  return { to, theme, preset, rangeLabel: range.label, errors: data.errors, messageId: sent.messageId };
}

function parseRecipients(str) {
  return String(str || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Déclenchement (cron) : GET /api/send-report?key=REPORT_KEY[&sync=1][&to=...][&theme=light|dark]
// Par défaut répond immédiatement (202) et envoie en arrière-plan,
// pour que n'importe quel cron externe fonctionne malgré le réveil Render.
app.get('/api/send-report', async (req, res) => {
  const expected = process.env.REPORT_KEY;
  if (!expected || req.query.key !== expected) {
    return res.status(401).json({ error: 'Clé invalide' });
  }
  const s = getReportSettings();
  const to = parseRecipients(req.query.to || s.reportTo);
  const theme = req.query.theme === 'dark' ? 'dark' : req.query.theme === 'light' ? 'light' : s.reportTheme;
  const preset = req.query.preset || s.reportPreset;
  if (to.length === 0) return res.status(400).json({ error: 'Aucun destinataire (réglages admin / REPORT_TO)' });

  if (req.query.sync === '1') {
    try {
      const out = await sendReportNow({ to, theme, preset, start: req.query.start, end: req.query.end });
      res.json({ sent: true, ...out });
    } catch (e) {
      res.status(500).json({ sent: false, error: String(e.message || e) });
    }
  } else {
    res.status(202).json({ accepted: true, to, theme, preset });
    sendReportNow({ to, theme, preset, start: req.query.start, end: req.query.end })
      .catch((e) => console.error('send-report failed:', e));
  }
});

// ---------- CONSOLE ADMIN (réglages + test, réservés aux comptes admin) ----------
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ ...getReportSettings(), scheduler: getSchedulerState() });
});

// ---------- OBJECTIFS INDIVIDUELS (CA mensuel par commercial) ----------
// Lecture ouverte à tout compte connecté (chacun doit pouvoir voir sa propre
// jauge, et un manager celle de son équipe) ; écriture réservée aux admins.
// Stocké dans planning.db (commercial_objectives, cf. planning/backend/db.js)
// pour bénéficier du même disque persistant que le reste (pas de perte au
// redémarrage, contrairement à l'ancien server/settings.js en mémoire).
app.get('/api/objectifs', requireAuth, (req, res) => {
  try {
    const rows = planningDb.prepare(`
      SELECT cu.id AS commercial_id, cu.nom, co.monthly_amount
      FROM commercial_users cu
      LEFT JOIN commercial_objectives co ON co.commercial_id = cu.id
      WHERE cu.actif = 1
    `).all();
    const out = rows
      .map((r) => ({
        commercialId: r.commercial_id,
        displayName: resolveDisplayName({ nom: r.nom }),
        monthlyObjective: Math.max(0, Math.round(r.monthly_amount || 0)),
      }))
      // Ignore les comptes sans correspondance dans le roster (server/roster.js) —
      // on ne peut pas calculer de progression sans un nom de référence sûr.
      .filter((r) => r.displayName);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.patch('/api/admin/objectifs/:commercialId', requireAdmin, (req, res) => {
  const commercialId = parseInt(req.params.commercialId, 10);
  if (!commercialId) return res.status(400).json({ error: 'commercialId invalide' });
  const montant = Math.max(0, Math.round(Number(req.body?.monthlyObjective)) || 0);
  try {
    planningDb.prepare(`
      INSERT INTO commercial_objectives (commercial_id, monthly_amount, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(commercial_id) DO UPDATE SET monthly_amount = excluded.monthly_amount, updated_at = datetime('now')
    `).run(commercialId, montant);
    res.json({ ok: true, commercialId, monthlyObjective: montant });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Endpoint léger pour le pinger (UptimeRobot) : maintient le service éveillé.
// Volontairement RAPIDE et SANS appel externe (Salesforce/Aircall/etc.) : un
// ping de santé qui dépendrait d'une API tierce lente donnerait de faux
// "down" et réveillerait pour rien. On y ajoute juste mémoire/uptime en
// process (gratuit) pour repérer une dérive mémoire avant le crash OOM
// (cf. incident déjà rencontré sur ce service).
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
  });
});

// Diagnostic complet (réservé admin) : âge/couverture de TOUS les caches
// (dashboard + les caches bruts par connecteur, cf. server/rawDataCache.js)
// + un ping SQLite pour vérifier que le disque persistant du planning répond.
app.get('/api/admin/cache', requireAdmin, (req, res) => {
  let planningDbOk = true;
  let planningDbError = null;
  try {
    planningDb.prepare('SELECT 1').get();
  } catch (e) {
    planningDbOk = false;
    planningDbError = String(e?.message || e);
  }
  res.json({
    entries: dashboardCache.stats(), // legacy : conservé pour compat avec un éventuel appelant existant
    dashboard: dashboardCache.stats(),
    aircall: getAircallCacheStats(),
    salesforce: getSalesforceCacheStats(),
    calendly: getCalendlyCacheStats(),
    docusign: getDocusignCacheStats(),
    planningDb: { ok: planningDbOk, error: planningDbError },
  });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(updateReportSettings(req.body || {}));
});

// Envoie le reporting pour la VUE COURANTE (période + thème transmis par le front),
// dans le même style que le reporting programmé, aux destinataires configurés.
app.post('/api/admin/email-view', requireAdmin, async (req, res) => {
  try {
    const s = getReportSettings();
    const to = parseRecipients((req.body && req.body.to) || s.reportTo);
    if (to.length === 0) return res.status(400).json({ error: 'Aucun destinataire configuré (réglages admin)' });
    const b = req.body || {};
    const theme = b.theme === 'dark' ? 'dark' : b.theme === 'light' ? 'light' : s.reportTheme;
    const out = await sendReportNow({ to, theme, preset: b.preset || 'today', start: b.start, end: b.end });
    res.json({ sent: true, ...out });
  } catch (e) {
    res.status(500).json({ sent: false, error: String(e.message || e) });
  }
});

app.post('/api/admin/send-test', requireAdmin, async (req, res) => {
  try {
    const s = getReportSettings();
    const to = parseRecipients((req.body && req.body.to) || s.reportTo);
    if (to.length === 0) return res.status(400).json({ error: 'Aucun destinataire configuré' });
    const b = req.body || {};
    const out = await sendReportNow({
      to,
      theme: s.reportTheme,
      preset: b.preset || 'today',
      start: b.start,
      end: b.end,
    });
    // Diagnostic : quelle clé le serveur utilise + statut réel du message chez Mailjet
    const keyPrefix = (process.env.MAILJET_API_KEY || '').slice(0, 8);
    let mailjetStatus = null;
    if (out.messageId) {
      try { mailjetStatus = await getMessageStatus(out.messageId); } catch { mailjetStatus = 'lookup KO'; }
    }
    res.json({ sent: true, ...out, keyPrefix, mailjetStatus });
  } catch (e) {
    res.status(500).json({ sent: false, error: String(e.message || e) });
  }
});

// ---------- OPENPLANNING (planning de diffusion + BDC, fusionné sous /planning) ----------
// router.js est un express.Router() CommonJS (ancien server.js de
// planning-diff-openmedias, converti). Le package.json imbriqué dans
// planning/backend/ ({"type":"commonjs"}) permet à ce projet ESM de l'importer
// tel quel via l'interop Node — pas de renommage .cjs nécessaire.
// Monté à /planning : ses routes internes (/api/emissions, /api/bdc/*, ...)
// deviennent /planning/api/... — le frontend planning (const API='api', relatif)
// s'y retrouve automatiquement une fois servi depuis /planning/.
const { default: planningRouter } = await import('../planning/backend/router.js');
const planningFrontendDir = path.join(__dirname, '..', 'planning', 'frontend');
app.use('/planning', express.static(planningFrontendDir));
app.use('/planning', planningRouter);

// --- Sert le build React en production ---
const clientBuild = path.join(__dirname, '..', 'client', 'build');
app.use(express.static(clientBuild));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'));
});

const PORT = process.env.PORT || 3001;
// Planificateur de l'envoi automatique (réglé via la console admin)
startScheduler(async () => {
  const s = getReportSettings();
  const to = parseRecipients(s.reportTo);
  if (to.length === 0) throw new Error('Aucun destinataire configuré');
  return sendReportNow({ to, theme: s.reportTheme, preset: s.reportPreset });
}, getReportSettings);

app.listen(PORT, () => {
  console.log(`OpenMedias Dashboard en écoute sur le port ${PORT}`);
});

// ---- Pré-chauffe au démarrage ----------------------------------------------
// 1) On amorce le cache des calls bruts depuis le DÉBUT DU TRIMESTRE PRÉCÉDENT
//    jusqu'à maintenant : toute période incluse (mois dernier, plages custom...)
//    est ensuite servie sans rappeler Aircall.
// 2) On pré-calcule ensuite les périodes les plus consultées.
// Le rafraîchissement périodique ne re-récupère QUE la queue récente (les calls
// passés sont immuables), ce qui préserve la couverture large à moindre coût.
const REFRESH_DAYS = parseInt(process.env.AIRCALL_REFRESH_DAYS || '2', 10);
const recentSince = () => new Date(Date.now() - REFRESH_DAYS * 86400000);

async function warmCycleInitial() {
  // Fenêtre d'amorçage : par défaut depuis le trimestre précédent. Peut être
  // étendue via AIRCALL_PREWARM_MONTHS (ex. 12 = amorce toute l'année écoulée,
  // au prix d'un amorçage initial plus long).
  const PREWARM_MONTHS = parseInt(process.env.AIRCALL_PREWARM_MONTHS || '0', 10);
  const n = new Date();
  const qStart = PREWARM_MONTHS > 0
    ? new Date(n.getFullYear(), n.getMonth() - PREWARM_MONTHS, 1)
    : previousQuarterStart();
  try {
    const r = await prewarmCalls({ start: qStart, end: new Date() });
    console.log(`Cache Aircall amorcé depuis ${qStart.toISOString().slice(0, 10)} (${r.count} calls${r.truncated ? ', une fenêtre > 10k détectée' : ''})`);
  } catch (e) {
    console.error('Amorçage Aircall KO :', String(e.message || e));
  }
  const w = await dashboardCache.refreshAll();
  console.log(`Cache dashboard pré-chauffé : ${w.refreshed}/${w.total} périodes`);
}

async function warmCyclePeriodic() {
  try {
    await refreshRecent(recentSince()); // ne retouche que les derniers jours
  } catch (e) {
    console.error('Rafraîchissement Aircall (récent) KO :', String(e.message || e));
  }
  await dashboardCache.refreshAll().catch((e) => console.error('Rafraîchissement cache KO :', e));
}

warmCycleInitial().catch((e) => console.error('Pré-chauffe initiale KO :', e));
setInterval(() => { warmCyclePeriodic(); }, 15 * 60 * 1000);
