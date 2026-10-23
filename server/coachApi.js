// ==========================================
//  API COACH — KPI par commercial pour le bot Examinateur (n8n)
// ==========================================
// Lecture seule. Réutilise exactement les mêmes calculs que le dashboard
// (dashboardCache → computeDashboard) : les chiffres envoyés au coach sont
// donc identiques à ceux que voient les Team Leaders.
//
// Accès : en-tête  x-coach-key: <COACH_API_KEY>  (variable d'environnement Render).
// Sans COACH_API_KEY définie, la route est désactivée (503).
//
// Exemple :  GET /api/coach/kpis?preset=last_week
//            GET /api/coach/kpis?preset=custom&start=2026-10-13&end=2026-10-19
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

const rows = (block) => (block && Array.isArray(block.detail) ? block.detail : []);
const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null); // en %, 1 décimale

export function registerCoachApi(app, { dashboardCache, resolveRange, getRoster, listSalesTeams, getTeamMembers, resolveDisplayName, planningDb }) {
  app.get('/api/coach/kpis', requireCoachKey, async (req, res) => {
    try {
      const preset = req.query.preset || 'last_week';
      const range = resolveRange(preset, req.query.start, req.query.end);
      const d = await dashboardCache.get(preset, range);

      // Équipe de chaque commercial (nom d'affichage du roster → libellé d'équipe)
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
        for (const r of objRows) {
          const name = resolveDisplayName({ nom: r.nom });
          if (name) objectifOf.set(name, Math.max(0, Math.round(r.monthly_amount || 0)));
        }
      }

      const actifs = getRoster().filter((s) => s.actif && ['commercial', 'manager'].includes(s.role));
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
            rdvSalesforge: 0,
            caMoisEnCours: 0, signaturesMoisEnCours: 0,
            objectifMensuel: objectifOf.get(name) ?? null,
            periodePrecedente: {
              appels: 0, r1Tenus: 0, r2Tenus: 0, r1Pris: 0, r2Pris: 0,
              propals: 0, propalsMontant: 0, propalsComptes: 0, propalsComptesMontant: 0,
              signatures: 0, caSigne: 0,
            },
          });
        }
        return parNom.get(name);
      };
      actifs.forEach((s) => fiche(s.display));

      const add = (block, champ, champMontant, cible = (f) => f) => {
        for (const r of rows(block)) {
          if (!r.name || r.name === 'Inconnu') continue;
          const f = cible(fiche(r.name));
          f[champ] += r.count || 0;
          if (champMontant) f[champMontant] += r.amount || 0;
        }
      };
      add(d.calls, 'appels');
      add(d.rdvToday?.r1, 'r1Tenus');
      add(d.rdvToday?.r2, 'r2Tenus');
      add(d.rdvBooked?.r1, 'r1Pris');
      add(d.rdvBooked?.r2, 'r2Pris');
      add(d.propals, 'propals', 'propalsMontant');
      add(d.propalsComptes, 'propalsComptes', 'propalsComptesMontant');
      add(d.bdc?.sent, 'bdcEnvoyes');
      add(d.bdc?.signed, 'bdcSignes');
      add(d.bdc?.pending, 'bdcEnAttente');
      add(d.signatures, 'signatures', 'caSigne');
      add(d.salesforge, 'rdvSalesforge');
      add(d.monthSignatures, 'signaturesMoisEnCours', 'caMoisEnCours');

      // Même période juste avant (fournie par le dashboard pour les périodes ≤ 70 jours)
      const c = d.compare;
      const prev = (f) => f.periodePrecedente;
      if (c) {
        add(c.calls, 'appels', null, prev);
        add(c.rdvToday?.r1, 'r1Tenus', null, prev);
        add(c.rdvToday?.r2, 'r2Tenus', null, prev);
        add(c.rdvBooked?.r1, 'r1Pris', null, prev);
        add(c.rdvBooked?.r2, 'r2Pris', null, prev);
        add(c.propals, 'propals', 'propalsMontant', prev);
        add(c.propalsComptes, 'propalsComptes', 'propalsComptesMontant', prev);
        add(c.signatures, 'signatures', 'caSigne', prev);
      }

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
        ...(c ? {} : { periodePrecedente: null }),
      }));

      res.json({
        periode: d.range,
        genereLe: d.generatedAt,
        sourcesEnErreur: d.errors || null,
        objectifCaMensuelEquipe: d.settings?.monthlyRevenueObjective ?? null,
        periodePrecedenteDisponible: !!c,
        commerciaux,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
}
