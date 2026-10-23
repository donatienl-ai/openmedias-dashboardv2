// ==========================================
//  API COACH — KPI par commercial pour le bot Examinateur (n8n)
// ==========================================
// Lecture seule, version LÉGÈRE (après l'incident OOM du 23/10/2026) :
//  - n'utilise PAS dashboardCache/computeDashboard (pas de snapshot complet
//    gardé en mémoire, pas de scan SalesForge invitee par invitee, pas de
//    période de comparaison calculée en plus) ;
//  - interroge les sources UNE PAR UNE (jamais en parallèle) pour limiter le
//    pic mémoire, en s'appuyant sur les caches bruts déjà chauds du dashboard ;
//  - refuse de calculer (503) si la mémoire du serveur est déjà haute, ou si
//    un calcul coach est déjà en cours : le dashboard passe toujours avant.
//
// Accès : en-tête  x-coach-key: <COACH_API_KEY>  (variable d'environnement Render).
// Sans COACH_API_KEY définie, la route est désactivée (503).
//
// Exemples :  GET /api/coach/kpis?preset=last_week
//             GET /api/coach/kpis?preset=custom&start=2026-10-05&end=2026-10-11
// (la semaine précédente se demande par un 2e appel, en plage custom)
import crypto from 'crypto';

function sameSecret(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireCoachKey(req, res, next) {
  const expected = process.env.COACH_API_KEY;
  if (!expected) return res.status(503).json({ error: 'API coach désactivée (COACH_API_KEY absente)' });
  if (!sameSecret(req.headers['x-coach-key'], expected)) {
    return res.status(401).json({ error: 'Clé invalide' });
  }
  return next();
}

const PRESETS_AUTORISES = new Set(['last_week', 'this_week', 'yesterday', 'today', 'custom']);
const MAX_JOURS = 31;
const rows = (block) => (block && Array.isArray(block.detail) ? block.detail : []);
const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null); // en %, 1 décimale

export function registerCoachApi(app, { resolveRange, getRoster, listSalesTeams, getTeamMembers, resolveDisplayName, planningDb, getReportSettings, sources }) {
  let enCours = false;

  app.get('/api/coach/kpis', requireCoachKey, async (req, res) => {
    const seuilMb = parseInt(process.env.COACH_MAX_RSS_MB || '430', 10);
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    if (rssMb > seuilMb) {
      return res.status(503).json({ error: `Mémoire serveur trop haute (${rssMb} Mo > ${seuilMb} Mo) : réessayer plus tard`, retry: true });
    }
    if (enCours) return res.status(503).json({ error: 'Un calcul coach est déjà en cours : réessayer dans une minute', retry: true });

    const preset = req.query.preset || 'last_week';
    if (!PRESETS_AUTORISES.has(preset)) {
      return res.status(400).json({ error: `Période non autorisée pour l'API coach (${[...PRESETS_AUTORISES].join(', ')})` });
    }
    const range = resolveRange(preset, req.query.start, req.query.end);
    if ((range.end - range.start) / 86400000 > MAX_JOURS) {
      return res.status(400).json({ error: `Période trop longue pour l'API coach (${MAX_JOURS} jours max)` });
    }

    enCours = true;
    try {
      const r = { start: range.start, end: range.end };
      const erreurs = {};
      // Une source à la fois : un échec n'empêche pas les autres.
      const lire = async (label, fn, arg = r) => {
        try { return await fn(arg); } catch (e) { erreurs[label] = String(e?.message || e); return null; }
      };
      const calls = await lire('appels', sources.getCalls);
      const rdvTenus = await lire('rdvTenus', sources.getRdvInRange);
      const rdvPris = await lire('rdvPris', sources.getRdvBookedInRange);
      const propals = await lire('propals', sources.getPropals);
      const propalsComptes = await lire('propalsComptes', sources.getPropalsComptes);
      const signatures = await lire('signatures', sources.getSignatures);
      const bdc = await lire('bdc', sources.getBdc);
      const mois = resolveRange('this_month');
      const signaturesMois = await lire('signaturesMois', sources.getSignatures, { start: mois.start, end: mois.end });

      // Équipe de chaque commercial
      const teamOf = new Map();
      for (const t of listSalesTeams()) {
        for (const m of getTeamMembers(t.id)) {
          const name = resolveDisplayName(m) || m.nom;
          if (name) teamOf.set(name, { equipe: t.label, manager: t.manager_nom || null });
        }
      }

      // Objectif de CA mensuel individuel (même table que /api/objectifs)
      const objectifOf = new Map();
      if (planningDb) {
        const objRows = planningDb.prepare(`
          SELECT cu.nom, co.monthly_amount
          FROM commercial_users cu
          LEFT JOIN commercial_objectives co ON co.commercial_id = cu.id
          WHERE cu.actif = 1
        `).all();
        for (const o of objRows) {
          const name = resolveDisplayName({ nom: o.nom });
          if (name) objectifOf.set(name, Math.max(0, Math.round(o.monthly_amount || 0)));
        }
      }

      const parNom = new Map();
      const fiche = (name) => {
        if (!parNom.has(name)) {
          parNom.set(name, {
            commercial: name,
            equipe: teamOf.get(name)?.equipe || null,
            manager: teamOf.get(name)?.manager || null,
            appels: 0,
            r1Tenus: 0, r2Tenus: 0,
            r1Pris: 0, r2Pris: 0,
            propals: 0, propalsMontant: 0,
            propalsComptes: 0, propalsComptesMontant: 0,
            bdcEnvoyes: 0, bdcSignes: 0, bdcEnAttente: 0,
            signatures: 0, caSigne: 0,
            caMoisEnCours: 0, signaturesMoisEnCours: 0,
            objectifMensuel: objectifOf.get(name) ?? null,
          });
        }
        return parNom.get(name);
      };
      getRoster().filter((s) => s.actif && ['commercial', 'manager'].includes(s.role)).forEach((s) => fiche(s.display));

      const add = (block, champ, champMontant) => {
        for (const x of rows(block)) {
          if (!x.name || x.name === 'Inconnu') continue;
          const f = fiche(x.name);
          f[champ] += x.count || 0;
          if (champMontant) f[champMontant] += x.amount || 0;
        }
      };
      add(calls, 'appels');
      add(rdvTenus?.r1, 'r1Tenus');
      add(rdvTenus?.r2, 'r2Tenus');
      add(rdvPris?.r1, 'r1Pris');
      add(rdvPris?.r2, 'r2Pris');
      add(propals, 'propals', 'propalsMontant');
      add(propalsComptes, 'propalsComptes', 'propalsComptesMontant');
      add(bdc?.sent, 'bdcEnvoyes');
      add(bdc?.signed, 'bdcSignes');
      add(bdc?.pending, 'bdcEnAttente');
      add(signatures, 'signatures', 'caSigne');
      add(signaturesMois, 'signaturesMoisEnCours', 'caMoisEnCours');

      const commerciaux = [...parNom.values()].map((f) => ({
        ...f,
        // Ratios sur la période (indicatifs : une signature de la semaine peut
        // venir d'un R1 de la semaine précédente).
        ratios: {
          signaturesParR1TenuPct: ratio(f.signatures, f.r1Tenus),
          r2ParR1TenuPct: ratio(f.r2Tenus, f.r1Tenus),
          bdcSignesParEnvoyesPct: ratio(f.bdcSignes, f.bdcEnvoyes),
          panierMoyen: f.signatures > 0 ? Math.round(f.caSigne / f.signatures) : null,
          atteinteObjectifMoisPct: f.objectifMensuel ? ratio(f.caMoisEnCours, f.objectifMensuel) : null,
        },
      }));

      res.json({
        periode: { preset, label: range.label, start: range.start.toISOString(), end: range.end.toISOString() },
        genereLe: new Date().toISOString(),
        sourcesEnErreur: Object.keys(erreurs).length ? erreurs : null,
        objectifCaMensuelEquipe: getReportSettings ? (getReportSettings().monthlyRevenueObjective ?? null) : null,
        commerciaux,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    } finally {
      enCours = false;
    }
  });
}
