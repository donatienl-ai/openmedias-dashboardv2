// ============================================================
//  CACHE GÉNÉRIQUE DE DONNÉES BRUTES (fenêtre élargissable)
// ============================================================
//  Généralise le pattern déjà utilisé par Aircall (server/aircall.js,
//  `ensureCalls`/`selectCalls`) : on garde en mémoire tous les enregistrements
//  bruts (allégés) déjà vus sur la PLUS LARGE fenêtre demandée. Toute
//  sous-période est ensuite un simple FILTRAGE en mémoire, sans rappeler
//  l'API. Élargir la fenêtre ne refait pas un fetch complet : seule la
//  partie manquante est récupérée puis fusionnée à l'existant.
//
//  Corrige un point relevé plusieurs fois : contrairement à Aircall,
//  Salesforce, Calendly et DocuSign n'avaient pas ce cache — toute plage de
//  dates "custom" retapait l'API en direct à chaque chargement.
//
//  Garde-fou mémoire (leçon de l'incident OOM Calendly, cf. `pruneScanCache`
//  dans calendly.js) : UNE seule fenêtre par instance (pas d'explosion par
//  clé de plage), et `mapRecord` DOIT renvoyer une version allégée du record
//  (seulement les champs utiles), jamais l'objet brut complet de l'API.
//
//  Choix du TTL par l'appelant : les données réellement IMMUABLES une fois
//  écrites (ex : Opportunity déjà Closed Won, call Aircall déjà passé)
//  peuvent avoir un TTL long (30 min+). Les données qui reflètent un STATUT
//  COURANT et mutable (ex : Lead "Working", enveloppe DocuSign "en attente")
//  doivent garder un TTL court (5 min par défaut) pour ne pas afficher un
//  statut périmé.
// ============================================================

export function createWideningCache({
  fetchWindow, // async (fromMs, toMs) => rawRecords[]  (gère sa propre pagination/retry)
  mapRecord, // rawRecord => { at: ms, ...champs utiles allégés }
  ttlMs = 5 * 60 * 1000, // au-delà : on referait un fetch complet plutôt que d'élargir
} = {}) {
  if (typeof fetchWindow !== 'function') throw new Error('createWideningCache: "fetchWindow" est requis');
  if (typeof mapRecord !== 'function') throw new Error('createWideningCache: "mapRecord" est requis');

  let cache = { from: 0, to: 0, fetchedAt: 0, records: [] };
  let inflight = null; // single-flight : une seule fenêtre récupérée à la fois

  function isFresh() {
    return cache.fetchedAt > 0 && Date.now() - cache.fetchedAt < ttlMs;
  }
  function covers(fromMs, toMs) {
    return isFresh() && fromMs >= cache.from && toMs <= cache.to;
  }

  /** Garantit que le cache couvre [fromMs, toMs], en élargissant si besoin. */
  async function ensure(fromMs, toMs) {
    if (covers(fromMs, toMs)) return;
    if (inflight) {
      await inflight.catch(() => {});
      if (covers(fromMs, toMs)) return;
    }

    // Élargissement tant que le cache est frais (on ne rétrécit jamais la fenêtre gardée).
    const fresh = isFresh();
    const winFrom = fresh ? Math.min(fromMs, cache.from) : fromMs;
    const winTo = fresh ? Math.max(toMs, cache.to) : toMs;

    inflight = (async () => {
      const raw = await fetchWindow(winFrom, winTo);
      const mapped = raw.map(mapRecord);
      // Un autre appel a pu terminer entre-temps et déjà élargir le cache :
      // on fusionne sans jamais rétrécir la couverture obtenue.
      const stillFresh = isFresh();
      const newFrom = stillFresh ? Math.min(winFrom, cache.from) : winFrom;
      const newTo = stillFresh ? Math.max(winTo, cache.to) : winTo;
      const kept = stillFresh ? cache.records.filter((r) => r.at < winFrom || r.at > winTo) : [];
      cache = { from: newFrom, to: newTo, fetchedAt: Date.now(), records: kept.concat(mapped) };
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  }

  function select(fromMs, toMs) {
    return cache.records.filter((r) => r.at >= fromMs && r.at <= toMs);
  }

  /** Lecture principale : garantit la couverture puis renvoie les records de la plage. */
  async function get(fromMs, toMs) {
    await ensure(fromMs, toMs);
    return select(fromMs, toMs);
  }

  /** Diagnostic (utile sur une route /api/health ou de debug). */
  function stats() {
    return {
      from: cache.from || null,
      to: cache.to || null,
      count: cache.records.length,
      ageMs: cache.fetchedAt ? Date.now() - cache.fetchedAt : null,
      fresh: isFresh(),
    };
  }

  return { get, ensure, select, stats };
}
