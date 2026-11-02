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

// ── Pièces jointes Trello (15/10/2026, demande Lina) ─────────────────────────
// Les PDF joints aux cartes depuis 2025 sont téléchargés en lecture seule (jeton
// Trello, jamais journalisé), leur texte est extrait (pdf-parse) et gardé en base,
// puis lu comme un commentaire (numéros de facture, avis de virement, montants).
// 15 fichiers par cycle de 20 s ; les images (captures) ne sont pas encore lues.
let pdfParse = null;
try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); } catch (e) { console.warn('[trello-pj] pdf-parse absent : pièces jointes non lues'); }
const pj = { db: null, enCours: false, lus: 0, erreurs: 0 };
function pjInit(db) {
  if (pj.db) return;
  pj.db = db;
  db.exec(`CREATE TABLE IF NOT EXISTS trello_pieces_jointes (
    attachment_id TEXT PRIMARY KEY, card_id TEXT, nom TEXT, date TEXT, texte TEXT, erreur TEXT,
    lu_le TEXT DEFAULT (datetime('now'))
  )`);
}

// Avoirs ↔ factures d'après Pennylane (credited_invoice), relu au démarrage puis toutes
// les 30 min (lecture seule). Complété par le contexte dans construireRapport (section H).
const avoirsPl = { liens: new Map(), chargeLe: null };
async function chargerLiensAvoirsPennylane() {
  try {
    const { getAllPaginated } = require('./pennylane');
    const toutes = await getAllPaginated('customer_invoices');
    const m = new Map();
    for (const inv of toutes || []) {
      const c = inv && (inv.credited_invoice || inv.credited_invoice_id);
      const id = c && typeof c === 'object' ? c.id : c;
      if (id) m.set(String(inv.id), String(id));
    }
    avoirsPl.liens = m; avoirsPl.chargeLe = new Date().toISOString();
    console.log(`[avoirs] ${m.size} avoir(s) relié(s) à leur facture par Pennylane`);
  } catch (e) { console.warn('[avoirs] lecture Pennylane :', e.message); }
}
function pjTextes() {
  const m = new Map();
  if (!pj.db) return m;
  for (const r of pj.db.prepare("SELECT card_id, nom, date, texte FROM trello_pieces_jointes WHERE texte IS NOT NULL AND texte != ''").all()) {
    if (!m.has(r.card_id)) m.set(r.card_id, []);
    m.get(r.card_id).push({ date: r.date, texte: `[Pièce jointe « ${r.nom} »] ${r.texte}`, auteur: 'Pièce jointe', pj: true });
  }
  return m;
}
async function lirePiecesJointes() {
  if (!pdfParse || !pj.db || pj.enCours || !etat.actions.length) return;
  pj.enCours = true;
  try {
    const c = config();
    const deja = new Set(pj.db.prepare('SELECT attachment_id FROM trello_pieces_jointes').all().map((r) => r.attachment_id));
    const aLire = [];
    for (const a of etat.actions) {
      if (a.type !== 'addAttachmentToCard' || !a.data || !a.data.attachment || !a.data.card) continue;
      const at = a.data.attachment;
      if (!at.id || deja.has(at.id) || !/\.pdf$/i.test(at.name || '')) continue;
      deja.add(at.id);
      aLire.push({ id: at.id, nom: at.name, card: a.data.card.id, date: a.date });
    }
    aLire.sort((x, y) => (x.date < y.date ? 1 : -1));
    // Seules les pièces jointes JAMAIS lues sont téléchargées (table trello_pieces_jointes) :
    // une fois le stock historique traité, chaque passage ne lit que les nouveaux PDF.
    // 3 au maximum par passage (au lieu de 15) pour ne pas saturer la mémoire (512 Mo).
    for (const x of aLire.slice(0, 1)) {
      let texte = null, erreur = null;
      // Noté AVANT la lecture : si ce PDF fait tomber le serveur (mémoire), il n'est jamais relu.
      pj.db.prepare('INSERT OR REPLACE INTO trello_pieces_jointes (attachment_id, card_id, nom, date, texte, erreur) VALUES (?,?,?,?,?,?)')
        .run(x.id, x.card, x.nom, x.date, null, 'lecture interrompue (PDF trop lourd)');
      try {
        const u = `${TRELLO_API}/cards/${x.card}/attachments/${x.id}/download/${encodeURIComponent(x.nom)}`;
        const r = await fetch(u, { headers: { Authorization: `OAuth oauth_consumer_key="${c.key}", oauth_token="${c.token}"` } });
        if (r.status === 429) break;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // Taille vérifiée AVANT de charger le fichier en mémoire (5 Mo max).
        const taille = Number(r.headers.get('content-length') || 0);
        if (taille > 5 * 1024 * 1024) { try { r.body && r.body.destroy && r.body.destroy(); } catch (_) { /* rien */ } throw new Error('fichier trop gros'); }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) throw new Error('fichier trop gros');
        const res = await pdfParse(buf, { max: 5 }); // 5 premières pages : n° et montants y sont
        texte = String(res.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
        pj.lus++;
      } catch (e) { erreur = String(e.message || e).slice(0, 200); pj.erreurs++; }
      pj.db.prepare('INSERT OR REPLACE INTO trello_pieces_jointes (attachment_id, card_id, nom, date, texte, erreur) VALUES (?,?,?,?,?,?)')
        .run(x.id, x.card, x.nom, x.date, texte, erreur);
    }
  } finally { pj.enCours = false; }
}


// Seuls les champs réellement utilisés sont gardés en mémoire (≈ 66 000 actions).
function allegerAction(a) {
  const d = a.data || {}, o = {};
  if (d.card) o.card = d.card.idLabels ? { id: d.card.id, idLabels: d.card.idLabels } : { id: d.card.id };
  if (d.text != null) o.text = d.text;
  if (d.label) o.label = { id: d.label.id, name: d.label.name };
  if (d.old && 'idLabels' in d.old) o.old = { idLabels: d.old.idLabels };
  if (d.attachment) o.attachment = { id: d.attachment.id, name: d.attachment.name };
  return { id: a.id, type: a.type, date: a.date, idMemberCreator: a.idMemberCreator, data: o };
}

async function chargerActions(boardId, since, before) {
  const out = [];
  let avant = before || null;
  for (let page = 0; page < 200; page++) {
    const lot = await trelloGet(`/boards/${boardId}/actions`, {
      limit: 1000, since, before: avant, filter: FILTRE_ACTIONS,
      fields: 'type,date,data,idMemberCreator', memberCreator: 'false', member: 'false',
    });
    for (const a of lot) out.push(allegerAction(a));
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
  const cartes = await trelloGet(`/boards/${c.board}/cards/all`, { fields: 'name,desc,idList,idLabels,closed,dateLastActivity,shortUrl,idMembers' });
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
    etat.cartes = await trelloGet(`/boards/${c.board}/cards/all`, { fields: 'name,desc,idList,idLabels,closed,dateLastActivity,shortUrl,idMembers' });
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

// ── Outils ───────────────────────────────────────────────────────────────────
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
// Nom de carte → nom de client : on retire ce qui suit « - » (média, SCP, Article…)
function nomCarte(s) { return normNom(String(s || '').split(/\s[-–|]\s/)[0]); }
function memeClient(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  const ta = a.split(' ').filter((x) => x.length >= 3), tb = new Set(b.split(' ').filter((x) => x.length >= 3));
  if (!ta.length || !tb.size) return false;
  const communs = ta.filter((x) => tb.has(x)).length;
  return communs / Math.max(ta.length, tb.size) >= 0.6;
}
const extrait = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 160);
const dateFR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

// ── Croisement Trello × Pennylane (simulation, ne change rien) ───────────────
// Rapport gardé en cache : recalculé seulement si Trello a bougé (ou toutes les 10 min pour Pennylane).
const cacheRapport = { cle: null, le: 0, r: null };
function construireRapport(db) {
  const cle = `${etat.actions.length}|${etat.derniereAction}|${etat.cartes.length}|${pj.lus}`;
  if (cacheRapport.r && cacheRapport.cle === cle && Date.now() - cacheRapport.le < 10 * 60 * 1000) return cacheRapport.r;
  const r = construireRapportComplet(db);
  cacheRapport.cle = cle; cacheRapport.le = Date.now(); cacheRapport.r = r;
  return r;
}
function construireRapportComplet(db) {
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
  // Pièces jointes lues (PDF) : leurs numéros de facture relient aussi la carte.
  const textesPj = pjTextes();
  for (const [id, l] of textesPj) for (const t of l) ajouterNum(id, t.texte);
  // Date à laquelle « Soldée » a été posée sur chaque carte (la plus récente)
  const idSoldee = new Set(b.labels.filter((l) => l.name === 'Soldée').map((l) => l.id));
  const soldeeLe = new Map();
  for (const a of etat.actions) {
    const id = a.data && a.data.card && a.data.card.id;
    if (!id) continue;
    let pose = false;
    if (a.type === 'addLabelToCard' && a.data.label && idSoldee.has(a.data.label.id)) pose = true;
    if (a.type === 'updateCard' && a.data.old && 'idLabels' in a.data.old && a.data.card.idLabels) {
      const avant = new Set(a.data.old.idLabels || []);
      pose = a.data.card.idLabels.some((x) => idSoldee.has(x) && !avant.has(x));
    }
    if (a.type === 'commentCard' && /\bsold[ée]es?\s+(le|au|ce\s+jour)\b/i.test(a.data.text || '')) pose = true;
    if (pose && (!soldeeLe.has(id) || a.date > soldeeLe.get(id))) soldeeLe.set(id, a.date);
  }

  const rapport = {
    genereLe: new Date().toISOString(), trelloLuLe: etat.chargeLe, cartes: etat.cartes.length, actions: etat.actions.length,
    liens: { parNumero: 0, parNom: 0, nonRelieesRecouvrement: [] },
    numerosInconnus: [], scp: [], nouveauxDouteux: [],
    incoherences: [], classementsPrevus: [], expliquees: {},
  };
  const carteDeFacture = new Map();
  const cartesDeFacture = new Map(); // toutes les cartes liées à une facture (pas seulement la dernière)
  const tousNumerosCites = new Set(); for (const s of nums.values()) for (const n of s) tousNumerosCites.add(n);
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
      // (02/11/2026) Une facture dont le n° est cité sur une AUTRE carte (commentaire, PDF
      // joint…) appartient à cette carte-là : on ne la rattache plus ici par le seul nom
      // (cas F7515 : carte « ICARE » ≠ carte « ICARE SERVICES » qui porte le PDF F7515).
      const citeeAilleurs = (f) => tousNumerosCites.has(String(f.invoice_number || '').toUpperCase().replace(/\s|-/g, ''));
      const k = nomCarte(carte.name);
      let fs = k.length >= 3 ? parClient.get(k) : null;
      if (!fs && k.length >= 3) {
        const cands = [...parClient.keys()].filter((c) => memeClient(k, c));
        if (cands.length === 1) fs = parClient.get(cands[0]);
      }
      if (fs && fs.length) fs = fs.filter((f) => !citeeAilleurs(f));
      if (fs && fs.length) { liees = fs.slice(); rapport.liens.parNom++; }
      else if (enRecouvrement && !carte.closed) {
        if (liste === 'ANNULATIONS' && !cites.length) expliquee('projet annulé sans facture (ANNULATIONS)');
        else rapport.liens.nonRelieesRecouvrement.push({ carte: carte.name, liste, lien: carte.shortUrl, numerosCites: cites });
      }
    }
    liees = [...new Map(liees.filter((f) => Number(f.amount) > 0).map((f) => [f.id, f])).values()];
    if (!liees.length) continue;
    for (const f of liees) carteDeFacture.set(String(f.id), { carte, coms, labels, liste });
    for (const f of liees) { const k = String(f.id); if (!cartesDeFacture.has(k)) cartesDeFacture.set(k, []); cartesDeFacture.get(k).push({ carte, liste }); }
    if (carte.closed) { expliquee('carte archivée'); continue; }

    const ouvertes = liees.filter((f) => restant(f) > 1 && !['cancelled'].includes(f.status));
    const ligne = (f, raison, detail) => rapport.incoherences.push({
      id: f.id, facture: f.invoice_number, client: f.client, montant: f.amount, restantPennylane: restant(f), statutPennylane: f.status,
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
        const poseLe = soldeeLe.get(carte.id) || '2024-12-31';
        if (!citeExplicitement && String(f.date_emission) > poseLe.slice(0, 10)) { expliquee('« Soldée » posée avant l\'émission de cette facture'); continue; }
        const comFacture = coms.find((c) => numerosDans(c.texte).has(String(f.invoice_number).toUpperCase()) && /sold|trop[- ]?pay|trop[- ]?per[çc]u|r[ée]gl[ée]/i.test(c.texte));
        if (comFacture) {
          rapport.classementsPrevus.push({ id: f.id, facture: f.invoice_number, client: f.client, restantPennylane: restant(f), nouveauClassement: 'Soldée', raison: `Trello plus récent : « ${extrait(comFacture.texte)} » (${dateFR(comFacture.date)})`, lien: carte.shortUrl });
          continue;
        }
        const solde = coms.find((c) => /sold[ée]e?\s+le\s+\d{1,2}\/\d{1,2}/i.test(c.texte));
        ligne(f, 'Soldée dans Trello, restant dû dans Pennylane', solde ? `Trello : « ${extrait(solde.texte)} » (${dateFR(solde.date)})` : 'Aucune date de paiement dans les commentaires');
      }
    }

    // B. Payée dans Pennylane mais carte en RECOUVREMENT / « client douteux »
    const dossierClos = labels.includes('clôture dossier') || labels.includes('Soldée') || coms.some((c) => /cl[ôo]ture|sold[ée]e|liquidation|avoir (fait|établi|etabli)/i.test(c.texte));
    if ((liste === 'RECOUVREMENT' || labels.includes('client douteux')) && liees.length && !ouvertes.length && dossierClos) expliquee('dossier clos dans Trello (clôture, soldée, liquidation, avoir)');
    else if ((liste === 'RECOUVREMENT' || labels.includes('client douteux')) && liees.length && !ouvertes.length) {
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
      for (const f of ouvertes) if (!['douteux', 'solde'].includes(f.internal_status)) rapport.nouveauxDouteux.push({ id: f.id, facture: f.invoice_number, client: f.client, restant: restant(f), emise: f.date_emission, lien: carte.shortUrl });
    }
  }
  // E. « Soldée » dans le dashboard alors que Pennylane affiche encore un reste : on lit
  // les commentaires Trello pour comprendre (paiement via Rubypayeur, avoir, virement…).
  rapport.soldeesAvecReste = [];
  for (const f of factures) {
    if (!dansPerimetre(f) || Number(f.amount) <= 0) continue;
    if (f.internal_status !== 'solde' || restant(f) <= 1 || ['cancelled', 'partially_cancelled'].includes(f.status)) continue;
    const c = carteDeFacture.get(String(f.id));
    const preuve = c && c.coms.find((x) => /sold[ée]e|virement|r[ée]gl|avoir|cl[ôo]ture|rubypayeur|pay[ée]/i.test(x.texte));
    rapport.soldeesAvecReste.push({
      id: f.id, facture: f.invoice_number, client: f.client, restant: restant(f), statutPennylane: f.status, lien: c ? c.carte.shortUrl : null,
      raison: preuve
        ? `Soldée selon Trello (${dateFR(preuve.date)} : « ${extrait(preuve.texte)} »), mais il reste ${restant(f).toFixed(2)} € dans Pennylane : paiement ou avoir à rapprocher dans Pennylane.`
        : `Marquée Soldée dans le dashboard, mais il reste ${restant(f).toFixed(2)} € dans Pennylane et rien dans Trello ne l'explique.`,
    });
  }
  // F. Vieilles factures (émises il y a plus de 90 jours) encore impayées → « À vérifier »
  // (15/10/2026, demande Lina). On lit TOUS les commentaires des cartes du client (pas
  // seulement Ariane/Compta). Un commentaire de paiement sans numéro est attribué d'après le
  // contexte : daté après l'émission, quand c'est la seule facture du client encore ouverte
  // à cette date. Sinon on le signale comme « à attribuer ». « Suivi par » = membres de la carte.
  rapport.vieillesFactures = [];
  const limite90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const nomMembre = new Map(b.members.map((m) => [m.id, m.fullName || m.username]));
  const tousComms = new Map();
  for (const a of etat.actions) {
    if (a.type !== 'commentCard' || !a.data || !a.data.card) continue;
    const id = a.data.card.id;
    if (!tousComms.has(id)) tousComms.set(id, []);
    tousComms.get(id).push({ date: a.date, texte: a.data.text || '', auteur: nomMembre.get(a.idMemberCreator) || '' });
  }
  for (const [id, l] of textesPj) { if (!tousComms.has(id)) tousComms.set(id, []); tousComms.get(id).push(...l); }
  const cartesParNom = new Map();
  for (const c of etat.cartes) {
    const k = nomCarte(c.name);
    if (k.length < 3) continue;
    if (!cartesParNom.has(k)) cartesParNom.set(k, []);
    cartesParNom.get(k).push(c);
  }
  // Paiement annoncé : formulations positives seulement (« Soldée le », « virement reçu »…).
  const estPaiement = (t) => /sold[ée]e?\s+le|virement\b[^\n]{0,40}\b(re[çc]u|fait|effectu)|r[ée]gl[ée]e?\s+le|pay[ée]e?\s+le|encaiss[ée]e?\s+le/i.test(t)
    && !/\bn['’]?\s?(est|a|ont)\s+(toujours\s+)?pas|pas\s+(encore\s+)?(r[ée]gl|pay|re[çc]u)|pourquoi|toujours pas|\b(demand|relanc|attend|en attente|pr[ée]vu|promet|promesse|va\s+(payer|r[ée]gler|faire|envoyer))/i.test(t)
    && !/^\[Pièce jointe « [^»]*(facture|avoir|devis|bdc|bon de commande)/i.test(t);
  const montantDans = (t) => {
    const m = String(t).match(/(\d{1,3}(?:[ .  ]\d{3})*(?:,\d{1,2})?)\s?(?:€|euros?)/i);
    return m ? Number(m[1].replace(/[ .  ]/g, '').replace(',', '.')) : null;
  };
  const eur = (n) => `${Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €`;
  for (const f of factures) {
    if (!dansPerimetre(f) || Number(f.amount) <= 0 || restant(f) <= 1) continue;
    if (['solde', 'douteux'].includes(f.internal_status)) continue;
    if (['draft', 'credit_note', 'cancelled', 'partially_cancelled', 'archived', 'paid'].includes(f.status)) continue;
    if (String(f.date_emission || '') >= limite90) continue;
    if (/groupe\s*scp/i.test(f.client || '')) continue;
    const kc = normNom(f.client);
    let parNomCarte = cartesParNom.get(kc) || [];
    if (!parNomCarte.length && kc.length >= 3) {
      const cands = [...cartesParNom.keys()].filter((k) => memeClient(k, kc));
      if (cands.length === 1) parNomCarte = cartesParNom.get(cands[0]);
    }
    const cs = [...new Map([...(cartesDeFacture.get(String(f.id)) || []).map((x) => x.carte), ...((cartesDeFacture.get(String(f.id)) || []).length ? [] : parNomCarte)].map((c) => [c.id, c])).values()];
    const ouvertesClient = (parClient.get(kc) || []).filter((x) => restant(x) > 1 && !['cancelled', 'partially_cancelled', 'archived'].includes(x.status));
    const coms = cs.flatMap((c) => tousComms.get(c.id) || []).sort((a, b) => (a.date < b.date ? 1 : -1));
    const membres = [...new Set(cs.flatMap((c) => (c.idMembers || []).map((m) => nomMembre.get(m)).filter(Boolean)))];
    const num = String(f.invoice_number).toUpperCase();
    const candidats = coms.filter((c) => estPaiement(c.texte) && c.date.slice(0, 10) >= String(f.date_emission)
      && (!numerosDans(c.texte).size || numerosDans(c.texte).has(num)));
    const ouvertesA = (c) => ouvertesClient.filter((x) => String(x.date_emission) <= c.date.slice(0, 10)).length;
    const paiement = candidats.find((c) => numerosDans(c.texte).has(num) || ouvertesA(c) === 1);
    const ambigu = !paiement && candidats[0];
    // Règle Lina (02/11/2026) : une vieille facture n'est « à vérifier » que s'il s'est
    // passé quelque chose que Pennylane doit refléter — paiement reçu, avoir, nouvelle
    // facture, annulation. Une relance ou un virement simplement attendu / promis ne
    // compte pas : la facture reste en retard, à relancer, sans encombrer « À vérifier ».
    const faitNouveau = coms.find((c) => c.date.slice(0, 10) >= String(f.date_emission)
      && (/\b(un|cet|notre|votre|d['’]un)\s+avoir\b|\bl['’]avoir\s+(n°|F\s?\d|de\s+\d)|\bavoir\s+(partiel|total|n°|F\s?\d|[ée]tabli|fait|[ée]mis|de\s+\d)|refactur|nouvelle facture|\bannul(?:[ée]e?s?|ation|er)(?![a-z])/i.test(c.texte)
        || (/^\[Pièce jointe « [^»]*(avoir|facture)/i.test(c.texte) && !numerosDans(String(c.texte).slice(0, 200)).has(num))));
    if (!paiement && !ambigu && !faitNouveau) continue;

    const listesCartes = [...new Set(cs.map((c) => listes.get(c.idList) || ''))];
    const parties = [`Impayée depuis le ${dateFR(String(f.date_emission))} (plus de 90 jours).`];
    if (!cs.length) parties.push('Aucune carte Trello trouvée : personne ne semble la suivre.');
    else if (!listesCartes.some((l) => l === 'RECOUVREMENT' || l === 'STAND BY TRESORERIE / PROBLEMATIQUES')) parties.push(`Carte Trello dans « ${listesCartes.join(' », « ')} », pas en RECOUVREMENT.`);
    if (paiement) {
      const m = montantDans(paiement.texte);
      const ecart = m && Math.abs(m - restant(f)) > 1 && Math.abs(m - Number(f.amount)) > 1;
      parties.push(`Trello indique un paiement le ${dateFR(paiement.date)} : « ${extrait(paiement.texte)} »`
        + (ecart ? ` (${eur(m)} pour un reste de ${eur(restant(f))} : paiement partiel ou autre facture).` : ' → à rapprocher dans Pennylane.'));
    } else if (ambigu) {
      parties.push(`Trello indique « ${extrait(ambigu.texte)} » le ${dateFR(ambigu.date)}, mais ${ouvertesA(ambigu)} factures de ce client étaient ouvertes : à attribuer.`);
    } else if (faitNouveau) {
      parties.push(`Fait nouveau le ${dateFR(faitNouveau.date)} : « ${extrait(faitNouveau.texte)} » → avoir, facture ou annulation à répercuter dans Pennylane.`);
    } else if (coms[0]) {
      parties.push(`Dernier commentaire le ${dateFR(coms[0].date)}${coms[0].auteur ? ' par ' + coms[0].auteur : ''} : « ${extrait(coms[0].texte)} ».`);
    }
    if (membres.length) parties.push(`Suivi par : ${membres.join(', ')}.`);
    rapport.vieillesFactures.push({
      id: f.id, facture: f.invoice_number, client: f.client, restant: restant(f), raison: parties.join(' '),
      lien: cs[0] ? cs[0].shortUrl : null, suiviPar: membres, paiementTrello: !!paiement,
    });
  }
  // G. Paiements partiels connus de Trello (commentaires + pièces jointes, 15/10/2026) :
  // paiements attribués à la facture (numéro cité, ou contexte) dont le total reste
  // inférieur au reste dû Pennylane → onglet « Part. encaissée ».
  rapport.partielsTrello = [];
  for (const f of factures) {
    if (!dansPerimetre(f) || Number(f.amount) <= 0 || restant(f) <= 1) continue;
    if (['draft', 'credit_note', 'cancelled', 'partially_cancelled', 'archived', 'paid'].includes(f.status)) continue;
    if (/groupe\s*scp/i.test(f.client || '')) continue;
    const kc = normNom(f.client);
    let parNomCarte = cartesParNom.get(kc) || [];
    if (!parNomCarte.length && kc.length >= 3) {
      const cands = [...cartesParNom.keys()].filter((k) => memeClient(k, kc));
      if (cands.length === 1) parNomCarte = cartesParNom.get(cands[0]);
    }
    const cs = [...new Map([...(cartesDeFacture.get(String(f.id)) || []).map((x) => x.carte), ...((cartesDeFacture.get(String(f.id)) || []).length ? [] : parNomCarte)].map((c) => [c.id, c])).values()];
    const ouvertesClient = (parClient.get(kc) || []).filter((x) => restant(x) > 1 && !['cancelled', 'partially_cancelled', 'archived'].includes(x.status));
    const num = String(f.invoice_number).toUpperCase();
    const vus = new Set(); let total = 0; const details = [];
    for (const c of cs.flatMap((x) => tousComms.get(x.id) || [])) {
      if (!estPaiement(c.texte) || c.date.slice(0, 10) < String(f.date_emission)) continue;
      const cite = numerosDans(c.texte);
      if (!(cite.has(num) || (!cite.size && ouvertesClient.filter((x) => String(x.date_emission) <= c.date.slice(0, 10)).length === 1))) continue;
      const m = montantDans(c.texte);
      if (!m || m >= restant(f) - 1) continue;
      const cle = `${m}|${c.date.slice(0, 10)}`;
      if (vus.has(cle)) continue;
      vus.add(cle); total += m; details.push(`${dateFR(c.date)} : ${eur(m)}${c.pj ? ' (pièce jointe)' : ''}`);
    }
    if (total > 1 && total < restant(f) - 1) rapport.partielsTrello.push({ id: f.id, facture: f.invoice_number, montantTrello: total, details });
  }
  // H. Avoirs ↔ factures (15/10/2026, demande Lina : « même raisonnement que F6336 pour
  // tous les avoirs »). 1) lien Pennylane (credited_invoice) ; 2) sinon contexte : même
  // client, avoir émis après la facture, montant égal sur une facture annulée, ou avoir
  // partiel sur la seule facture encore ouverte qu'il peut réduire ; 3) facture émise pour
  // annuler un avoir (cas F6336 qui annule l'avoir F6243) : facture annulée, même client,
  // même montant qu'un avoir antérieur.
  rapport.avoirs = [];
  const parIdFacture = new Map(factures.map((f) => [String(f.id), f]));
  const montantAbs = (f) => Math.abs(Number(f.amount) || 0);
  const avoirsTous = factures.filter((f) => Number(f.amount) < 0 && dansPerimetre(f));
  const avoirLie = new Set();
  const facturesAvecAvoir = new Set();
  const lier = (av, f, source, type) => {
    rapport.avoirs.push({ avoirId: av.id, avoirNumero: av.invoice_number, factureId: f.id, factureNumero: f.invoice_number,
      montant: montantAbs(av), date: type === 'annule_avoir' ? f.date_emission : av.date_emission, source, type: type || 'avoir' });
    avoirLie.add(String(av.id)); facturesAvecAvoir.add(String(f.id));
  };
  for (const av of avoirsTous) {
    const fid = avoirsPl.liens.get(String(av.id));
    if (fid && parIdFacture.has(fid)) lier(av, parIdFacture.get(fid), 'Pennylane');
  }
  // 1 bis) Mentions écrites SUR les PDF joints aux cartes Trello (20/10/2026, demande
  // Lina : « lire tous les PDF »). Les factures et avoirs Pennylane portent une
  // « Mention spéciale » tapée à la main : « Avoir concernant la facture F6336 »,
  // « Facture annule avoir F6243 du 20/10/2025 »… Quand Pennylane n'a pas fait le
  // lien (credited_invoice vide), c'est le document lui-même qui fait foi. Si
  // Pennylane et le PDF se contredisent, on garde Pennylane et on le signale.
  rapport.avoirsConflits = [];
  const facParNum = (n) => { const l = parNumero.get(String(n || '').toUpperCase().replace(/\s|-/g, '')); return l && l.length ? l[0] : null; };
  const mentionsPdf = [];
  for (const [, l] of textesPj) for (const x of l) {
    const nomPj = (String(x.texte).match(/« ([^»]+) »/) || [])[1] || '';
    const propres = [...numerosDans(nomPj)];
    if (propres.length !== 1) continue;
    const txt = String(x.texte).replace(/\s+/g, ' ');
    const mAv = txt.match(/avoir concernant (?:la )?facture\s*(?:n°\s*)?(F\s?-?\d{4,5})/i);
    if (mAv) mentionsPdf.push({ type: 'avoir', avoir: propres[0], facture: mAv[1].replace(/\s|-/g, '').toUpperCase() });
    const mAn = txt.match(/facture annule (?:l')?avoir\s*(?:n°\s*)?(F\s?-?\d{4,5})/i);
    if (mAn) mentionsPdf.push({ type: 'annule_avoir', avoir: mAn[1].replace(/\s|-/g, '').toUpperCase(), facture: propres[0] });
  }
  const dejaPaire = new Set();
  for (const m of mentionsPdf) {
    const av = facParNum(m.avoir), f = facParNum(m.facture);
    if (!av || !f || Number(av.amount) >= 0 || Number(f.amount) <= 0) continue;
    const cle = av.id + '>' + f.id + '>' + m.type;
    if (dejaPaire.has(cle)) continue;
    dejaPaire.add(cle);
    if (m.type === 'annule_avoir') {
      if (!rapport.avoirs.some((x) => x.avoirId === av.id && x.factureId === f.id)) lier(av, f, 'PDF (mention « Facture annule avoir »)', 'annule_avoir');
      continue;
    }
    const dejaLie = rapport.avoirs.find((x) => x.avoirId === av.id && x.type !== 'annule_avoir');
    if (dejaLie) {
      if (dejaLie.factureId !== f.id && dejaLie.factureNumero !== f.invoice_number) rapport.avoirsConflits.push({ avoir: av.invoice_number, avoirId: av.id, selonPennylane: dejaLie.factureNumero, factureIdPl: dejaLie.factureId, selonPdf: f.invoice_number, factureIdPdf: f.id });
      continue;
    }
    lier(av, f, 'PDF (mention « Avoir concernant la facture »)');
  }
  const plusRecente = (l) => l.slice().sort((a, b) => (a.date_emission < b.date_emission ? 1 : -1))[0];
  for (const av of avoirsTous) {
    if (avoirLie.has(String(av.id))) continue;
    const cands = factures.filter((f) => Number(f.amount) > 0 && f.customer_id === av.customer_id
      && String(f.date_emission) <= String(av.date_emission) && montantAbs(f) + 1 >= montantAbs(av) && !facturesAvecAvoir.has(String(f.id)));
    if (!cands.length) continue;
    const exacts = cands.filter((f) => Math.abs(montantAbs(f) - montantAbs(av)) <= 1 && ['cancelled', 'partially_cancelled'].includes(f.status));
    const partiels = cands.filter((f) => f.status === 'partially_cancelled' || (montantAbs(f) - montantAbs(av) > 1 && restant(f) > 1));
    const f = plusRecente(exacts) || (partiels.length === 1 ? partiels[0] : null);
    if (f) lier(av, f, 'contexte (même client, montant, date)');
  }
  for (const f of factures) {
    if (Number(f.amount) <= 0 || f.status !== 'cancelled' || !dansPerimetre(f) || facturesAvecAvoir.has(String(f.id))) continue;
    const av = plusRecente(avoirsTous.filter((a) => a.customer_id === f.customer_id && !avoirLie.has(String(a.id))
      && Math.abs(montantAbs(a) - montantAbs(f)) <= 1 && String(a.date_emission) <= String(f.date_emission)));
    if (av) lier(av, f, 'contexte (facture émise pour annuler l\'avoir)', 'annule_avoir');
  }
  // I. CONTRÔLE DE CALCUL facture par facture (20/10/2026, demande Lina : « si il y a une
  // erreur dans Pennylane ou Trello, mentionne-le sur la facture »). Chaque écart
  // part dans « À vérifier » ET s'affiche sur la fiche de la facture concernée.
  // 1) Conflit Pennylane ↔ PDF sur un avoir : si la facture que Pennylane désigne est
  //    déjà entièrement couverte par d'autres avoirs, Pennylane se trompe → le
  //    dashboard suit le PDF (cas F7435 : Pennylane → F6241, déjà annulée par F6243 ;
  //    PDF → F6336). Sinon on garde Pennylane et on signale.
  rapport.anomaliesCalcul = [];
  const lienCarte = (fid) => { const l = cartesDeFacture.get(String(fid)) || []; return l[0] && l[0].carte ? l[0].carte.shortUrl : null; };
  const anomalie = (f, raison) => { if (f) rapport.anomaliesCalcul.push({ id: f.id, facture: f.invoice_number, client: f.client, raison, lien: lienCarte(f.id) }); };
  const couvertPar = (fid, saufAvoirId) => rapport.avoirs.filter((x) => x.factureId === fid && x.type !== 'annule_avoir' && x.avoirId !== saufAvoirId).reduce((s, x) => s + (x.montant || 0), 0);
  for (const c of rapport.avoirsConflits || []) {
    const fPl = parIdFacture.get(String(c.factureIdPl)), fPdf = parIdFacture.get(String(c.factureIdPdf)), av = parIdFacture.get(String(c.avoirId));
    if (!fPl || !fPdf || !av) continue;
    const plDejaCouverte = couvertPar(fPl.id, av.id) >= montantAbs(fPl) - 1;
    if (plDejaCouverte) {
      const e = rapport.avoirs.find((x) => x.avoirId === av.id && x.type !== 'annule_avoir');
      if (e) { e.factureId = fPdf.id; e.factureNumero = fPdf.invoice_number; e.source = 'PDF (lien Pennylane corrigé par le calcul)'; }
      c.resolu = true;
      const msg = `Pennylane rattache l'avoir ${av.invoice_number} (${montantAbs(av).toFixed(2)} €) à ${fPl.invoice_number}, déjà entièrement couverte par un autre avoir ; le PDF de l'avoir indique ${fPdf.invoice_number}. Le dashboard suit le PDF — rattachement à corriger dans Pennylane.`;
      anomalie(fPl, msg); anomalie(fPdf, msg);
    }
    // Sinon : le lien Pennylane est cohérent avec les montants (ex. SIAL : l'avoir F7268
    // annule la refacture F7281, la mention du PDF cite la facture d'origine F7233) —
    // on garde Pennylane sans alerter : c'est le lettrage comptable qui fait foi.
  }
  // 2) Écarts de calcul : avoirs liés vs montant de la facture vs reste dû Pennylane.
  for (const f of factures) {
    if (Number(f.amount) <= 0 || !dansPerimetre(f)) continue;
    const lies = rapport.avoirs.filter((x) => x.factureId === f.id && x.type !== 'annule_avoir');
    if (!lies.length) continue;
    const totAv = lies.reduce((s, x) => s + (x.montant || 0), 0);
    const ttc = montantAbs(f), reste = restant(f);
    const nums = lies.map((x) => x.avoirNumero).join(', ');
    if (totAv > ttc + 1) {
      anomalie(f, `Avoirs liés (${nums} : ${totAv.toFixed(2)} €) supérieurs au montant de la facture (${ttc.toFixed(2)} €) : un avoir est rattaché à la mauvaise facture.`);
    } else if (totAv >= ttc - 1 && reste > 1) {
      anomalie(f, `Facture entièrement annulée par ${nums} (${totAv.toFixed(2)} €) mais Pennylane affiche encore ${reste.toFixed(2)} € dû : lettrage de l'avoir à corriger dans Pennylane. Reste dû réel : 0 €.`);
    } else if (reste > ttc - totAv + 1) {
      anomalie(f, `Reste dû Pennylane (${reste.toFixed(2)} €) supérieur au maximum possible après avoir (${ttc.toFixed(2)} − ${totAv.toFixed(2)} = ${(ttc - totAv).toFixed(2)} €) : l'avoir ${nums} n'est pas lettré dans Pennylane.`);
    }
  }
  // 3) Avoir rattaché à aucune facture (ni Pennylane, ni PDF, ni contexte).
  for (const av of avoirsTous) {
    if (!rapport.avoirs.some((x) => x.avoirId === av.id)) anomalie(av, `Avoir ${av.invoice_number} (${montantAbs(av).toFixed(2)} €) rattaché à aucune facture : ni Pennylane, ni la mention du PDF, ni le contexte ne permettent de le lier.`);
  }
  // J. ÉTIQUETTES ET MENTIONS TRELLO → STATUT ET RESTE DÛ (02/11/2026, règles Lina)
  // Trello l'emporte sur Pennylane : ce qui est écrit sur la carte met le dashboard à jour.
  //  • « Soldée » (étiquette, ou écrit dans un commentaire), « clôture dossier »,
  //    « ANNULATION DANS LES DELAIS », « annulation projet » → Soldée, reste dû 0 €.
  //  • Facture annulée dans Pennylane → Soldée, reste dû 0 €.
  //  • Étiquette « report projet » ou carte dans la liste « Reports projets » → Report projet.
  //  • « 1/2 payé », « 1/3 payé », « 2/3 payé », « 1/4 payé », « 3/4 payé », « règlement 20 % »,
  //    « règlement 35 % »… = part DÉJÀ payée → reste dû = TTC × (1 − part), noté sur la facture.
  // Une étiquette « Soldée » posée AVANT l'émission de la facture concerne une facture
  // précédente (sauf si la carte cite ce n° de facture) : elle n'est pas appliquée.
  rapport.decisionsTrello = [];
  const fractionEtiquette = (nom) => {
    const n = String(nom || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let m = n.match(/^(\d)\s*\/\s*(\d)\s+pay/); if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
    m = n.match(/r[èe]glement\s+(\d{1,3})\s*%/); if (m) return Number(m[1]) / 100;
    return null;
  };
  const listeReports = new Set(b.lists.filter((l) => /^reports? projets?$/i.test(String(l.name || '').trim())).map((l) => l.id));
  // Répartition PAR CARTE (02/11/2026, règles Lina) : une carte peut porter plusieurs
  // factures (acomptes). On ne met plus rien « à vérifier » pour ça, on classe :
  //  • étiquette « 1/2 payé », « règlement 20 % »… = part payée du PROJET (somme des
  //    factures de la carte) ; on l'impute aux factures dans l'ordre d'émission (la 1re
  //    facture est soldée d'abord) ;
  //  • paiement noté en commentaire (« virement de 1 000 € reçu ») : attribué à la facture
  //    dont le n° est cité ; sinon à celle dont le PDF a été joint en dernier sur la carte
  //    (30 jours avant le paiement) ; sinon à celle dont le reste dû vaut ce montant ;
  //    sinon à la plus ancienne encore ouverte. Seule la part que Pennylane n'a pas déjà
  //    enregistrée est déduite.
  const allocationCarte = new Map();
  {
    const facturesDeCarte = new Map();
    for (const [fid, ents] of cartesDeFacture) for (const { carte } of ents) {
      if (carte.closed) continue;
      const f = parIdFacture.get(String(fid)); if (!f || Number(f.amount) <= 0) continue;
      if (!facturesDeCarte.has(carte.id)) facturesDeCarte.set(carte.id, { carte, fs: new Map() });
      facturesDeCarte.get(carte.id).fs.set(String(f.id), f);
    }
    for (const { carte, fs } of facturesDeCarte.values()) {
      const invs = [...fs.values()].sort((a, c) => String(a.date_emission).localeCompare(String(c.date_emission)));
      const noms = (carte.idLabels || []).map((id) => String(etiquettes.get(id) || '').trim()).filter(Boolean);
      const fr = noms.map((x) => ({ x, p: fractionEtiquette(x) })).filter((y) => y.p != null && y.p > 0 && y.p < 1);
      const part = fr.length ? Math.max(...fr.map((y) => y.p)) : null;
      const etiq = part != null ? fr.find((y) => y.p === part).x : null;
      const res = new Map(invs.map((f) => [String(f.id), { frac: null, etiq, paye: 0, details: [] }]));
      if (part != null) {
        let paye = invs.reduce((s, f) => s + Number(f.amount), 0) * part;
        for (const f of invs) { const a = Math.min(Number(f.amount), paye); paye -= a; res.get(String(f.id)).frac = Math.round((Number(f.amount) - a) * 100) / 100; }
      }
      const coms = (tousComms.get(carte.id) || []).slice().sort((a, c) => (a.date < c.date ? -1 : 1));
      const ouvertes = invs.filter((f) => restant(f) > 1);
      for (const c of coms) {
        if (!c.date || !estPaiement(c.texte || '')) continue;
        const m = montantDans(c.texte); if (!m) continue;
        const dispo = ouvertes.filter((f) => String(f.date_emission) <= c.date.slice(0, 10)); if (!dispo.length) continue;
        const numF = (f) => String(f.invoice_number || '').toUpperCase().replace(/\s|-/g, '');
        let cible = dispo.find((f) => numerosDans(c.texte).has(numF(f)));
        if (!cible) {
          const limite = new Date(new Date(c.date).getTime() - 30 * 86400000).toISOString();
          const pjs = coms.filter((x) => /^\[Pièce jointe/.test(x.texte || '') && x.date <= c.date && x.date >= limite).sort((a, b2) => (a.date < b2.date ? 1 : -1));
          for (const x of pjs) { cible = dispo.find((f) => numerosDans(String(x.texte).slice(0, 250)).has(numF(f))); if (cible) break; }
        }
        if (!cible) cible = dispo.find((f) => Math.abs(restant(f) - m) <= 1);
        if (!cible) cible = dispo[0];
        const r = res.get(String(cible.id)); r.paye += m; r.details.push(`${m.toLocaleString('fr-FR')} € le ${dateFR(c.date)}`);
      }
      for (const [fid, r] of res) allocationCarte.set(fid, r);
    }
  }
  for (const f of factures) {
    if (Number(f.amount) <= 0 || !dansPerimetre(f)) continue;
    const num = String(f.invoice_number || '').toUpperCase().replace(/\s|-/g, '');
    const entrees = cartesDeFacture.get(String(f.id)) || [];
    const ttc = Number(f.amount) || 0, reste = restant(f);
    let statut = null, resteReel = null; const notes = []; let lien = entrees[0] ? entrees[0].carte.shortUrl : null;
    if (f.status === 'cancelled') { statut = 'solde'; resteReel = 0; notes.push('Annulée dans Pennylane → Soldée'); }
    for (const { carte } of entrees) {
      if (carte.closed) continue;
      const noms = (carte.idLabels || []).map((id) => String(etiquettes.get(id) || '').trim()).filter(Boolean);
      const bas = noms.map((x) => x.toLowerCase());
      const citeLaFacture = (nums.get(carte.id) || new Set()).has(num);
      const pose = soldeeLe.get(carte.id);
      const soldeeValable = citeLaFacture || !pose || pose.slice(0, 10) >= String(f.date_emission || '');
      const comSoldee = (tousComms.get(carte.id) || []).find((c) => c.date && c.date.slice(0, 10) >= String(f.date_emission || '')
        && /\bsold[ée]es?\s+(le|au|ce\s+jour)\b/i.test(c.texte || '') && !/\b(pas|non|plus|jamais)\s+(encore\s+)?sold/i.test(c.texte || '')
        && (!numerosDans(c.texte).size || numerosDans(c.texte).has(num)));
      if ((bas.includes('soldée') || bas.includes('soldee') || bas.includes('clôture dossier') || bas.includes('cloture dossier')) && soldeeValable) {
        statut = 'solde'; resteReel = 0; lien = carte.shortUrl; notes.push(`Trello : étiquette « ${noms.find((x) => /sold|cl[ôo]ture/i.test(x))} »${pose ? ' (posée le ' + dateFR(pose) + ')' : ''} → Soldée${reste > 1 ? ', Pennylane affiche encore ' + reste.toFixed(2) + ' € (à rapprocher)' : ''}`);
      } else if (comSoldee) {
        statut = 'solde'; resteReel = 0; lien = carte.shortUrl; notes.push(`Trello le ${dateFR(comSoldee.date)} : « ${extrait(comSoldee.texte)} » → Soldée${reste > 1 ? ', Pennylane affiche encore ' + reste.toFixed(2) + ' € (à rapprocher)' : ''}`);
      }
      if (statut !== 'solde' && bas.some((x) => /annulation dans les d[ée]lais|annulation projet/.test(x))) {
        statut = 'solde'; resteReel = 0; lien = carte.shortUrl; notes.push(`Trello : étiquette « ${noms.find((x) => /annulation/i.test(x))} » → plus rien à encaisser (avoir à établir dans Pennylane si ce n'est pas fait)`);
      }
      if (statut !== 'solde' && (bas.includes('report projet') || listeReports.has(carte.idList))) {
        statut = 'report_projet'; lien = carte.shortUrl; notes.push(bas.includes('report projet') ? 'Trello : étiquette « report projet »' : 'Trello : carte dans la liste « Reports projets »');
      }
      // (fractions et paiements : calculés par carte, voir allocationCarte ci-dessus)
    }
    if (statut !== 'solde') {
      const al = allocationCarte.get(String(f.id));
      if (al) {
        const cands = [];
        if (al.frac != null && al.frac < reste - 1) cands.push({ v: al.frac, n: `Trello : étiquette « ${al.etiq} » (part payée du projet, imputée aux factures dans l'ordre) → reste dû ${al.frac.toFixed(2)} €` });
        const dejaPl = Math.max(0, ttc - reste);
        const nonEnregistre = Math.max(0, al.paye - dejaPl);
        if (nonEnregistre > 1) cands.push({ v: Math.max(0, Math.round((reste - nonEnregistre) * 100) / 100), n: `Trello : paiement(s) ${al.details.join(', ')} attribué(s) à cette facture → reste dû ${Math.max(0, reste - nonEnregistre).toFixed(2)} €` });
        if (cands.length) {
          const best = cands.sort((a, c) => a.v - c.v)[0];
          resteReel = best.v; notes.push(best.n + ` (Pennylane : ${reste.toFixed(2)} €)`);
          if (best.v <= 1) { statut = 'solde'; resteReel = 0; }
        }
      }
    }
    if (statut || resteReel != null) rapport.decisionsTrello.push({ id: f.id, facture: f.invoice_number, client: f.client, statutActuel: f.internal_status || 'a_relancer', statut, resteReel, restePennylane: reste, note: notes.join(' · '), lien });
  }

  rapport.resume = {
    incoherences: rapport.incoherences.length, classementsPrevus: rapport.classementsPrevus.length, numerosInconnus: rapport.numerosInconnus.length,
    nonRelieesRecouvrement: rapport.liens.nonRelieesRecouvrement.length, scp: rapport.scp.length, nouveauxDouteux: rapport.nouveauxDouteux.length,
  };
  return rapport;
}

// « client douteux » en étiquette Trello → Douteux dans le dashboard (15/10/2026, Lina).
// Statut interne du dashboard seulement (rien n'est écrit dans Pennylane ni Trello).

// ── Application des décisions Trello (statuts) ───────────────────────────────────
// APPLIQUER_DECISIONS_TRELLO = false : simulation seule, consultable sur
// /api/finance/trello/decisions. Passer à true après validation de la liste.
const APPLIQUER_DECISIONS_TRELLO = false;
function decisionsAChanger(r) {
  return (r.decisionsTrello || []).filter((d) => d.statut && d.statut !== d.statutActuel
    && (d.statut === 'solde' || ['a_relancer', 'en_cours', 'litige', ''].includes(d.statutActuel)));
}
function appliquerDecisionsTrello(db) {
  if (!APPLIQUER_DECISIONS_TRELLO) return;
  const aChanger = decisionsAChanger(construireRapport(db));
  if (aChanger.length > 80) { console.warn(`[trello] décisions : ${aChanger.length} changements, au-delà du garde-fou (80) — rien n'est appliqué`); return; }
  const maj = db.prepare('UPDATE pennylane_invoices SET internal_status=? WHERE id=?');
  for (const d of aChanger) { maj.run(d.statut, d.id); console.log(`[trello] ${d.facture} ${d.client || ''} : ${d.statutActuel} → ${d.statut} (${d.note})`); }
}
function appliquerDouteuxTrello(db) {
  const r = construireRapport(db);
  const maj = db.prepare("UPDATE pennylane_invoices SET internal_status='douteux' WHERE id=? AND COALESCE(internal_status,'') NOT IN ('douteux','solde')");
  for (const x of r.nouveauxDouteux || []) {
    const res = maj.run(x.id);
    if (res.changes) console.log(`[trello] ${x.facture} ${x.client || ''} → Douteux (étiquette « client douteux » dans Trello)`);
  }
  return r;
}

// ── LISTE TRELLO « Clients Forbes - Stand By » → Litige (20/10/2026, demande Lina) ──
// Toute facture OUVERTE d'un client qui a une carte dans cette liste passe en
// « Litige ». Rapprochement : n° de facture cité sur la carte (titre ou
// description) en priorité, sinon nom de la carte ≈ nom du client Pennylane
// (+ alias quand le nom Trello diffère du nom Pennylane).
// Sens unique : si la carte sort de la liste, la facture GARDE son statut
// (reclassement manuel par les expertes) — une carte déplacée par erreur ne doit
// pas relancer un client en litige.
// Ne touche qu'aux factures « À relancer » / « Relancé » (ou sans statut) : jamais
// à une facture déjà Douteux, Soldée, en Report projet ou en Promesse de paiement.
const LISTE_FORBES = 'clients forbes - stand by';
const ALIAS_FORBES = { 'ila consulting': 'international links & audit consulting' };
const STATUTS_PL_FERMES = ['paid', 'cancelled', 'partially_cancelled', 'archived', 'credit_note'];
const STATUTS_INTERNES_REMPLACABLES = ['', 'a_relancer', 'en_cours'];
function candidatsLitigeForbes(db) { return candidatsListeTrello(db, LISTE_FORBES); }
// Cartes ouvertes d'une liste Trello → factures ouvertes de ces clients (n° cité sur la
// carte, sinon nom de la carte ≈ nom du client). Partagé Forbes / Reports projets.
function candidatsListeTrello(db, nomListe) {
  const b = etat.board;
  if (!b || !etat.cartes) return { cartes: [], factures: [] };
  const idsListe = new Set(b.lists.filter((l) => String(l.name || '').trim().toLowerCase() === nomListe).map((l) => l.id));
  const cartes = etat.cartes.filter((c) => !c.closed && idsListe.has(c.idList));
  const factures = db.prepare(`
    SELECT i.id, i.invoice_number, i.amount, i.remaining_amount, i.status, i.internal_status, c.name AS client
    FROM pennylane_invoices i LEFT JOIN pennylane_customers c ON c.id = i.customer_id
  `).all().filter((f) => Number(f.amount) > 0 && !STATUTS_PL_FERMES.includes(f.status) && (Number(f.remaining_amount) || 0) > 0);
  const resume = [];
  const aPasser = [];
  for (const carte of cartes) {
    const nums = numerosDans(`${carte.name || ''} ${carte.desc || ''}`);
    const nomC = nomCarte(carte.name);
    const nomAlias = ALIAS_FORBES[nomC] ? normNom(ALIAS_FORBES[nomC]) : null;
    const liees = factures.filter((f) => {
      const num = String(f.invoice_number || '').toUpperCase().replace(/\s|-/g, '');
      if (nums.size) return nums.has(num);
      const nomF = normNom(f.client);
      return memeClient(nomC, nomF) || (nomAlias && memeClient(nomAlias, nomF));
    });
    resume.push({ carte: carte.name, url: carte.shortUrl || null, factures: liees.map((f) => ({ facture: f.invoice_number, client: f.client, reste: Number(f.remaining_amount) || 0, statut: f.internal_status || 'a_relancer' })) });
    for (const f of liees) if (STATUTS_INTERNES_REMPLACABLES.includes(f.internal_status || '')) aPasser.push({ id: f.id, facture: f.invoice_number, client: f.client, reste: Number(f.remaining_amount) || 0, carte: carte.name });
  }
  return { cartes: resume, factures: aPasser };
}
// ── LISTE TRELLO « Reports projets » → Report projet (20/10/2026, demande Lina) ──
// Même logique que Forbes : facture ouverte d'un client dont la carte est dans la liste
// « Reports projets » → statut « Report projet ». Ne touche qu'aux factures À relancer /
// Relancé (jamais Douteux, Litige, Soldée, Promesse). Sens unique : une carte qui sort
// de la liste laisse la facture telle quelle (reclassement manuel).
const LISTE_REPORTS = 'reports projets';
function appliquerReportsProjets(db) {
  const r = candidatsListeTrello(db, LISTE_REPORTS);
  if (r.factures.length > 10) { console.warn(`[trello] Reports projets : ${r.factures.length} factures candidates, au-delà du garde-fou (10) — rien n'est appliqué`); return r; }
  const maj = db.prepare("UPDATE pennylane_invoices SET internal_status='report_projet' WHERE id=? AND COALESCE(internal_status,'') IN ('','a_relancer','en_cours')");
  for (const x of r.factures) {
    const res = maj.run(x.id);
    if (res.changes) console.log(`[trello] ${x.facture} ${x.client || ''} → Report projet (carte « ${x.carte} » dans Reports projets)`);
  }
  return r;
}
function appliquerLitigeForbes(db) {
  const r = candidatsLitigeForbes(db);
  // Garde-fou : un rapprochement anormalement large (mauvais nom de liste,
  // carte au nom trop court…) ne doit pas basculer des dizaines de factures.
  if (r.factures.length > 10) { console.warn(`[trello] Forbes : ${r.factures.length} factures candidates, au-delà du garde-fou (10) — rien n'est appliqué`); return r; }
  const maj = db.prepare("UPDATE pennylane_invoices SET internal_status='litige' WHERE id=? AND COALESCE(internal_status,'') IN ('','a_relancer','en_cours')");
  for (const x of r.factures) {
    const res = maj.run(x.id);
    if (res.changes) console.log(`[trello] ${x.facture} ${x.client || ''} → Litige (carte « ${x.carte} » dans Clients Forbes - Stand By)`);
  }
  return r;
}

module.exports = function registerTrelloRecouvrement(app, { db, requireFinance }) {
  pjInit(db);
  setTimeout(() => { chargerLiensAvoirsPennylane(); }, 20000).unref();
  setInterval(() => { chargerLiensAvoirsPennylane(); }, 30 * 60 * 1000).unref();
  if (config()) assurerCharge().catch((e) => console.warn('[trello] chargement initial :', e.message));

  // Mise à jour automatique : nouveautés Trello toutes les 5 minutes (lecture seule).
  if (config()) {
    let occupe = false;
    setInterval(async () => {
      if (occupe || !etat.board) return;
      occupe = true;
      try {
        await rafraichir(); etat.erreur = null;
        try { appliquerDouteuxTrello(db); } catch (e) { console.warn('[trello] douteux :', e.message); }
        try { appliquerLitigeForbes(db); } catch (e) { console.warn('[trello] Forbes :', e.message); }
        try { appliquerReportsProjets(db); } catch (e) { console.warn('[trello] Reports projets :', e.message); }
        try { appliquerDecisionsTrello(db); } catch (e) { console.warn('[trello] décisions :', e.message); }
        await lirePiecesJointes();
      } catch (e) { etat.erreur = e.message; } finally { occupe = false; }
    }, 5 * 60 * 1000).unref(); // toutes les 5 min (au lieu de 20 s)
  }

  // Bouton « Synchroniser » du recouvrement : lit les nouveautés Trello maintenant.
  // Contrôle : ce que la règle « Clients Forbes - Stand By » voit et fait passer en Litige.
  // Simulation / contrôle des décisions tirées des étiquettes et mentions Trello.
  app.get('/api/finance/trello/decisions', requireFinance, (req, res) => {
    try { const r = construireRapport(db); res.json({ applique: APPLIQUER_DECISIONS_TRELLO, decisions: r.decisionsTrello || [], aChanger: decisionsAChanger(r) }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/finance/trello/reports', requireFinance, (req, res) => {
    try { res.json(candidatsListeTrello(db, LISTE_REPORTS)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/finance/trello/forbes', requireFinance, (req, res) => {
    try { res.json(candidatsLitigeForbes(db)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/finance/trello/sync', requireFinance, async (req, res) => {
    try {
      if (!config()) return res.status(503).json({ error: 'Trello non configuré' });
      if (!etat.board) { await assurerCharge(); return res.json({ ok: true, nouvellesActions: etat.actions.length, chargeLe: etat.chargeLe }); }
      const n = await rafraichir();
      etat.erreur = null;
      res.json({ ok: true, nouvellesActions: n || 0, chargeLe: etat.chargeLe });
    } catch (e) {
      etat.erreur = e.message;
      res.status(502).json({ error: e.message });
    }
  });

  // Liste « À vérifier » (admin + finance) : une phrase claire par facture.
  app.get('/api/finance/a-verifier', requireFinance, (req, res) => {
    try {
      if (!config() || !etat.board) return res.json({ pret: false, items: [] });
      const r = construireRapport(db);
      const items = [];
      for (const x of r.incoherences) items.push({ id: x.id, facture: x.facture, raison: `${x.raison}.${x.detail ? ' ' + x.detail : ''}`, lien: x.lien });
      for (const x of r.soldeesAvecReste) items.push({ id: x.id, facture: x.facture, raison: x.raison, lien: x.lien });
      for (const x of r.classementsPrevus) items.push({ id: x.id, facture: x.facture, raison: `À passer en Soldée d'après Trello. ${x.raison}`, lien: x.lien });
      for (const x of r.vieillesFactures) items.push({ id: x.id, facture: x.facture, raison: x.raison, lien: x.lien });
      for (const x of r.anomaliesCalcul || []) items.push({ id: x.id, facture: x.facture, raison: x.raison, lien: x.lien });
      for (const x of r.nouveauxDouteux) items.push({ id: x.id, facture: x.facture, raison: 'Marquée « client douteux » dans Trello mais pas Douteux dans le dashboard.', lien: x.lien });
      // scp : numéros des factures des cartes de la liste Trello « Projets SCP »,
      // retirées du dashboard et des calculs (15/10/2026, demande Lina).
      res.json({ pret: true, genereLe: r.genereLe, items, avoirs: r.avoirs || [], partiels: (r.partielsTrello || []).map((x) => ({ id: x.id, montant: x.montantTrello, details: x.details })), piecesJointes: { lues: pj.lus, erreurs: pj.erreurs, actif: !!pdfParse }, scp: r.scp.map((x) => x.facture) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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
