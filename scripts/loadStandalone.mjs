import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// 05/11/2026 : les liens versionnés (« styles.css?v=… », « app.js?v=… ») pointent vers le
// fichier sans le « ?v=… » — sinon le test du planning échoue (fichier introuvable).
export function loadStandalone(file) {
  const base = dirname(file);
  return readFileSync(file, 'utf8')
    .replace(/<link rel="stylesheet" href="([^"/][^"]*)">/g, (_, p) => '<style>' + readFileSync(resolve(base,p.split('?')[0]),'utf8') + '</style>')
    .replace(/<script src="([^"/][^"]*)"><\/script>/g, (_, p) => '<script>' + readFileSync(resolve(base,p.split('?')[0]),'utf8') + '</script>');
}
