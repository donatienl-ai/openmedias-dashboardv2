const labels = { aircall: 'Aircall', calendly: 'Calendly', salesforce: 'Salesforce', docusign: 'DocuSign' };

// Cache timestamps are observations, not a guarantee of vendor-side freshness.
export function buildSourceSnapshot(stats, now = Date.now()) {
  return Object.entries(labels).map(([id, label]) => {
    const caches = Object.values(stats[id] || {}).filter(Boolean);
    const ages = caches.map(c => c.ageMs).filter(age => typeof age === 'number' && Number.isFinite(age) && age >= 0);
    return {
      id, label,
      oldestCacheAt: ages.length ? new Date(now - Math.max(...ages)).toISOString() : null,
      observedAt: new Date(now).toISOString(),
      incomplete: caches.some(c => c.truncated),
    };
  });
}
