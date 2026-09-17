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
    getCalls(r),              // 0
    getRdvInRange(r),         // 1
    getRdvBookedInRange(r),   // 2
    getPropals(r),            // 3
    getSignatures(r),         // 4
    getRevenue(r),            // 5
    getSalesforgeRdv(r),      // 6 (UTM salesforge via Calendly, suit la période)
    getBdc(r),                // 7 (BDC envoyés/signés via DocuSign)
    getPropalsComptes(r),     // 8 (propositions sur Comptes, Salesforce)
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

  // Repère "mois en cours" affiché sous CA & Signatures, indépendant de la période.
  // Si la période sélectionnée EST déjà ce mois, on réutilise (pas de requête en plus).
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
    calls: pick(0, { total: 0, detail: [] }),
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
    // Objectif de CA mensuel (alerte de seuil sur la tuile CA, cf. client) —
    // exposé à TOUT compte connecté (pas juste admin) puisque c'est juste un
    // repère informatif, contrairement au reste de la console admin.
    settings: { monthlyRevenueObjective: getReportSettings().monthlyRevenueObjective },
    errors: Object.keys(errors).length ? errors : null,
  };
}

// Données de comparaison (totaux/détails des 6 KPIs principaux, hors SalesForge)
async function collectCompareData(range) {
  const r = { start: range.start, end: range.end };
  const results = await Promise.allSettled([
    getCalls(r),               // 0
    getRdvInRange(r),          // 1 (R1/R2 tenus)
    getRdvBookedInRange(r),    // 2 (R1/R2 pris)
    getPropals(r),             // 3
    getPropalsComptes(r),      // 4
    getSignatures(r),          // 5
    getRevenue(r),             // 6
  ]);
  const labels = ['calls', 'rdvToday', 'rdvBooked', 'propals', 'propalsComptes', 'signatures', 'revenue'];
  const errors = Object.fromEntries(results.flatMap((r, i) => r.status === 'rejected' ? [[labels[i], 'Comparaison indisponible']] : []));
  const v = (idx, fb) => (results[idx].status === 'fulfilled' ? results[idx].value : fb);
  return {
    errors: Object.keys(errors).length ? errors : null,
    calls: v(0, { total: 0, detail: [] }),
    rdvToday: v(1, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } }),
    rdvBooked: v(2, { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } }),
    propals: v(3, { total: 0, totalAmount: 0, detail: [] }),
    propalsComptes: v(4, { total: 0, totalAmount: 0, detail: [] }),
    signatures: v(5, { total: 0, totalAmount: 0, detail: [] }),
    revenue: v(6, { totalAmount: 0, detail: [] }),
  };
}

// Construit le payload complet du dashboard (données + comparatif) pour une plage.
// C'est la fonction "lourde" (appels APIs) que le cache enveloppe.
async function computeDashboard(preset, range) {
  // Comparatif désactivé sur les très longues périodes (>70j) pour préserver les quotas
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
