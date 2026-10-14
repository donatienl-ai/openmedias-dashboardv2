// ── TRELLO × RECOUVREMENT (14/10/2026) — LECTURE SEULE ───────────────────────
// Lit le tableau Trello « Clients OpenMedias » (TRELLO_BOARD_ID) et le croise avec
// les factures Pennylane déjà en base. AUCUNE écriture : ni dans Trello (requêtes
// GET uniquement), ni dans Pennylane, ni dans les statuts du dashboard.
// Étape 1 : rapport d'incohérences (simulation) pour Lina, avant tout classement.
// Décisions : claude/decisions-trello-recouvrement-14-10.md (projet).

const TRELLO_API = 'https://api.trello.com/1';
const DEPUIS = '2025-01-01T00:00:00.000Z';
const LECTEURS = ['arianesmirnoff', 'comptaopenmedias']; // Ariane + compte Comptabilité
const LISTES_RECOUVREMENT = ['RECOUVREMENT', 'STAND BY TRESORERIE / PROBLEMATIQUES', 'ANNULATIONS', 'Projets Groupe SCP', 'Projets SCP', 'Clients Forbes - Stand By'];
const FILTRE_ACTIONS = 'commentCard,updateComment,deleteComment,updateCard,addAttachmentToCard,createCard,addLabelToCard,removeLabelFromCard';

function config() {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const board = process.env.TRELLO_BOARD_ID;
  return key && token && board ? { key, token, board } : null;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// GET uniquement. La clé et le jeton ne sont jamais journalisés.
async function trelloGet(path, params = {}) {
  const c = config();
  if (!c) throw new Error('Trello non configuré (TRELLO_API_KEY / TRELLO_TOKEN / TRELLO_BOARD_ID)');
  const u = new URL(TRELLO_API + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  u.searchParams.set('key', c.key);
  u.searchParams.set('token', c.token);
  for (let essai = 0; essai < 5; essai++) {
    const r = await fetch(u, { method: 'GET', headers: { Accept: 'application/json' } });
    if (r.status === 429) { await pause(1500 * (essai + 1)); continue; }
    if (!r.ok) throw new Error(`Trello ${path} : HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`Trello ${path} : trop de requêtes`);
}

// ── Cache mémoire du tableau ─────────────────────────────────────────────────
const etat = { board: null, cartes: [], actions: [], chargeLe: null, derniereAction: null, erreur: null, enCours: null };

async function chargerActions(boardId, since, before) {
  const out = [];
  let avant = before || null;
  for (let page = 0; page < 200; page++) {
    const lot = await trelloGet(`/boards/${boardId}/actions`, {
      limit: 1000, since, before: avant, filter: FILTRE_ACTIONS,
      fields: 'type,date,data,idMemberCreator', memberCreator: 'false', member: 'false',
    });
    out.push(...lot);
    if (lot.length < 1000) break;
    avant = lot[lot.length - 1].id;
  }
  return out;
}

async function chargerTout() {
  const c = config();
  const board = await trelloGet(`/boards/${c.board}`, {
    fields: 'name', lists: 'all', list_fields: 'name,closed', labels: 'all', label_fields: 'name,color', members: 'all', member_fields: 'username,fullName',
  });
  const cartes = await trelloGet(`/boards/${c.board}/cards/all`, { fields: 'name,desc,idList,idLabels,closed,dateLastActivity,shortUrl' });
  const actions = await chargerActions(c.board, DEPUIS);
  etat.board = board; etat.cartes = cartes; etat.actions = actions;
  etat.derniereAction = actions.length ? actions[0].date : DEPUIS;
  etat.chargeLe = new Date().toISOString(); etat.erreur = null;
}

// Nouveautés seulement (mise à jour toutes les 20 s, étape suivante).
async function rafraichir() {
  const c = config();
  if (!etat.board) return chargerTout();
  const nouvelles = await chargerActions(c.board, etat.derniereAction);
  const vues = new Set(etat.actions.map((a) => a.id));
  const ajout = nouvelles.filter((a) => !vues.has(a.id));
  if (ajout.length) {
    etat.actions = ajout.concat(etat.actions);
    etat.derniereAction = etat.actions[0].date;
    etat.cartes = await trelloGet(`/boards/${c.board}/cards/all`, { fields: 'name,desc,idList,idLabels,closed,dateLastActivity,shortUrl' });
  }
  etat.chargeLe = new Date().toISOString();
  return ajout.length;
}

function assurerCharge() {
  if (etat.board) return Promise.resolve();
  if (!etat.enCours) {
    etat.enCours = chargerTout().catch((e) => { etat.erreur = e.message; throw e; }).finally(() => { etat.enCours = null; });
  }
  return etat.enCours;
}

// ── Outils ────────────────────────────────────────────────────────────────────
function normNom(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(sarl|sas|sasu|eurl|sa|sci|selarl|selas|ets|etablissements|societe|ste|groupe|group|holding|cabinet|et cie|cie)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function numerosDans(txt) {
  const out = new Set();
  const re = /\bF\s?-?(\d{4,5})\b/gi;
  let m;
  while ((m = re.exec(String(txt || '')))) out.add('F' + m[1]);
  return out;
}
const extrait = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 160);
const dateFR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

// ── Croisement Trello × Pennylane (simulation, ne change rien) ───────────────
function construireRapport(db) {
  const b = etat.board;
  const listes = new Map(b.lists.map((l) => [l.id, l.name]));
  const etiquettes = new Map(b.labels.map((l) => [l.id, l.name || '']));
  const lecteurs = new Set(b.members.filter((m) => LECTEURS.includes(m.username)).map((m) => m.id));

  // Factures en base (toutes, pour savoir si un numéro existe ; périmètre ≥ 2025 pour les contrôles)
  const factures = db.prepare(`
    SELECT i.id, i.invoice_number, i.customer_id, i.date_emission, i.amount, i.remaining_amount, i.status, i.internal_status,
           c.name AS client
    FROM pennylane_invoices i LEFT JOIN pennylane_customers c ON c.id = i.customer_id
  `).all();
  const parNumero = new Map();
  for (const f of factures) {
    const n = String(f.invoice_number || '').toUpperCase().replace(/\s|-/g, '');
    if (!n) continue;
    if (!parNumero.has(n)) parNumero.set(n, []);
    parNumero.get(n).push(f);
  }
  const dansPerimetre = (f) => String(f.date_emission || '') >= '2025-01-01';
  const restant = (f) => (f.status === 'paid' ? 0 : Number(f.remaining_amount) || 0);
  const avoirsClient = new Map();
  for (const f of factures) if (Number(f.amount) < 0 && dansPerimetre(f)) avoirsClient.set(f.customer_id, (avoirsClient.get(f.customer_id) || 0) + Math.abs(Number(f.amount)));
  const parClient = new Map();
  for (const f of factures) if (Number(f.amount) > 0 && dansPerimetre(f)) {
    const k = normNom(f.client);
    if (!k) continue;
    if (!parClient.has(k)) parClient.set(k, []);
    parClient.get(k).push(f);
  }

  // Commentaires et pièces jointes par carte
  const comms = new Map(); const nums = new Map();
  const ajouterNum = (id, txt) => { if (!id) return; const s = nums.get(id) || new Set(); numerosDans(txt).forEach((x) => s.add(x)); nums.set(id, s); };
  for (const a of etat.actions) {
    const id = a.data && a.data.card && a.data.card.id;
    if (!id) continue;
    if (a.type === 'commentCard') {
      ajouterNum(id, a.data.text);
      if (lecteurs.has(a.idMemberCreator)) { if (!comms.has(id)) comms.set(id, []); comms.get(id).push({ date: a.date, texte: a.data.text || '' }); }
    }
    if (a.type === 'addAttachmentToCard') ajouterNum(id, a.data.attachment && a.data.attachment.name);
  }
  for (const c of etat.cartes) { ajouterNum(c.id, c.name); ajouterNum(c.id, c.desc); }

  const rapport = {
    genereLe: new Date().toISOString(), trelloLuLe: etat.chargeLe, cartes: etat.cartes.length, actions: etat.actions.length,
    liens: { parNumero: 0, parNom: 0, nonRelieesRecouvrement: [] },
    numerosInconnus: [], scp: [], nouveauxDouteux: [],
    incoherences: [], expliquees: {},
  };
  const expliquee = (raison) => { rapport.expliquees[raison] = (rapport.expliquees[raison] || 0) + 1; };

  for (const carte of etat.cartes) {
    const liste = listes.get(carte.idList) || '';
    const labels = carte.idLabels.map((id) => etiquettes.get(id)).filter(Boolean);
    const coms = (comms.get(carte.id) || []).sort((a, b) => (a.date < b.date ? 1 : -1));
    const dernierCom = coms[0];
    const enRecouvrement = LISTES_RECOUVREMENT.includes(liste);

    // Lien carte ↔ factures
    let liees = [];
    const cites = [...(nums.get(carte.id) || [])];
    for (const n of cites) {
      const fs = parNumero.get(n);
      if (fs) liees.push(...fs.filter(dansPerimetre));
      else if (Number(n.slice(1)) >= 5300 && carte.dateLastActivity >= DEPUIS) rapport.numerosInconnus.push({ carte: carte.name, numero: n, lien: carte.shortUrl });
    }
    if (liees.length) rapport.liens.parNumero++;
    else {
      const k = normNom(carte.name);
      const fs = k.length >= 3 ? parClient.get(k) : null;
      if (fs && fs.length) { liees = fs.slice(); rapport.liens.parNom++; }
      else if (enRecouvrement && !carte.closed) rapport.liens.nonRelieesRecouvrement.push({ carte: carte.name, liste, lien: carte.shortUrl });
    }
    liees = [...new Map(liees.filter((f) => Number(f.amount) > 0).map((f) => [f.id, f])).values()];
    if (!liees.length) continue;
    if (carte.closed) { expliquee('carte archivée'); continue; }

    const ouvertes = liees.filter((f) => restant(f) > 1 && !['cancelled'].includes(f.status));
    const ligne = (f, raison, detail) => rapport.incoherences.push({
      facture: f.invoice_number, client: f.client, montant: f.amount, restantPennylane: restant(f), statutPennylane: f.status,
      carte: carte.name, liste, etiquettes: labels, raison, detail,
      dernierCommentaire: dernierCom ? `${dateFR(dernierCom.date)} : ${extrait(dernierCom.texte)}` : null, lien: carte.shortUrl,
    });

    // SCP : à retirer du dashboard
    if (/SCP/i.test(liste)) { liees.forEach((f) => rapport.scp.push({ facture: f.invoice_number, client: f.client, montant: f.amount })); continue; }

    // A. « Soldée » dans Trello mais restant dû dans Pennylane
    if (labels.includes('Soldée') && ouvertes.length) {
      for (const f of ouvertes) {
        const citeExplicitement = coms.some((c) => numerosDans(c.texte).has(String(f.invoice_number).toUpperCase()));
        if (ouvertes.length < liees.length && !citeExplicitement) { expliquee('« Soldée » concerne une autre facture de la carte'); continue; }
        if ((avoirsClient.get(f.customer_id) || 0) >= restant(f) - 1) { expliquee('restant couvert par un avoir'); continue; }
        const solde = coms.find((c) => /sold[ée]e?\s+le\s+\d{1,2}\/\d{1,2}/i.test(c.texte));
        ligne(f, 'Soldée dans Trello, restant dû dans Pennylane', solde ? `Trello : « ${extrait(solde.texte)} » (${dateFR(solde.date)})` : 'Aucune date de paiement dans les commentaires');
      }
    }

    // B. Payée dans Pennylane mais carte en RECOUVREMENT / « client douteux »
    if ((liste === 'RECOUVREMENT' || labels.includes('client douteux')) && liees.length && !ouvertes.length) {
      ligne(liees[0], 'Payée dans Pennylane, carte encore en recouvrement dans Trello', `${liees.length} facture(s) liée(s), toutes soldées ou annulées`);
    }

    // C. ANNULATIONS sans avoir
    if (liste === 'ANNULATIONS') {
      for (const f of ouvertes) {
        if (['partially_cancelled'].includes(f.status) || (avoirsClient.get(f.customer_id) || 0) > 0) { expliquee('annulation avec avoir dans Pennylane'); continue; }
        ligne(f, 'Annulée dans Trello, aucun avoir dans Pennylane', null);
      }
    }

    // D. « client douteux » dans Trello, pas douteux dans le dashboard → à ajouter (2026)
    if (labels.includes('client douteux')) {
      for (const f of ouvertes) if (f.internal_status !== 'douteux') rapport.nouveauxDouteux.push({ facture: f.invoice_number, client: f.client, restant: restant(f), emise: f.date_emission, lien: carte.shortUrl });
    }
  }
  rapport.resume = {
    incoherences: rapport.incoherences.length, numerosInconnus: rapport.numerosInconnus.length,
    nonRelieesRecouvrement: rapport.liens.nonRelieesRecouvrement.length, scp: rapport.scp.length, nouveauxDouteux: rapport.nouveauxDouteux.length,
  };
  return rapport;
}

module.exports = function registerTrelloRecouvrement(app, { db, requireFinance }) {
  if (config()) assurerCharge().catch((e) => console.warn('[trello] chargement initial :', e.message));

  // État de la connexion (pour le bouton de synchro et l'alerte)
  app.get('/api/finance/trello/etat', requireFinance, (req, res) => {
    res.json({ configure: !!config(), charge: !!etat.board, enCours: !!etat.enCours, chargeLe: etat.chargeLe, cartes: etat.cartes.length, actions: etat.actions.length, erreur: etat.erreur });
  });

  // Rapport d'incohérences (simulation, lecture seule)
  app.get('/api/finance/trello/rapport', requireFinance, async (req, res) => {
    try {
      if (!config()) return res.status(503).json({ error: 'Trello non configuré' });
      if (!etat.board) {
        const fini = await Promise.race([assurerCharge().then(() => true), pause(25000).then(() => false)]);
        if (!fini) return res.status(202).json({ enCours: true, message: 'Chargement Trello en cours (environ 1 minute), réessayer.' });
      } else if (req.query.rafraichir === '1') await rafraichir();
      res.json(construireRapport(db));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};

module.exports.normNom = normNom;
module.exports.numerosDans = numerosDans;
module.exports._etat = etat;
module.exports._construireRapport = construireRapport;
