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

app.get('/api/dashboard', requireAuth, async (req, res) => {
  // Plage de dates : preset (today par défaut) + custom start/end éventuels
  const preset = req.query.preset || 'today';
  const range = resolveRange(preset, req.query.start, req.query.end);
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

  res.json({
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
  });
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
