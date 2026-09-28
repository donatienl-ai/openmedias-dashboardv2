const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const wordsKey = value => normalize(value).split(' ').filter(Boolean).sort().join(' ');

export function resolveSaleName(rawName, roster) {
  const norm = normalize(rawName);

  // Redirection automatique des entrées sans nom ou "Inconnu" vers Quentin PUREN
  if (!norm || norm === 'inconnu') {
    const quentin = roster.find(s => normalize(s.display).includes('quentin puren'));
    if (quentin) return quentin.display;
    return null;
  }

  const exact = roster.filter(s => wordsKey(s.display) === wordsKey(rawName));
  if (exact.length === 1) return exact[0].display;
  const candidates = roster.filter(s => [s.last, ...(s.aliases || [])].some(alias => {
    const key = normalize(alias);
    return key && ` ${norm} `.includes(` ${key} `);
  }));
  // Never silently assign an ambiguous name to the first person in the roster.
  return candidates.length === 1 ? candidates[0].display : rawName;
}

export function completeRosterRows(dataMap, roster, withAmount = false) {
  const known = new Set(roster.map(s => s.display));
  const rows = roster.map(s => ({ name: s.display, ...(dataMap.get(s.display) || {}), count: dataMap.get(s.display)?.count || 0 }));
  // Keep unmatched records visible in the unrestricted total and its detail.
  for (const [name, entry] of dataMap) {
    if (!known.has(name)) rows.push({ name, ...entry, count: entry.count || 0, unmatched: true });
  }
  if (withAmount) for (const row of rows) row.amount = row.amount || 0;
  return rows.sort((a,b) => (withAmount ? b.amount-a.amount : b.count-a.count) || a.name.localeCompare(b.name));
}
