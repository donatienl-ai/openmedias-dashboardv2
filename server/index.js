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
  ]);

  const pick = (i, fallback) =>
    results[i].status === 'fulfilled' ? results[i].value : fallback;

  const errors = {};
  const labels = ['calls', 'rdvToday', 'rdvBooked', 'propals', 'signatures', 'revenue', 'salesforge'];
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
