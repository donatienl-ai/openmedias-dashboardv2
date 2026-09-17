#!/usr/bin/env node
// ==========================================
//  VÉRIFICATION DE SYNTAXE (node --check) SUR TOUS LES FICHIERS SERVEUR
// ==========================================
// Équivalent cross-plateforme (Windows/PowerShell inclus) d'une boucle bash
// `for f in server/*.js; do node --check "$f"; done` — utilisé par `npm run
// check` et par la CI (voir .github/workflows/ci.yml).
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// `fs.globSync` n'existe qu'à partir de Node 22 — ce projet cible Node 20.x
// (cf. package.json "engines", NODE_VERSION sur Render pour better-sqlite3),
// donc on liste les dossiers manuellement plutôt que d'utiliser un glob.
function jsFilesIn(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((f) => f.isDirectory() && f.name !== 'tests' ? jsFilesIn(path.join(dir, f.name)) : f.isFile() && f.name.endsWith('.js') ? [path.join(dir, f.name)] : []);
}
const files = [...jsFilesIn('server'), ...jsFilesIn('planning/backend'), ...jsFilesIn('planning/frontend'), ...jsFilesIn('recouvrement/frontend'), ...jsFilesIn('radar/frontend')];

let failed = false;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { cwd: ROOT, stdio: 'pipe' });
    console.log(`ok: ${f}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL: ${f}`);
    console.error(e.stderr?.toString() || e.message);
  }
}

if (failed) {
  console.error('\n✗ Au moins un fichier a une erreur de syntaxe.');
  process.exit(1);
}
console.log(`\n✓ ${files.length} fichiers vérifiés, tout est bon.`);
