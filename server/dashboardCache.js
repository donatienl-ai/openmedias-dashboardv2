// ============================================================
//  CACHE DASHBOARD + SYNC EN ARRIÈRE-PLAN
// ============================================================
//  Découple la récupération (lente, via les 5 APIs) de l'affichage
//  (instantané). Le navigateur ne tape plus jamais les APIs en direct :
//  il lit un snapshot pré-calculé, gardé à jour par un rafraîchissement
//  périodique.
//
//  Garde-fous :
//   - stale-while-revalidate : on sert le cache immédiatement, même
//     légèrement périmé, et on recalcule en tâche de fond.
//   - single-flight : deux requêtes simultanées sur la même période ne
//     déclenchent qu'UN seul appel aux APIs (protège des rate limits).
//
//  Le module ne connaît rien des APIs : on lui injecte collectData et
//  resolveRange. Il reste donc 100 % découplé du reste du serveur.
// ============================================================

export function createDashboardCache({
  compute,                       // async (preset, range) => data   → ta fonction collectData
  resolveRange,                  // (preset, start?, end?) => range  → ta fonction existante
  warmPresets = ['today', 'yesterday', 'this_week', 'this_month'],
  ttlMs = 5 * 60 * 1000,         // en-deçà : snapshot considéré "frais" → réponse immédiate
  staleMs = 30 * 60 * 1000,      // au-delà : on attend le recalcul plutôt que de servir du vieux
} = {}) {
  if (typeof compute !== 'function') throw new Error('createDashboardCache: "compute" est requis');
  if (typeof resolveRange !== 'function') throw new Error('createDashboardCache: "resolveRange" est requis');

  const store = new Map();    // key -> { data, fetchedAt, error }
  const inflight = new Map(); // key -> Promise (single-flight)

  // Les presets standards sont mis en cache par nom ; les plages custom
  // par bornes exactes (rares, donc pas pré-chauffées).
  const keyFor = (preset, range) => {
    if (preset && preset !== 'custom') return `preset:${preset}`;
    const s = range?.start?.toISOString?.() ?? range?.start ?? '';
    const e = range?.end?.toISOString?.() ?? range?.end ?? '';
    return `range:${s}|${e}`;
  };

  // Recalcule un snapshot, avec single-flight et conservation de l'ancien en cas d'erreur.
  function recompute(preset, range, key) {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve()
      .then(() => compute(preset, range))
      .then((data) => {
        store.set(key, { data, fetchedAt: Date.now(), error: null });
        return data;
      })
      .catch((err) => {
        const prev = store.get(key);
        store.set(key, {
          data: prev?.data ?? null,
          fetchedAt: prev?.fetchedAt ?? 0,
          error: String(err?.message || err),
        });
        throw err;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // Lecture côté route : sert le cache, recalcule en fond si nécessaire.
  async function get(preset, range) {
    const key = keyFor(preset, range);
    const entry = store.get(key);
    const age = entry?.fetchedAt ? Date.now() - entry.fetchedAt : Infinity;

    // Cache frais → réponse immédiate.
    if (entry?.data && age < ttlMs) {
      return { ...entry.data, _cache: { hit: true, ageMs: age } };
    }

    // Cache périmé mais exploitable → on sert l'ancien ET on rafraîchit en fond.
    if (entry?.data && age < staleMs) {
      recompute(preset, range, key).catch(() => {});
      return { ...entry.data, _cache: { hit: true, stale: true, ageMs: age } };
    }

    // Rien d'utilisable (1er chargement ou trop vieux) → on attend le calcul.
    const data = await recompute(preset, range, key);
    return { ...data, _cache: { hit: false, ageMs: 0 } };
  }

  // Appelée par le scheduler : rafraîchit toutes les périodes chaudes en parallèle.
  async function refreshAll() {
    const results = await Promise.allSettled(
      warmPresets.map((preset) => {
        const range = resolveRange(preset);
        return recompute(preset, range, keyFor(preset, range));
      })
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    return { refreshed: ok, total: warmPresets.length, at: new Date().toISOString() };
  }

  // Diagnostic (à exposer sur une route protégée si tu veux suivre l'état du cache).
  function stats() {
    return [...store.entries()].map(([key, e]) => ({
      key,
      ageMs: e.fetchedAt ? Date.now() - e.fetchedAt : null,
      hasData: !!e.data,
      error: e.error,
    }));
  }

  return { get, refreshAll, stats, warmPresets };
}
