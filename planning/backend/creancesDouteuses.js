// ── IMPORT DES CRÉANCES DOUTEUSES (fichier Excel de la comptabilité) ─────────
// Demande Lina 29/09/2026 : les fichiers « créances douteuses 2025 » et
// « créances douteuses 2026 » (alimenté jusqu'en janvier 2027) doivent passer
// les factures concernées en statut interne "Douteux" sur la plateforme.
//
// Lecture du .xlsx SANS nouvelle dépendance : un .xlsx est un zip de fichiers
// XML — on lit juste ce qu'il faut (feuille 1 + chaînes partagées) avec le
// module natif zlib. Les liens OneDrive fournis demandent une connexion
// Microsoft (API "unauthenticated" testée le 29/09), le serveur ne peut donc
// pas les lire seul : le fichier est déposé via un bouton dans Recouvrement.
//
// Règles (décidées avec Lina, cf. claude/decisions-douteux-avoirs-import-excel.md) :
// - une facture passe en `douteux` seulement si le solde TTC de fin d'exercice
//   du fichier est > 0 (les lignes à 0 : payées / avoirs / irrécouvrables, ne
//   changent rien) ;
// - pour un même numéro de facture, c'est l'exercice le PLUS RÉCENT présent en
//   base qui fait foi (le 2026 remplace le 2025) — l'ordre d'import n'a donc
//   pas d'importance ;
// - on ne touche jamais une facture déjà `solde` (payée/annulée chez
//   Pennylane), `litige` ou `promesse_paiement` (posés à la main) : elles sont
//   listées dans le compte rendu, pas modifiées ;
// - aucune suppression, aucun retour en arrière automatique ;
// - la règle d'affichage « factures émises avant le 01/01/2025 abandonnées »
//   n'est PAS touchée : ces factures peuvent être marquées mais restent
//   invisibles dans la liste (signalé dans le compte rendu).
const zlib = require('zlib');

// ── Lecture zip minimale (méthodes 0 = stocké, 8 = deflate) ────────────────
function readZipEntries(buf) {
  // End Of Central Directory : signature 0x06054b50, cherchée depuis la fin.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Fichier illisible : ce n'est pas un .xlsx valide");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Fichier .xlsx corrompu (répertoire central)');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('Fichier .xlsx corrompu (entrée locale)');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries.set(name, { method, raw });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function entryText(entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const data = e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw);
  return data.toString('utf8');
}

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function textOfRuns(xml) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += decodeXml(m[1]);
  return out;
}
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// Retourne { rows: Map<numLigne, Map<numColonne, valeur>> } pour la 1re feuille.
function parseFirstSheet(buf) {
  const entries = readZipEntries(buf);
  const shared = [];
  const sst = entryText(entries, 'xl/sharedStrings.xml');
  if (sst) {
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(sst))) shared.push(textOfRuns(m[1]));
  }
  // 1re feuille dans l'ordre du classeur (et pas "sheet1.xml" en dur).
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = entryText(entries, 'xl/workbook.xml');
  const rels = entryText(entries, 'xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const sm = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb);
    if (sm) {
      const relRe = new RegExp('<Relationship\\b[^>]*\\bId="' + sm[1] + '"[^>]*>');
      const rm = relRe.exec(rels);
      const tm = rm && /\bTarget="([^"]+)"/.exec(rm[0]);
      if (tm) sheetPath = tm[1].startsWith('/') ? tm[1].slice(1) : 'xl/' + tm[1];
    }
  }
  const sheet = entryText(entries, sheetPath);
  if (!sheet) throw new Error('Feuille introuvable dans le fichier .xlsx');
  const rows = new Map();
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = cellRe.exec(sheet))) {
    const attrs = m[1];
    const inner = m[2] || '';
    const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
    if (!ref) continue;
    const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
    let value = null;
    if (type === 'inlineStr') {
      value = textOfRuns(inner);
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (v) {
        if (type === 's') value = shared[parseInt(v[1], 10)] ?? '';
        else if (type === 'str') value = decodeXml(v[1]);
        else if (type === 'b') value = v[1] === '1';
        else if (type === 'e') value = null;
        else { const num = Number(v[1]); value = Number.isFinite(num) ? num : decodeXml(v[1]); }
      }
    }
    if (value === null || value === '') continue;
    const r = parseInt(ref[2], 10);
    if (!rows.has(r)) rows.set(r, new Map());
    rows.get(r).set(colIndex(ref[1]), value);
  }
  return rows;
}

// ── Lecture métier du tableau « Détail des clients douteux » ───────────────
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const toNumber = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
function invoiceNumbersOf(cell) {
  const out = [];
  const re = /\bF\s?(\d{3,6})/gi; // gère aussi "F6447du 12/12/2025" (pas d'espace)
  let m;
  while ((m = re.exec(String(cell || '')))) {
    const n = 'F' + m[1];
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function parseCreancesDouteuses(buf, fallbackExercice) {
  const sheet = parseFirstSheet(buf);
  // Exercice : cellule « Exercice 2026 » en haut du fichier.
  let exercice = null;
  for (const [r, cols] of sheet) {
    if (r > 6) break;
    for (const v of cols.values()) {
      const m = /exercice\s+(\d{4})/i.exec(String(v));
      if (m) exercice = parseInt(m[1], 10);
    }
  }
  if (!exercice) exercice = fallbackExercice ? parseInt(fallbackExercice, 10) : null;
  if (!exercice) throw new Error("Impossible de déterminer l'exercice (cellule « Exercice AAAA » introuvable)");

  // Ligne d'en-têtes : celle qui contient « Noms clients ».
  let headerRow = null;
  for (const [r, cols] of sheet) {
    for (const v of cols.values()) if (norm(v).startsWith('noms clients')) headerRow = r;
    if (headerRow) break;
  }
  if (!headerRow) throw new Error("En-tête « Noms clients » introuvable : ce n'est pas le tableau des créances douteuses");
  const hdr = sheet.get(headerRow);
  const col = { soldeDebut: null, soldeFin: null };
  let nFacture = null;
  for (const [c, v] of hdr) {
    const h = norm(v);
    if (h.startsWith('noms clients')) col.client = c;
    else if (h.startsWith('siret')) col.siret = c;
    else if (h.startsWith('réf rubypayeur') || h.startsWith('ref rubypayeur')) col.ref = c;
    else if (h.startsWith('soldes ttc')) { if (col.soldeDebut == null) col.soldeDebut = c; else col.soldeFin = c; }
    else if (h.startsWith('nouveaux')) col.nouveaux = c;
    else if (h.startsWith('règlements') || h.startsWith('reglements')) col.reglements = c;
    else if (h.startsWith('créances') || h.startsWith('creances')) col.irrecouvrable = c;
    else if (h.startsWith('n° facture') || h.startsWith('n°facture') || h.startsWith('no facture')) nFacture = c;
    else if (h.startsWith('diffusé') || h.startsWith('diffuse')) col.diffuse = c;
    else if (h.startsWith('commentaires')) col.commentaire = c;
  }
  if (col.client == null || nFacture == null || col.soldeFin == null) {
    throw new Error('Colonnes attendues introuvables (Noms clients / N° facture / Soldes TTC fin d’exercice)');
  }
  col.procedure = nFacture + 1; // colonne sans titre juste à droite : LJ / RJ / F

  const rows = [];
  const lastRow = Math.max(...sheet.keys());
  for (let r = headerRow + 1; r <= lastRow; r++) {
    const cols = sheet.get(r);
    if (!cols) continue;
    const isTotal = [...cols.values()].some((v) => norm(v) === 'total');
    if (isTotal) break;
    const client = cols.get(col.client);
    if (!client) continue;
    const numbers = invoiceNumbersOf(cols.get(nFacture));
    rows.push({
      line: r,
      client: String(client).trim(),
      siret: cols.get(col.siret) != null ? String(cols.get(col.siret)) : null,
      ref: cols.get(col.ref) != null ? String(cols.get(col.ref)) : null,
      soldeDebut: toNumber(cols.get(col.soldeDebut)),
      nouveaux: toNumber(cols.get(col.nouveaux)),
      reglements: toNumber(cols.get(col.reglements)),
      irrecouvrable: toNumber(cols.get(col.irrecouvrable)),
      soldeFin: toNumber(cols.get(col.soldeFin)),
      procedure: cols.get(col.procedure) != null ? String(cols.get(col.procedure)).trim() : null,
      diffuse: cols.get(col.diffuse) != null ? String(cols.get(col.diffuse)).trim() : null,
      commentaire: cols.get(col.commentaire) != null ? String(cols.get(col.commentaire)).trim() : null,
      invoiceNumbers: numbers,
    });
  }
  return { exercice, rows };
}

// ── Application en base ────────────────────────────────────────────────────
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finance_creances_douteuses (
      exercice INTEGER NOT NULL,
      invoice_number TEXT NOT NULL,
      client TEXT,
      siret TEXT,
      ref_rubypayeur TEXT,
      solde_debut REAL,
      nouveaux REAL,
      reglements REAL,
      irrecouvrable REAL,
      solde_fin REAL,
      procedure_code TEXT,
      diffuse TEXT,
      commentaire TEXT,
      imported_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (exercice, invoice_number)
    )
  `);
}

// Statuts internes qu'un import ne doit jamais écraser (voir en-tête).
const PROTEGES = { solde: 'déjà soldée (payée/annulée côté Pennylane)', litige: 'en litige (posé à la main)', promesse_paiement: 'promesse de paiement (posée à la main)' };

function applyImport(db, parsed) {
  ensureSchema(db);
  const upsert = db.prepare(`
    INSERT INTO finance_creances_douteuses
      (exercice, invoice_number, client, siret, ref_rubypayeur, solde_debut, nouveaux, reglements, irrecouvrable, solde_fin, procedure_code, diffuse, commentaire, imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(exercice, invoice_number) DO UPDATE SET
      client=excluded.client, siret=excluded.siret, ref_rubypayeur=excluded.ref_rubypayeur,
      solde_debut=excluded.solde_debut, nouveaux=excluded.nouveaux, reglements=excluded.reglements,
      irrecouvrable=excluded.irrecouvrable, solde_fin=excluded.solde_fin,
      procedure_code=excluded.procedure_code, diffuse=excluded.diffuse, commentaire=excluded.commentaire,
      imported_at=excluded.imported_at
  `);
  const latest = db.prepare('SELECT MAX(exercice) AS ex FROM finance_creances_douteuses WHERE invoice_number=?');
  const findInvoices = db.prepare("SELECT id, invoice_number, internal_status, date_emission, status FROM pennylane_invoices WHERE UPPER(REPLACE(invoice_number,' ',''))=?");
  const setDouteux = db.prepare("UPDATE pennylane_invoices SET internal_status='douteux' WHERE id=?");

  const report = {
    exercice: parsed.exercice,
    lignes: parsed.rows.length,
    facturesDansFichier: 0,
    marquees: [], dejaDouteux: [], protegees: [], ignoreesSoldeZero: [], remplaceesParExerciceRecent: [],
    introuvables: [], avant2025: [],
  };

  const run = db.transaction(() => {
    for (const row of parsed.rows) {
      for (const num of row.invoiceNumbers) {
        report.facturesDansFichier++;
        upsert.run(parsed.exercice, num, row.client, row.siret, row.ref, row.soldeDebut, row.nouveaux,
          row.reglements, row.irrecouvrable, row.soldeFin, row.procedure, row.diffuse, row.commentaire);
        // L'exercice le plus récent présent en base fait foi pour ce numéro.
        const ex = latest.get(num).ex;
        if (ex !== parsed.exercice) { report.remplaceesParExerciceRecent.push({ numero: num, exercice: ex }); continue; }
        if (!(row.soldeFin > 0.005)) { report.ignoreesSoldeZero.push({ numero: num, client: row.client }); continue; }
        const invoices = findInvoices.all(num);
        if (!invoices.length) { report.introuvables.push({ numero: num, client: row.client, soldeFin: row.soldeFin }); continue; }
        for (const inv of invoices) {
          const item = { numero: num, client: row.client, id: inv.id, soldeFin: row.soldeFin };
          if (inv.date_emission && inv.date_emission < '2025-01-01') report.avant2025.push({ numero: num, client: row.client, dateEmission: inv.date_emission });
          if (inv.internal_status === 'douteux') report.dejaDouteux.push(item);
          else if (PROTEGES[inv.internal_status]) report.protegees.push({ ...item, statutActuel: inv.internal_status, raison: PROTEGES[inv.internal_status] });
          else { setDouteux.run(inv.id); report.marquees.push(item); }
        }
      }
    }
  });
  run();
  return report;
}

module.exports = function registerCreancesDouteuses(app, { db, requireFinance }) {
  ensureSchema(db);
  let express;
  try { express = require('express'); } catch (e) { express = null; }
  const rawBody = express ? express.raw({ type: () => true, limit: '15mb' }) : (req, res, next) => next();

  // Le fichier .xlsx est envoyé tel quel dans le corps de la requête.
  app.post('/api/finance/douteux/import', requireFinance, rawBody, (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Aucun fichier reçu' });
      const parsed = parseCreancesDouteuses(req.body, req.query.exercice);
      const report = applyImport(db, parsed);
      console.log(`[FINANCE] import créances douteuses ${parsed.exercice} : ${report.marquees.length} facture(s) passée(s) en Douteux, ${report.introuvables.length} introuvable(s)`);
      res.json({ ok: true, ...report });
    } catch (e) {
      console.error('[FINANCE] import créances douteuses KO :', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // Détail comptable d'une facture (dernier exercice connu) — pour la fiche.
  app.get('/api/finance/douteux/facture/:numero', requireFinance, (req, res) => {
    const num = String(req.params.numero || '').replace(/\s/g, '').toUpperCase();
    const row = db.prepare('SELECT * FROM finance_creances_douteuses WHERE invoice_number=? ORDER BY exercice DESC LIMIT 1').get(num);
    res.json(row || null);
  });
};
module.exports.parseCreancesDouteuses = parseCreancesDouteuses;
module.exports.applyImport = applyImport;
