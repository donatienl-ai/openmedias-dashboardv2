#!/usr/bin/env node
// ==========================================
//  SMOKE TEST : le serveur démarre-t-il et répond-il ?
// ==========================================
// Utilisé en CI (voir .github/workflows/ci.yml) et localement (`npm run
// smoke`). Ne teste PAS les vraies données (aucune clé API réelle requise) :
// vérifie juste que rien ne casse au démarrage — imports, routes, DB SQLite —
// avant de pousser sur Render. Le bug déjà rencontré ("Module not found:
// Can't resolve './calendly.js'") aurait été détecté ici avant le déploiement.
//
// Toute variable d'env DÉJÀ présente (process.env) est respectée ; celles qui
// manquent reçoivent une valeur factice suffisante pour que le serveur
// démarre (aucune route testée ici n'appelle une vraie API externe).
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.SMOKE_PORT || '3987';

const tmpDb = path.join(os.tmpdir(), `om-smoke-${Date.now()}.db`);

const DEFAULT_ENV = {
  PORT,
  DASHBOARD_PASSWORD: 'smoke-test',
  DB_PATH: tmpDb,
  AIRCALL_API_ID: 'x', AIRCALL_API_TOKEN: 'x',
  CALENDLY_TOKEN: 'x', CALENDLY_ORG_URI: 'x',
  SALESFORCE_CLIENT_ID: 'x', SALESFORCE_CLIENT_SECRET: 'x', SALESFORCE_DOMAIN_URL: 'https://example.my.salesforce.com',
  DOCUSIGN_INTEGRATION_KEY: 'x', DOCUSIGN_USER_ID: 'x', DOCUSIGN_PRIVATE_KEY: 'x',
  MAILJET_API_KEY: 'x', MAILJET_SECRET_KEY: 'x', REPORT_FROM_EMAIL: 'a@b.com', REPORT_TO: 'a@b.com', REPORT_KEY: 'x',
  PIN_EDIT: '1111', PIN_COM: '2222', SF_WEBHOOK_SECRET: 'x',
};

const env = { ...DEFAULT_ENV, ...process.env };

function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get(`http://localhost:${PORT}/api/health`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 200) resolve(JSON.parse(body));
          else retry(`HTTP ${res.statusCode}`);
        });
      });
      req.on('error', (e) => retry(e.message));
    }
    function retry(reason) {
      if (Date.now() > deadline) return reject(new Error(`/api/health injoignable après ${timeoutMs}ms (dernière erreur: ${reason})`));
      setTimeout(attempt, 400);
    }
    attempt();
  });
}

async function main() {
  console.log(`[smoke] démarrage du serveur sur le port ${PORT} (DB temporaire: ${tmpDb})...`);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));

  const cleanup = () => {
    child.kill();
    try { fs.unlinkSync(tmpDb); } catch {}
  };

  try {
    const health = await waitForHealth(15000);
    console.log('[smoke] /api/health OK :', JSON.stringify(health));
    console.log('[smoke] TOUT PASSE ✓');
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error('[smoke] ÉCHEC :', err.message);
    console.error('[smoke] logs du serveur :\n' + logs);
    cleanup();
    process.exit(1);
  }
}

main();
