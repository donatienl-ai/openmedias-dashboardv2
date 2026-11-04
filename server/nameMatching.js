const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const wordsKey = value => normalize(value).split(' ').filter(Boolean).sort().join(' ');

export function resolveSaleName(rawName, roster = []) {
  const safeRoster = Array.isArray(roster) ? roster : [];
  const norm = normalize(rawName);

  // Nom vide : non attribué (04/11/2026, demande Lina — plus de rattachement par
  // défaut à Quentin). « Inconnu » reste tel quel, donc hors roster = non attribué.
  if (!norm) return null;
  if (norm === 'inconnu' || norm === 'unknown' || norm === 'unassigned') return rawName;

  const exact = safeRoster.filter(s => s && s.display && wordsKey(s.display) === wordsKey(rawName));
  if (exact.length === 1) return exact[0].display;

  const candidates = safeRoster.filter(s => s && [s.last, ...(s.aliases || [])].some(alias => {
    const key = normalize(alias);
    return key && ` ${norm} `.includes(` ${key} `);
  }));

  return candidates.length === 1 ? candidates[0].display : rawName;
}

export function completeRosterRows(dataMap, roster = [], withAmount = false) {
  const safeRoster = Array.isArray(roster) ? roster : [];
  const safeMap = dataMap instanceof Map ? dataMap : new Map();

  // Fusion des données. Plus de redirection « Inconnu » → Quentin (04/11/2026) :
  // ce qui n'est rattaché à personne reste non attribué.
  const mergedMap = new Map();

  for (const [name, entry] of safeMap.entries()) {
    const norm = normalize(name);
    void norm;
    const targetName = name;

    const current = mergedMap.get(targetName) || { count: 0, amount: 0, inbound: 0, outbound: 0 };
    mergedMap.set(targetName, {
      ...current,
      ...entry,
      count: (current.count || 0) + (entry?.count || 0),
      amount: (current.amount || 0) + (entry?.amount || 0),
      inbound: (current.inbound || 0) + (entry?.inbound || 0),
      outbound: (current.outbound || 0) + (entry?.outbound || 0),
    });
  }

  const known = new Set(safeRoster.map(s => s?.display).filter(Boolean));
  const rows = safeRoster.map(s => {
    const displayName = s?.display || '';
    const entry = mergedMap.get(displayName) || {};
    return { name: displayName, ...entry, count: entry.count || 0 };
  });

  for (const [name, entry] of mergedMap.entries()) {
    if (name && !known.has(name)) {
      rows.push({ name, ...entry, count: entry.count || 0, unmatched: true });
    }
  }

  if (withAmount) {
    for (const row of rows) row.amount = row.amount || 0;
  }

  return rows.sort((a, b) => (withAmount ? (b.amount || 0) - (a.amount || 0) : (b.count || 0) - (a.count || 0)) || (a.name || '').localeCompare(b.name || ''));
}
