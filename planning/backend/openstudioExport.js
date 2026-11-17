// ── EXPORT OPENSTUDIO (lecture seule) ─────────────────────────────────────────
// GET /planning/api/openstudio/diffusions : les diffusions vidéo du planning, lues par OpenStudio
// (plateforme clients) pour créer les espaces, les codes de connexion, les dossiers Drive et le mail
// du jour de diffusion.
//
// - LECTURE SEULE : uniquement des SELECT, rien n'est écrit dans la base du planning.
// - Accès réservé à OpenStudio : en-tête X-OpenStudio-Key = variable OPENSTUDIO_EXPORT_KEY.
//   Sans cette variable, la route répond 503 (désactivée).
// - Toutes les diffusions vidéo sont renvoyées quel que soit leur statut (confirmée, à programmer,
//   annulée…) : c'est OpenStudio qui décide quoi faire de chaque statut (création, report, annulation).
// - Contact : le signataire du bon de commande DocuSign rattaché à la diffusion (BDC signé en priorité,
//   sinon le plus récent).
const crypto = require('crypto');

// Formats qui donnent une vidéo au client. Modifiable sans code : OPENSTUDIO_FORMATS="Plateau TV,Immersion,Spot TV"
const DEFAULT_FORMATS = ['Plateau TV', 'Immersion'];
const DEFAULT_PAST_DAYS = 90;

function videoFormats(env = process.env) {
  const raw = String(env.OPENSTUDIO_FORMATS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_FORMATS;
}

function keyMatches(expected, provided) {
  if (!expected || typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Une ligne par diffusion vidéo, avec le signataire du BDC le plus pertinent.
// Les diffusions « à programmer » sont toujours incluses, même avec une ancienne date.
function buildQuery(formatCount) {
  const placeholders = Array.from({ length: formatCount }, () => '?').join(',');
  return `
    SELECT e.id, e.sf_opportunity_id, e.entreprise, e.secteur, e.media, e.sous_media, e.format,
           e.date_diffusion, e.statut, e.commercial, e.updated_at,
           b.contact AS bdc_contact, b.email AS bdc_email, b.statut AS bdc_statut
    FROM emissions e
    LEFT JOIN bdc_envois b ON b.id = (
      SELECT b2.id FROM bdc_envois b2
      WHERE b2.emission_id = e.id AND b2.email IS NOT NULL AND b2.email <> ''
      ORDER BY (b2.statut = 'signe') DESC, b2.updated_at DESC, b2.id DESC
      LIMIT 1
    )
    WHERE e.format IN (${placeholders})
      AND (e.date_diffusion >= ? OR e.statut = 'a_programmer')
      AND (? IS NULL OR e.updated_at >= ?)
    ORDER BY e.date_diffusion ASC, e.id ASC`;
}

function toDiffusion(r) {
  return {
    id: r.id,
    sfOpportunityId: r.sf_opportunity_id || null,
    entreprise: r.entreprise,
    secteur: r.secteur || null,
    media: r.media,
    sousMedia: r.sous_media || null,
    format: r.format,
    dateDiffusion: r.date_diffusion,
    statut: r.statut,
    commercial: r.commercial || null,
    updatedAt: r.updated_at,
    contact: r.bdc_email ? { nom: r.bdc_contact || null, email: r.bdc_email, source: 'bdc', bdcSigne: r.bdc_statut === 'signe' } : null,
  };
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Diffusions vidéo à exporter.
 * @param db       base better-sqlite3 du planning
 * @param opts.from  date (AAAA-MM-JJ) à partir de laquelle prendre les diffusions (défaut : il y a 90 jours)
 * @param opts.since horodatage : seulement les diffusions modifiées depuis (synchronisation incrémentale)
 */
function listDiffusions(db, { from, since, env = process.env, now = new Date() } = {}) {
  const formats = videoFormats(env);
  const fromDay = /^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))
    ? from
    : isoDay(new Date(now.getTime() - DEFAULT_PAST_DAYS * 86400000));
  const sinceVal = since ? String(since) : null;
  const rows = db.prepare(buildQuery(formats.length)).all(...formats, fromDay, sinceVal, sinceVal);
  return { formats, from: fromDay, diffusions: rows.map(toDiffusion) };
}

function registerOpenstudioExport(app, db, env = process.env) {
  app.get('/api/openstudio/diffusions', (req, res) => {
    const key = env.OPENSTUDIO_EXPORT_KEY;
    if (!key) return res.status(503).json({ error: 'Export OpenStudio désactivé (OPENSTUDIO_EXPORT_KEY non configurée)' });
    if (!keyMatches(key, req.headers['x-openstudio-key'])) return res.status(403).json({ error: 'Unauthorized' });
    try {
      const out = listDiffusions(db, { from: req.query.from, since: req.query.since, env });
      res.set('Cache-Control', 'no-store');
      res.json({ generatedAt: new Date().toISOString(), ...out });
    } catch (e) {
      console.error('[OPENSTUDIO-EXPORT]', e.message);
      res.status(500).json({ error: 'Erreur interne' });
    }
  });
}

module.exports = { registerOpenstudioExport, listDiffusions, videoFormats, keyMatches, buildQuery };
