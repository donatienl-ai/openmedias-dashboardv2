import { createDashboardService, withLiveDashboardSettings } from './dashboardService.js';
import { buildSourceSnapshot } from './sourceSnapshot.js';
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
import { getRoster } from './roster.js';
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
app.use(express.json({ limit: '5mb' }));

const PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-moi';

const { verifyCommercialLogin, getCommercialById } = (await import('../planning/backend/auth.js')).default;
const { db: planningDb } = (await import('../planning/backend/db.js')).default;
const {
  listSalesTeams, getTeamMembers, createSalesTeam, renameSalesTeam, deleteSalesTeam,
  findAccountByRosterName, setAccountTeam,
} = (await import('../planning/backend/teams.js')).default;
const {
  getReportSettings, updateReportSettings, recordLoginEvent, getLoginEvents,
} = (await import('../planning/backend/adminSettings.js')).default;

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

function isAdminAccount(commercial) {
  return !!commercial && (commercial.role === 'admin' || !!commercial.is_admin);
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.isLegacyAdmin || isAdminAccount(req.commercial)) return next();
    return res.status(403).json({ error: 'Accès réservé aux comptes admin' });
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket?.remoteAddress || '').trim() || 'inconnue';
}
function recordLogin(req, ok) {
  recordLoginEvent(ok, clientIp(req), req.headers['user-agent']);
}

app.post('/api/login', (req, res) => {
  const { password, email } = req.body || {};
  if (email === undefined) {
    if (password === PASSWORD) {
      recordLogin(req, true);
      return res.json({ ok: true, legacy: true });
    }
    recordLogin(req, false);
    return res.status(401).json({ ok: false, error: 'Mot de passe incorrect' });
  }
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

app.get('/api/admin/logins', requireAdmin, (req, res) => {
  res.json({ events: getLoginEvents(200) });
});

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

app.get('/api/admin/roster', requireAuth, (req, res) => {
  const roster = getRoster();
  res.json({
    names: roster.map((s) => s.display),
    managers: roster.filter((s) => s.role === 'manager').map((s) => s.display),
  });
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
      for (const name of next) {
        if (current.has(name)) continue;
        const entry = getRoster().find((s) => s.display === name);
        const account = findAccountByRosterName(name, entry?.last);
        if (!account) throw new Error(`Aucun compte pour « ${name} » — créez-lui d'abord un compte dans Comptes.`);
        setAccountTeam(account.id, req.params.id);
      }
      for (const name of current) {
        if (next.has(name)) continue;
        const entry = getRoster().find((s) => s.display === name);
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

app.get('/api/debug/names', async (req, res) => {
  const pw = req.headers['x-dashboard-password'] || req.query.pw;
  if (pw !== PASSWORD) return res.status(401).json({ error: 'Mot de passe invalide' });
  try {
    const r = resolveRange(req.query.preset || 'this_week', req.query.start, req.query.end);
    const [aircall, calendly] = await Promise.allSettled([
      getRawUsers(r),
      getRawHosts(r),
    ]);
    const rosterNames = getRoster().map((s) => s.display);
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

const { collectData, collectCompareData, computeDashboard } = createDashboardService({
  getCalls, getRdvInRange, getRdvBookedInRange, getPropals, getSignatures, getRevenue, getSalesforgeRdv, getBdc, getPropalsComptes, resolveRange, comparisonRange, getReportSettings,
  sourceSnapshot: () => buildSourceSnapshot({
    aircall: getAircallCacheStats(), calendly: getCalendlyCacheStats(),
    salesforce: getSalesforceCacheStats(), docusign: getDocusignCacheStats(),
  }),
});

const dashboardCache = createDashboardCache({
  compute: computeDashboard,
  resolveRange,
  warmPresets: ['last_month', 'this_month', 'this_week', 'today'],
});

// « Où j'en suis » (demande Thomas Durand, validée par Lina le 30/09/2026) :
// chaque commercial se situe par rapport à la moyenne de TOUS les commerciaux
// actifs (commercial + manager) sur le CA du mois, sans jamais voir le score
// d'un autre. On ne renvoie qu'un pourcentage : son CA ÷ le CA moyen.
const PEER_ROLES = ['commercial', 'manager'];
function buildCaRanking(full, commercial) {
  const me = resolveDisplayName(commercial);
  if (!me || (full.errors && full.errors.monthRevenue)) return null;
  const peers = [...new Set(getRoster().filter((s) => s.actif && PEER_ROLES.includes(s.role)).map((s) => s.display))];
  if (peers.length < 2 || !peers.includes(me)) return null;
  const rows = (full.monthRevenue && Array.isArray(full.monthRevenue.detail)) ? full.monthRevenue.detail : [];
  const caOf = (name) => rows.filter((r) => r.name === name).reduce((sum, r) => sum + (r.amount || 0), 0);
  const myCa = caOf(me);
  const average = peers.map(caOf).reduce((a, b) => a + b, 0) / peers.length;
  // CA du commercial en % du CA moyen (100 % = pile la moyenne) ; null tant
  // que personne n'a encore de CA ce mois-ci.
  return {
    peers: peers.length,
    pctOfAverage: average > 0 ? Math.round((myCa / average) * 100) : null,
  };
}

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    if (req.commercial && ['edito', 'communication'].includes(req.commercial.role)) {
      return res.status(403).json({ error: "Ce compte n'a pas accès au dashboard — rendez-vous sur /planning" });
    }
    if (req.commercial && req.commercial.role === 'finance') {
      return res.status(403).json({ error: "Ce compte n'a pas accès au dashboard — rendez-vous sur /recouvrement" });
    }
    const preset = req.query.preset || 'today';
    const range = resolveRange(preset, req.query.start, req.query.end);
    const full = withLiveDashboardSettings(await dashboardCache.get(preset, range), getReportSettings());
    if (req.commercial && !isAdminAccount(req.commercial)) {
      if (req.commercial.role === 'manager' && req.commercial.team_id) {
        const members = getTeamMembers(req.commercial.team_id);
        const names = resolveTeamDisplayNames(members.length ? members : [req.commercial]);
        if (!names.length) {
          console.warn(`[SCOPE] équipe "${req.commercial.team_id}" du manager "${req.commercial.nom}" — aucun membre de l'équipe reconnu dans le roster (roster.js, dérivé de commercial_users), verra des données vides.`);
        }
        return res.json(scopeDataToCommercial(full, names.length ? names : [req.commercial.nom]));
      }
      const displayName = resolveDisplayName(req.commercial);
      if (!displayName) {
        console.warn(`[SCOPE] commercial "${req.commercial.nom}" (id=${req.commercial.id}) introuvable dans le roster (roster.js, dérivé de commercial_users) — verra des données vides sur /api/dashboard. Vérifier son rôle (commercial/manager/admin) et son statut actif.`);
      }
      const scoped = scopeDataToCommercial(full, displayName || req.commercial.nom);
      const caRanking = buildCaRanking(full, req.commercial);
      return res.json(caRanking ? { ...scoped, caRanking } : scoped);
    }
    res.json(full);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/revenue-by-month', requireAuth, async (req, res) => {
  try {
    if (req.commercial && ['edito', 'communication', 'finance'].includes(req.commercial.role)) {
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

    const withTimeout = (promise, fallback, ms = 4000) =>
      Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
      ]);

    const fallbackMj = { campaigns: [], totals: { sent: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, openRate: 0, clickRate: 0, unsubRate: 0, count: 0 } };
    const fallbackRdv = { total: 0, detail: [] };

    const [mjResult, nlRdvResult] = await Promise.allSettled([
      withTimeout(getNewsletterStats(r), fallbackMj),
      withTimeout(getNewsletterRdv(r), fallbackRdv),
    ]);

    const newsletters = mjResult.status === 'fulfilled' && mjResult.value ? mjResult.value : fallbackMj;
    const nlRdv = nlRdvResult.status === 'fulfilled' && nlRdvResult.value ? nlRdvResult.value : fallbackRdv;

    const errors = {};
    if (mjResult.status === 'rejected') errors.mailjet = String(mjResult.reason?.message || mjResult.reason);
    if (nlRdvResult.status === 'rejected') errors.calendly = String(nlRdvResult.reason?.message || nlRdvResult.reason);

    return res.json({
      range: { preset, label: range.label, start: range.start.toISOString(), end: range.end.toISOString() },
      newsletters,
      nlRdv,
      errors: Object.keys(errors).length ? errors : null,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

async function sendReportNow({ to, theme, preset = 'today', start, end }) {
  const range = resolveRange(preset, start, end);
  const month = resolveRange('this_month');
  const data = await collectData(preset, range);
  const monthRevenue = data.monthRevenue;

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

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ ...getReportSettings(), scheduler: getSchedulerState() });
});

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

app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
  });
});

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
    entries: dashboardCache.stats(),
    dashboard: dashboardCache.stats(),
    aircall: getAircallCacheStats(),
    salesforce: getSalesforceCacheStats(),
    calendly: getCalendlyCacheStats(),
    docusign: getDocusignCacheStats(),
    planningDb: { ok: planningDbOk, error: planningDbError },
  });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  try { res.json(updateReportSettings(req.body || {})); }
  catch (error) { res.status(error instanceof RangeError ? 400 : 500).json({ error: error.message }); }
});

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

const { default: planningRouter } = await import('../planning/backend/router.js');
const planningFrontendDir = path.join(__dirname, '..', 'planning', 'frontend');
app.use('/planning', express.static(planningFrontendDir));
app.use('/planning', planningRouter);

const recouvrementFrontendDir = path.join(__dirname, '..', 'recouvrement', 'frontend');
app.use('/recouvrement', express.static(recouvrementFrontendDir));
app.use('/recouvrement', planningRouter);

const { registerRadarPageTextRoute } = await import('./radarPageText.js');
registerRadarPageTextRoute(app);
const radarFrontendDir = path.join(__dirname, '..', 'radar', 'frontend');
app.use('/radar', express.static(radarFrontendDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('catalogue.json') || filePath.endsWith('embeddings.json')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

app.use('/radar', (req, res) => {
  res.status(404).json({ error: `Introuvable sous /radar : ${req.path}` });
});

const clientBuild = path.join(__dirname, '..', 'client', 'build');
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(clientBuild));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'));
});

const PORT = process.env.PORT || 3001;
startScheduler(async () => {
  const s = getReportSettings();
  const to = parseRecipients(s.reportTo);
  if (to.length === 0) throw new Error('Aucun destinataire configuré');
  return sendReportNow({ to, theme: s.reportTheme, preset: s.reportPreset });
}, getReportSettings);

app.listen(PORT, () => {
  console.log(`OpenMedias Dashboard en écoute sur le port ${PORT}`);
});

const REFRESH_DAYS = parseInt(process.env.AIRCALL_REFRESH_DAYS || '2', 10);
const recentSince = () => new Date(Date.now() - REFRESH_DAYS * 86400000);

async function warmCycleInitial() {
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
    await refreshRecent(recentSince());
  } catch (e) {
    console.error('Rafraîchissement Aircall (récent) KO :', String(e.message || e));
  }
  await dashboardCache.refreshAll().catch((e) => console.error('Rafraîchissement cache KO :', e));
}

warmCycleInitial().catch((e) => console.error('Pré-chauffe initiale KO :', e));
setInterval(() => { warmCyclePeriodic(); }, 15 * 60 * 1000);
