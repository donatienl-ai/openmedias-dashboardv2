const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const wordsKey = value => normalize(value).split(' ').filter(Boolean).sort().join(' ');

export function resolveSaleName(rawName, roster = []) {
  const safeRoster = Array.isArray(roster) ? roster : [];
  const norm = normalize(rawName);

  // Détermine le nom exact de Quentin dans l'équipe
  const quentinEntry = safeRoster.find(s => s && s.display && normalize(s.display).includes('quentin'));
  const quentinName = quentinEntry ? quentinEntry.display : 'Quentin';

  // Si le nom est vide, null ou égal à "inconnu" / "unassigned"
  if (!norm || norm === 'inconnu' || norm === 'unknown' || norm === 'unassigned') {
    return quentinName;
  }

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
  const known = new Set(safeRoster.map(s => s?.display).filter(Boolean));

  const quentinEntry = safeRoster.find(s => s && s.display && normalize(s.display).includes('quentin'));
  const quentinName = quentinEntry ? quentinEntry.display : 'Quentin';

  // Copie de travail de la map de données
  const map = new Map(dataMap || []);

  // Fusion de sécurité : intercepte tout "Inconnu" restant et le verse sur Quentin
  for (const [name, entry] of map) {
    const norm = normalize(name);
    if (!norm || norm === 'inconnu' || norm === 'unknown') {
      if (name !== quentinName) {
        const qEntry = map.get(quentinName) || { count: 0, amount: 0, inbound: 0, outbound: 0 };
        map.set(quentinName, {
          ...qEntry,
          count: (qEntry.count || 0) + (entry.count || 0),
          amount: (qEntry.amount || 0) + (entry.amount || 0),
          inbound: (qEntry.inbound || 0) + (entry.inbound || 0),
          outbound: (qEntry.outbound || 0) + (entry.outbound || 0),
        });
        map.delete(name);
      }
    }
  }

  const rows = safeRoster.map(s => ({
    name: s?.display || '',
    ...(map.get(s?.display) || {}),
    count: map.get(s?.display)?.count || 0
  }));

  for (const [name, entry] of map) {
    if (name && !known.has(name)) {
      rows.push({ name, ...entry, count: entry?.count || 0, unmatched: true });
    }
  }

  if (withAmount) for (const row of rows) row.amount = row.amount || 0;
  return rows.sort((a, b) => (withAmount ? (b.amount || 0) - (a.amount || 0) : (b.count || 0) - (a.count || 0)) || (a.name || '').localeCompare(b.name || ''));
}
