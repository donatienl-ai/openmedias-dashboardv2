// ==========================================
//  SERVEUR PRINCIPAL - OPENMEDIAS DASHBOARD
// ==========================================
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCalls } from './aircall.js';
import { getRdvInRange, getRdvBookedInRange, getSalesforgeRdv } from './calendly.js';
import {
  getSignatures,
  getRevenue,
  getPropals,
} from './salesforce.js';
import { resolveRange } from './dateRange.js';
import { getBdc } from './docusign.js';
import { getRawUsers } from './aircall.js';
import { getRawHosts } from './calendly.js';
import { SALES } from './roster.js';
import { sendEmail, getMessageStatus } from './mailer.js';
import { buildReportHtml } from './reportHtml.js';
import { getSettings, updateSettings } from './settings.js';

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

// --- Route de vérification du mot de passe (pour le login) ---
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === PASSWORD) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Mot de passe incorrect' });
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
  ]);

  const pick = (i, fallback) =>
    results[i].status === 'fulfilled' ? results[i].value : fallback;

  const errors = {};
  const labels = ['calls', 'rdvToday', 'rdvBooked', 'propals', 'signatures', 'revenue', 'salesforge', 'bdc'];
  results.forEach((res2, i) => {
    if (res2.status === 'rejected') errors[labels[i]] = String(res2.reason?.message || res2.reason);
  });

  const rdvToday = pick(1, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } });
  const rdvBooked = pick(2, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } });

  return {
    generatedAt: new Date().toISOString(),
    range: { preset, label: range.label, start: range.start.toISOString(), end: range.end.toISOString() },
    calls: pick(0, { total: 0, detail: [] }),
    rdvToday,
    rdvBooked,
    propals: pick(3, { total: 0, detail: [] }),
    signatures: pick(4, { total: 0, totalAmount: 0, detail: [] }),
    revenue: pick(5, { totalAmount: 0, detail: [] }),
    salesforge: pick(6, { total: 0, detail: [] }),
    bdc: pick(7, { sent: { total: 0, detail: [] }, signed: { total: 0, detail: [] }, pending: { total: 0, detail: [] } }),
    errors: Object.keys(errors).length ? errors : null,
  };
}

app.get('/api/dashboard', requireAuth, async (req, res) => {
  const preset = req.query.preset || 'today';
  const range = resolveRange(preset, req.query.start, req.query.end);
  res.json(await collectData(preset, range));
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
  res.json(getSettings());
});

app.post('/api/admin/settings', requireAuth, (req, res) => {
  res.json(updateSettings(req.body || {}));
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
app.listen(PORT, () => {
  console.log(`OpenMedias Dashboard en écoute sur le port ${PORT}`);
});
