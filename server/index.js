// ==========================================
//  SERVEUR PRINCIPAL - OPENMEDIAS DASHBOARD
// ==========================================
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCalls, prewarmCalls, refreshRecent } from './aircall.js';
import { getRdvInRange, getRdvBookedInRange, getSalesforgeRdv, getNewsletterRdv } from './calendly.js';
import { getNewsletterStats } from './mailjet.js';
import {
  getSignatures,
  getRevenue,
  getPropals,
  getPropalsComptes,
} from './salesforce.js';
import { resolveRange, comparisonRange, previousQuarterStart } from './dateRange.js';
import { getBdc } from './docusign.js';
import { getRawUsers } from './aircall.js';
import { getRawHosts } from './calendly.js';
import { SALES } from './roster.js';
import { sendEmail, getMessageStatus } from './mailer.js';
import { buildReportHtml } from './reportHtml.js';
import { getSettings, updateSettings } from './settings.js';
import { startScheduler, getSchedulerState } from './scheduler.js';
import { createDashboardCache } from './dashboardCache.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

const PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-moi';

// --- Middleware d'authentification simple par mot de passe ---
// Le front envoie le mot de passe dans le header "x-dashboard-password".
function requireAuth(req, res, next) {
  const provided = req.headers['x-dashboard-password'];
  if (provided !== PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  next();
}

// --- Journal des connexions (mémoire volatile, 200 derniers événements) ---
const loginLog = [];
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket?.remoteAddress || '').trim() || 'inconnue';
}
function recordLogin(req, ok) {
  loginLog.push({
    at: new Date().toISOString(),
    ok,
    ip: clientIp(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
  });
  if (loginLog.length > 200) loginLog.shift();
}

// --- Route de vérification du mot de passe (pour le login) ---
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === PASSWORD) {
    recordLogin(req, true);
    return res.json({ ok: true });
  }
  recordLogin(req, false);
  return res.status(401).json({ ok: false, error: 'Mot de passe incorrect' });
});

// --- Console admin : journal des connexions ---
app.get('/api/admin/logins', requireAuth, (req, res) => {
  res.json({ events: [...loginLog].reverse() });
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
    propals: pick(3, { total: 0, detail: [] }),
    signatures,
    revenue,
    monthRevenue,
    monthSignatures,
    salesforge: pick(6, { total: 0, detail: [] }),
    bdc: pick(7, { sent: { total: 0, detail: [] }, signed: { total: 0, detail: [] }, pending: { total: 0, detail: [] } }),
    propalsComptes: pick(8, { total: 0, detail: [] }),
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
    propals: v(3, { total: 0, detail: [] }),
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
    const preset = req.query.preset || 'today';
    const range = resolveRange(preset, req.query.start, req.query.end);
    res.json(await dashboardCache.get(preset, range));
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

  const html = buildReportHtml({ data, monthRevenue, monthLabel: month.label, theme, preset, range });
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
  const s = getSettings();
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

// ---------- CONSOLE ADMIN (réglages + test, protégés par le mot de passe) ----------
app.get('/api/admin/settings', requireAuth, (req, res) => {
  res.json({ ...getSettings(), scheduler: getSchedulerState() });
});

// Endpoint léger pour le pinger (UptimeRobot) : maintient le service éveillé
app.get('/api/health', (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

// Diagnostic : état du cache du dashboard (âge des snapshots, erreurs éventuelles)
app.get('/api/admin/cache', requireAuth, (req, res) => {
  res.json({ entries: dashboardCache.stats() });
});

app.post('/api/admin/settings', requireAuth, (req, res) => {
  res.json(updateSettings(req.body || {}));
});

// Envoie le reporting pour la VUE COURANTE (période + thème transmis par le front),
// dans le même style que le reporting programmé, aux destinataires configurés.
app.post('/api/admin/email-view', requireAuth, async (req, res) => {
  try {
    const s = getSettings();
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

app.post('/api/admin/send-test', requireAuth, async (req, res) => {
  try {
    const s = getSettings();
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

// --- Sert le build React en production ---
const clientBuild = path.join(__dirname, '..', 'client', 'build');
app.use(express.static(clientBuild));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'));
});

const PORT = process.env.PORT || 3001;
// Planificateur de l'envoi automatique (réglé via la console admin)
startScheduler(async () => {
  const s = getSettings();
  const to = parseRecipients(s.reportTo);
  if (to.length === 0) throw new Error('Aucun destinataire configuré');
  return sendReportNow({ to, theme: s.reportTheme, preset: s.reportPreset });
}, getSettings);

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
