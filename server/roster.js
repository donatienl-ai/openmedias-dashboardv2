// ==========================================
//  ROSTER DES COMMERCIAUX OPENMEDIAS
//  Liste de référence + matching de noms
// ==========================================
// Les sources (Aircall, Calendly, Salesforce) renvoient les noms
// dans des formats variés ("Streith Noemie", "Noémie Streith", etc.).
// On matche sur le NOM DE FAMILLE normalisé (sans accent, minuscule).

// Liste officielle : { display: nom affiché, last: nom de famille pour matching }
export const SALES = [
  { display: 'Romy ABDEN', last: 'abden' },
  { display: 'Clauvaine Battery', last: 'battery' },
  { display: 'Anastasia Bendali', last: 'bendali' },
  { display: 'Tim Cattiaux', last: 'cattiaux' },
  { display: 'David CHEA', last: 'chea' },
  { display: 'Antoine Corre', last: 'corre' },
  { display: 'Lucas Dias', last: 'dias' },
  { display: 'Imane DOENLEN', last: 'doenlen' },
  { display: 'Thomas Durand', last: 'durand' },
  { display: 'Jérémie GARO', last: 'garo' },
  { display: 'Louis Hubert', last: 'hubert' },
  { display: 'Thomas Jallais', last: 'jallais' },
  { display: 'Paul Jouannet', last: 'jouannet' },
  { display: 'Thaivin Jousselin', last: 'jousselin' },
  { display: 'Moni Kek', last: 'kek' },
  { display: 'Adrien Lassus', last: 'lassus' },
  { display: 'Louna LORION', last: 'lorion' },
  { display: 'Mickael MARCIANO', last: 'marciano' },
  { display: 'Yanis Mehal', last: 'mehal' },
  { display: 'Manon MEUNIER', last: 'meunier' },
  { display: 'François Millet', last: 'millet' },
  { display: 'Theo Molina', last: 'molina' },
  { display: 'Lisa Neveu', last: 'neveu' },
  { display: 'Fabio Poisson', last: 'poisson' },
  { display: 'Nicolas Poulain', last: 'poulain' },
  { display: 'Quentin PUREN', last: 'puren' },
  { display: 'Fouad Senhadji', last: 'senhadji' },
  { display: 'Rémi Simon', last: 'simon' },
  { display: 'Noemie Streith', last: 'streith' },
  { display: 'Valentin Tobni', last: 'tobni' },
];

/** Enlève accents + minuscule + trim. */
function normalize(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Tente de matcher un nom brut (depuis une source) à un sale du roster.
 * Match si le nom de famille du roster est présent dans le nom brut normalisé.
 * Renvoie le `display` du roster, ou le nom brut tel quel si pas de match.
 */
export function matchSale(rawName) {
  const norm = normalize(rawName);
  if (!norm) return null;
  const found = SALES.find((s) => norm.includes(s.last));
  return found ? found.display : rawName;
}

/**
 * Construit la liste complète : tous les sales du roster avec leur valeur,
 * 0 pour ceux absents de `dataMap`. dataMap = Map(displayName -> {count, amount}).
 * Renvoie un tableau trié par valeur décroissante (puis alphabétique).
 */
export function buildFullList(dataMap, withAmount = false) {
  const rows = SALES.map((s) => {
    const entry = dataMap.get(s.display) || { count: 0, amount: 0 };
    return withAmount
      ? { name: s.display, count: entry.count, amount: entry.amount }
      : { name: s.display, count: entry.count };
  });
  rows.sort((a, b) => {
    const va = withAmount ? a.amount : a.count;
    const vb = withAmount ? b.amount : b.count;
    if (vb !== va) return vb - va;
    return a.name.localeCompare(b.name);
  });
  return rows;
}
