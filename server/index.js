// ==========================================
//  SERVEUR PRINCIPAL - OPENMEDIAS DASHBOARD
// ==========================================
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCallsToday } from './aircall.js';
import { getRdvToday, getRdvBookedToday } from './calendly.js';
import {
  getSignaturesToday,
  getRevenueThisMonth,
  getPropalsToday,
} from './salesforce.js';
import { getSalesforgeData } from './sheets.js';

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

// --- Route principale : agrège toutes les sources ---
app.get('/api/dashboard', requireAuth, async (req, res) => {
  // On lance tous les appels en parallèle. Si une source plante,
  // on renvoie quand même les autres avec une erreur partielle.
  const results = await Promise.allSettled([
    getCallsToday(),          // 0
    getRdvToday(),            // 1
    getRdvBookedToday(),      // 2
    getPropalsToday(),        // 3
    getSignaturesToday(),     // 4
    getRevenueThisMonth(),    // 5
    getSalesforgeData(),      // 6
  ]);

  const pick = (i, fallback) =>
    results[i].status === 'fulfilled' ? results[i].value : fallback;

  const errors = {};
  const labels = ['calls', 'rdvToday', 'rdvBooked', 'propals', 'signatures', 'revenue', 'salesforge'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') errors[labels[i]] = String(r.reason?.message || r.reason);
  });

  const rdvToday = pick(1, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } });
  const rdvBooked = pick(2, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } });

  res.json({
    generatedAt: new Date().toISOString(),
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
