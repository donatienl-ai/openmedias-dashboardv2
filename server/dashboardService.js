// Agrégation métier, indépendante du serveur et testable avec des sources fictives.
export function withLiveDashboardSettings(snapshot, settings) {
  return { ...snapshot, settings: { monthlyRevenueObjective: settings.monthlyRevenueObjective } };
}

export function createDashboardService({ getCalls, getRdvInRange, getRdvBookedInRange, getPropals, getSignatures, getRevenue, getSalesforgeRdv, getBdc, getPropalsComptes, resolveRange, comparisonRange, getReportSettings, sourceSnapshot = () => [] }) {
async function collectData(preset, range) {
  const r = { start: range.start, end: range.end };

  // On lance tous les appels en parallèle. Si une source plante,
  // on renvoie quand même les autres avec une erreur partielle.
  const results = await Promise.allSettled([
    getCalls(r),               // 0
    getRdvInRange(r),          // 1
    getRdvBookedInRange(r),    // 2
    getPropals(r),             // 3
    getSignatures(r),          // 4
    getRevenue(r),             // 5
    getSalesforgeRdv(r),       // 6 (UTM salesforge via Calendly, suit la période)
    getBdc(r),                 // 7 (BDC envoyés/signés via DocuSign)
    getPropalsComptes(r),      // 8 (propositions sur Comptes, Salesforce)
  ]);

  const pick = (i, fallback) =>
    results[i].status === 'fulfilled' ? results[i].value : fallback;

  const errors = {};
  const labels = ['calls', 'rdvToday', 'rdvBooked', 'propals', 'signatures', 'revenue', 'salesforge', 'bdc', 'propalsComptes'];
  results.forEach((res2, i) => {
    if (res2.status === 'rejected') errors[labels[i]] = String(res2.reason?.message || res2.reason);
  });

  const rdvToday = pick(1, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } });
  const rdvBooked = pick(2, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } });

  const revenue = pick(5, { totalAmount: 0, detail: [] });
  const signatures = pick(4, { total: 0, totalAmount: 0, detail: [] });

  // Récupération des appels et réattribution de l'historique "Inconnu" à Quentin PUREN
  const rawCalls = pick(0, { total: 0, detail: [] });
  const callsMap = new Map();

  (rawCalls.detail || []).forEach(item => {
    let name = (item.name || item.commercial || item.label || '').trim();
    
    // Si l'entrée est marquée "Inconnu" ou vide, on la réattribue à Quentin PUREN
    if (!name || name.toLowerCase() === 'inconnu') {
      name = 'Quentin PUREN';
    }

    const currentCalls = item.calls || item.count || item.value || 0;
    const existing = callsMap.get(name) || { ...item, name, calls: 0 };
    existing.calls = (existing.calls || 0) + currentCalls;
    callsMap.set(name, existing);
  });

  const reattributedCallsDetail = Array.from(callsMap.values()).sort((a, b) => b.calls - a.calls);

  const filteredCalls = {
    ...rawCalls,
    detail: reattributedCallsDetail,
    total: reattributedCallsDetail.reduce((acc, curr) => acc + (curr.calls || 0), 0) || rawCalls.total
  };

  // Repère "mois en cours" affiché sous CA & Signatures, indépendant de la période.
  let monthRevenue = revenue;
  let monthSignatures = signatures;
  if (preset === 'this_month') {
    if (errors.revenue) errors.monthRevenue = errors.revenue;
    if (errors.signatures) errors.monthSignatures = errors.signatures;
  }
  if (preset !== 'this_month') {
    const m = resolveRange('this_month');
    const [mr, ms] = await Promise.allSettled([
      getRevenue({ start: m.start, end: m.end }),
      getSignatures({ start: m.start, end: m.end }),
    ]);
    monthRevenue = mr.status === 'fulfilled' ? mr.value : { totalAmount: 0, detail: [] };
    monthSignatures = ms.status === 'fulfilled' ? ms.value : { total: 0, totalAmount: 0, detail: [] };
    if (mr.status === 'rejected') errors.monthRevenue = 'CA du mois indisponible';
    if (ms.status === 'rejected') errors.monthSignatures = 'Ventes gagnées du mois indisponibles';
  }

  return {
    generatedAt: new Date().toISOString(),
    sources: sourceSnapshot(),
    range: { preset, label: range.label, start: range.start.toISOString(), end: range.end.toISOString() },
    calls: filteredCalls,
    rdvToday,
    rdvBooked,
    propals: pick(3, { total: 0, totalAmount: 0, detail: [] }),
    signatures,
    revenue,
    monthRevenue,
    monthSignatures,
    salesforge: pick(6, { total: 0, detail: [] }),
    bdc: pick(7, { sent: { total: 0, detail: [] }, signed: { total: 0, detail: [] }, pending: { total: 0, detail: [] } }),
    propalsComptes: pick(8, { total: 0, totalAmount: 0, detail: [] }),
    settings: { monthlyRevenueObjective: getReportSettings().monthlyRevenueObjective },
    errors: Object.keys(errors).length ? errors : null,
  };
}

// Données de comparaison
async function collectCompareData(range) {
  const r = { start: range.start, end: range.end };
  const results = await Promise.allSettled([
    getCalls(r),               // 0
    getRdvInRange(r),          // 1
    getRdvBookedInRange(r),    // 2
    getPropals(r),             // 3
    getPropalsComptes(r),      // 4
    getSignatures(r),          // 5
    getRevenue(r),             // 6
  ]);
  const labels = ['calls', 'rdvToday', 'rdvBooked', 'propals', 'propalsComptes', 'signatures', 'revenue'];
  const errors = Object.fromEntries(results.flatMap((r, i) => r.status === 'rejected' ? [[labels[i], 'Comparaison indisponible']] : []));
  const v = (idx, fb) => (results[idx].status === 'fulfilled' ? results[idx].value : fb);

  const rawCompCalls = v(0, { total: 0, detail: [] });
  const compCallsMap = new Map();

  (rawCompCalls.detail || []).forEach(item => {
    let name = (item.name || item.commercial || item.label || '').trim();
    if (!name || name.toLowerCase() === 'inconnu') {
      name = 'Quentin PUREN';
    }
    const currentCalls = item.calls || item.count || item.value || 0;
    const existing = compCallsMap.get(name) || { ...item, name, calls: 0 };
    existing.calls = (existing.calls || 0) + currentCalls;
    compCallsMap.set(name, existing);
  });

  const reattributedCompCallsDetail = Array.from(compCallsMap.values()).sort((a, b) => b.calls - a.calls);

  const filteredCompCalls = {
    ...rawCompCalls,
    detail: reattributedCompCallsDetail,
    total: reattributedCompCallsDetail.reduce((acc, curr) => acc + (curr.calls || 0), 0) || rawCompCalls.total
  };

  return {
    errors: Object.keys(errors).length ? errors : null,
    calls: filteredCompCalls,
    rdvToday: v(1, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } }),
    rdvBooked: v(2, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } }),
    propals: v(3, { total: 0, totalAmount: 0, detail: [] }),
    propalsComptes: v(4, { total: 0, totalAmount: 0, detail: [] }),
    signatures: v(5, { total: 0, totalAmount: 0, detail: [] }),
    revenue: v(6, { totalAmount: 0, detail: [] }),
  };
}

async function computeDashboard(preset, range) {
  const durationDays = (range.end - range.start) / 86400000;
  const wantCompare = durationDays <= 70;
  const compRange = wantCompare ? comparisonRange(preset, range) : null;

  const [data, compare] = await Promise.all([
    collectData(preset, range),
    compRange ? collectCompareData(compRange).catch(() => null) : Promise.resolve(null),
  ]);

  return { ...data, compare };
}

return { collectData, collectCompareData, computeDashboard };
}
