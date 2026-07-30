// Déploiement en une commande : npm run deploy -- "message de commit"
// Render rebuild et redéploie automatiquement à chaque push sur main
// (auto-deploy actif sur le service, voir onglet Settings > Build & Deploy).
import { execSync } from 'node:child_process';

const msg = process.argv.slice(2).join(' ').trim() || 'Mise à jour';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

run('git add -A');
try {
  run(`git commit -m ${JSON.stringify(msg)}`);
} catch {
  console.log('Rien de nouveau à committer — on push quand même au cas où.');
}
run('git push');
console.log('\n✅ Poussé sur main. Render rebuild automatiquement (~3-5 min).');
