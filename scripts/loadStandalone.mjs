import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function loadStandalone(file) {
  const base = dirname(file);
  return readFileSync(file, 'utf8')
    .replace(/<link rel="stylesheet" href="([^"/][^"]*)">/g, (_, p) => '<style>' + readFileSync(resolve(base,p),'utf8') + '</style>')
    .replace(/<script src="([^"/][^"]*)"><\/script>/g, (_, p) => '<script>' + readFileSync(resolve(base,p),'utf8') + '</script>');
}
