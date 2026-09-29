// ── IMPORT DES CRÉANCES DOUTEUSES (fichier Excel de la comptabilité) ─────────
// Demande Lina 29/09/2026 : les fichiers « créances douteuses 2025 » et
// « créances douteuses 2026 » (alimenté jusqu'en janvier 2027) doivent passer
// les factures concernées en statut interne "Douteux" sur la plateforme.
// Le 2026 est LU AUTOMATIQUEMENT (lien de partage OneDrive, voir plus bas) ; le
// 2025 est figé, il a été saisi une seule fois (route d'import JSON/xlsx).
//
// Lecture du .xlsx SANS nouvelle dépendance : un .xlsx est un zip de fichiers
// XML — on lit juste ce qu'il faut (feuille 1 + chaînes partagées) avec le
// module natif zlib. Le fichier 2026 est téléchargé automatiquement depuis son
// lien de partage (voir sync2026) ; aucun bouton dans l'interface.
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

// ── Application en base ─────────────────────────────────────────────────────
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
    );
    CREATE TABLE IF NOT EXISTS finance_creances_sync (
      source TEXT PRIMARY KEY,
      last_check_at TEXT,
      last_success_at TEXT,
      last_hash TEXT,
      last_exercice INTEGER,
      last_status TEXT,
      last_message TEXT,
      last_report TEXT
    );
  `);
  // « applied » = 1 quand le statut a bien été traité pour cette ligne (facture trouvée).
  const cols = db.prepare("PRAGMA table_info(finance_creances_douteuses)").all().map((c) => c.name);
  if (!cols.includes('applied')) db.exec('ALTER TABLE finance_creances_douteuses ADD COLUMN applied INTEGER DEFAULT 0');
}

// Statuts internes qu'un import ne doit jamais écraser (voir en-tête).
const PROTEGES = { solde: 'déjà soldée (payée/annulée côté Pennylane)', litige: 'en litige (posé à la main)', promesse_paiement: 'promesse de paiement (posée à la main)' };

function applyImport(db, parsed, opts = {}) {
  ensureSchema(db);
  const force = !!opts.force;
  const upsert = db.prepare(`
    INSERT INTO finance_creances_douteuses
      (exercice, invoice_number, client, siret, ref_rubypayeur, solde_debut, nouveaux, reglements, irrecouvrable, solde_fin, procedure_code, diffuse, commentaire, applied, imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(exercice, invoice_number) DO UPDATE SET
      client=excluded.client, siret=excluded.siret, ref_rubypayeur=excluded.ref_rubypayeur,
      solde_debut=excluded.solde_debut, nouveaux=excluded.nouveaux, reglements=excluded.reglements,
      irrecouvrable=excluded.irrecouvrable, solde_fin=excluded.solde_fin,
      procedure_code=excluded.procedure_code, diffuse=excluded.diffuse, commentaire=excluded.commentaire,
      applied=excluded.applied, imported_at=excluded.imported_at
  `);
  const previous = db.prepare('SELECT solde_fin, applied FROM finance_creances_douteuses WHERE exercice=? AND invoice_number=?');
  const latest = db.prepare('SELECT MAX(exercice) AS ex FROM finance_creances_douteuses WHERE invoice_number=?');
  const findInvoices = db.prepare("SELECT id, invoice_number, internal_status, date_emission, status FROM pennylane_invoices WHERE UPPER(REPLACE(invoice_number,' ',''))=?");
  const setDouteux = db.prepare("UPDATE pennylane_invoices SET internal_status='douteux' WHERE id=?");

  const report = {
    exercice: parsed.exercice,
    lignes: parsed.rows.length,
    facturesDansFichier: 0,
    marquees: [], dejaDouteux: [], protegees: [], ignoreesSoldeZero: [], remplaceesParExerciceRecent: [],
    introuvables: [], avant2025: [], inchangees: [],
  };

  const run = db.transaction(() => {
    for (const row of parsed.rows) {
      for (const num of row.invoiceNumbers) {
        report.facturesDansFichier++;
        const prev = previous.get(parsed.exercice, num);
        // Facture déjà traitée avec le même solde : on ne repasse pas dessus, pour respecter
        // un changement de statut fait à la main depuis (sauf import forcé).
        const unchanged = !force && prev && prev.applied === 1 && Math.abs((prev.solde_fin || 0) - row.soldeFin) < 0.005;
        let applied = 0;
        // L'exercice le plus récent présent en base fait foi pour ce numéro.
        const exBefore = latest.get(num).ex;
        const isOutdated = exBefore != null && exBefore > parsed.exercice;
        if (isOutdated) {
          report.remplaceesParExerciceRecent.push({ numero: num, exercice: exBefore });
        } else if (!(row.soldeFin > 0.005)) {
          report.ignoreesSoldeZero.push({ numero: num, client: row.client });
          applied = 1;
        } else if (unchanged) {
          report.inchangees.push({ numero: num, client: row.client });
          applied = 1;
        } else {
          const invoices = findInvoices.all(num);
          if (!invoices.length) {
            report.introuvables.push({ numero: num, client: row.client, soldeFin: row.soldeFin });
          } else {
            applied = 1;
            for (const inv of invoices) {
              const item = { numero: num, client: row.client, id: inv.id, soldeFin: row.soldeFin };
              if (inv.date_emission && inv.date_emission < '2025-01-01') report.avant2025.push({ numero: num, client: row.client, dateEmission: inv.date_emission });
              if (inv.internal_status === 'douteux') report.dejaDouteux.push(item);
              else if (PROTEGES[inv.internal_status]) report.protegees.push({ ...item, statutActuel: inv.internal_status, raison: PROTEGES[inv.internal_status] });
              else { setDouteux.run(inv.id); report.marquees.push(item); }
            }
          }
        }
        upsert.run(parsed.exercice, num, row.client, row.siret, row.ref, row.soldeDebut, row.nouveaux,
          row.reglements, row.irrecouvrable, row.soldeFin, row.procedure, row.diffuse, row.commentaire, applied);
      }
    }
  });
  run();
  return report;
}

// ── Lecture automatique du fichier 2026 (lien de partage OneDrive) ───────────
// Le lien fourni par Lina s'ouvre sans compte Microsoft ; le serveur le télécharge
// tout seul (au démarrage puis toutes les 20 min) et n'applique que si le contenu a changé.
const SOURCE_2026_NAME = 'creances-douteuses-2026';
const SOURCE_2026_LINK = process.env.DOUTEUX_2026_URL
  || 'https://1drv.ms/x/c/d6eccc23093d687d/IQBYzzIFZNNPQYAg22VWCMDJAWbBjNHzjtXrHUbfY2-w5AM?e=0rZcIj';
const SYNC_EVERY_MS = 20 * 60 * 1000;

function shareToken(link) {
  return 'u!' + Buffer.from(link, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}
const isZip = (b) => Buffer.isBuffer(b) && b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;

async function downloadShared(link) {
  const attempts = [];
  const candidates = [
    ['api-shares', `https://api.onedrive.com/v1.0/shares/${shareToken(link)}/root/content`],
    ['lien-direct', link + (link.includes('?') ? '&' : '?') + 'download=1'],
  ];
  for (const [name, url] of candidates) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (OpenMedias-dashboard)' } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && isZip(buf)) return { buf, via: name, attempts };
      attempts.push(`${name}: HTTP ${res.status}, ${buf.length} octets${res.ok ? ' (pas un .xlsx)' : ''}`);
    } catch (e) {
      attempts.push(`${name}: ${e.message}`);
    }
  }
  return { buf: null, attempts };
}

function saveSyncState(db, patch) {
  ensureSchema(db);
  const cur = db.prepare('SELECT * FROM finance_creances_sync WHERE source=?').get(SOURCE_2026_NAME) || {};
  const next = { ...cur, ...patch, source: SOURCE_2026_NAME };
  db.prepare(`INSERT INTO finance_creances_sync (source,last_check_at,last_success_at,last_hash,last_exercice,last_status,last_message,last_report)
    VALUES (@source,@last_check_at,@last_success_at,@last_hash,@last_exercice,@last_status,@last_message,@last_report)
    ON CONFLICT(source) DO UPDATE SET last_check_at=excluded.last_check_at,last_success_at=excluded.last_success_at,last_hash=excluded.last_hash,
      last_exercice=excluded.last_exercice,last_status=excluded.last_status,last_message=excluded.last_message,last_report=excluded.last_report`)
    .run({ last_check_at: null, last_success_at: null, last_hash: null, last_exercice: null, last_status: null, last_message: null, last_report: null, ...next });
}

async function sync2026(db, { force = false } = {}) {
  ensureSchema(db);
  const now = new Date().toISOString();
  try {
    const dl = await downloadShared(SOURCE_2026_LINK);
    if (!dl.buf) {
      saveSyncState(db, { last_check_at: now, last_status: 'echec', last_message: 'Téléchargement impossible — ' + dl.attempts.join(' | ') });
      return { ok: false, message: 'Téléchargement impossible', attempts: dl.attempts };
    }
    const hash = require('crypto').createHash('sha256').update(dl.buf).digest('hex');
    const cur = db.prepare('SELECT last_hash FROM finance_creances_sync WHERE source=?').get(SOURCE_2026_NAME);
    if (!force && cur && cur.last_hash === hash) {
      saveSyncState(db, { last_check_at: now, last_status: 'a_jour', last_message: 'Fichier inchangé (' + dl.via + ')' });
      return { ok: true, changed: false };
    }
    const parsed = parseCreancesDouteuses(dl.buf);
    const report = applyImport(db, parsed, { force });
    saveSyncState(db, {
      last_check_at: now, last_success_at: now, last_hash: hash, last_exercice: parsed.exercice, last_status: 'importe',
      last_message: `Import automatique (${dl.via}) : ${report.marquees.length} passée(s) en Douteux, ${report.introuvables.length} introuvable(s)`,
      last_report: JSON.stringify(report),
    });
    console.log(`[FINANCE] créances douteuses ${parsed.exercice} (auto) : ${report.marquees.length} passée(s) en Douteux, ${report.introuvables.length} introuvable(s), ${report.inchangees.length} inchangée(s)`);
    return { ok: true, changed: true, report };
  } catch (e) {
    console.error('[FINANCE] sync créances douteuses KO :', e.message);
    saveSyncState(db, { last_check_at: now, last_status: 'erreur', last_message: e.message });
    return { ok: false, message: e.message };
  }
}

module.exports = function registerCreancesDouteuses(app, { db, requireFinance }) {
  ensureSchema(db);
  let express;
  try { express = require('express'); } catch (e) { express = null; }
  const rawBody = express ? express.raw({ type: () => true, limit: '15mb' }) : (req, res, next) => next();

  // Import ponctuel (utilisé une seule fois pour le fichier 2025, figé). Corps = .xlsx brut,
  // ou JSON { exercice, rows:[…] } au format produit par le lecteur.
  app.post('/api/finance/douteux/import', requireFinance, rawBody, (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Aucun fichier reçu' });
      let parsed;
      if (req.body[0] === 0x7b) { // « { » : JSON déjà lu
        const j = JSON.parse(req.body.toString('utf8'));
        if (!j.exercice || !Array.isArray(j.rows)) throw new Error('JSON invalide (exercice / rows attendus)');
        parsed = { exercice: parseInt(j.exercice, 10), rows: j.rows.map((r) => ({
          line: r.line || 0, client: String(r.client || ''), siret: r.siret ?? null, ref: r.ref ?? null,
          soldeDebut: +r.soldeDebut || 0, nouveaux: +r.nouveaux || 0, reglements: +r.reglements || 0,
          irrecouvrable: +r.irrecouvrable || 0, soldeFin: +r.soldeFin || 0, procedure: r.procedure ?? null,
          diffuse: r.diffuse ?? null, commentaire: r.commentaire ?? null,
          invoiceNumbers: (r.invoiceNumbers || []).map((n) => String(n).toUpperCase().replace(/\s/g, '')).filter((n) => /^F\d{3,6}$/.test(n)),
        })) };
      } else {
        parsed = parseCreancesDouteuses(req.body, req.query.exercice);
      }
      const report = applyImport(db, parsed, { force: req.query.force === '1' });
      console.log(`[FINANCE] import créances douteuses ${parsed.exercice} : ${report.marquees.length} passée(s) en Douteux, ${report.introuvables.length} introuvable(s)`);
      res.json({ ok: true, ...report });
    } catch (e) {
      console.error('[FINANCE] import créances douteuses KO :', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // État de la synchronisation automatique du fichier 2026.
  app.get('/api/finance/douteux/statut', requireFinance, (req, res) => {
    const row = db.prepare('SELECT * FROM finance_creances_sync WHERE source=?').get(SOURCE_2026_NAME) || null;
    const counts = db.prepare('SELECT exercice, COUNT(*) AS n FROM finance_creances_douteuses GROUP BY exercice').all();
    if (row && row.last_report) { try { const r = JSON.parse(row.last_report); row.last_report = { marquees: r.marquees.length, dejaDouteux: r.dejaDouteux.length, protegees: r.protegees, introuvables: r.introuvables, inchangees: r.inchangees.length, ignoreesSoldeZero: r.ignoreesSoldeZero.length, avant2025: r.avant2025 }; } catch (e) { /* laissé tel quel */ } }
    res.json({ sync: row, lignesEnBase: counts });
  });

  // Relance immédiate de la synchro (sans bouton dans l'interface : usage technique).
  app.post('/api/finance/douteux/sync', requireFinance, async (req, res) => {
    res.json(await sync2026(db, { force: req.query.force === '1' }));
  });

  // Détail comptable d'une facture (dernier exercice connu).
  app.get('/api/finance/douteux/facture/:numero', requireFinance, (req, res) => {
    const num = String(req.params.numero || '').replace(/\s/g, '').toUpperCase();
    const row = db.prepare('SELECT * FROM finance_creances_douteuses WHERE invoice_number=? ORDER BY exercice DESC LIMIT 1').get(num);
    res.json(row || null);
  });

  // Synchro automatique : 1 min après le démarrage puis toutes les 20 min.
  const first = setTimeout(() => sync2026(db), 60 * 1000);
  const loop = setInterval(() => sync2026(db), SYNC_EVERY_MS);
  if (first.unref) first.unref();
  if (loop.unref) loop.unref();
};
module.exports.parseCreancesDouteuses = parseCreancesDouteuses;
module.exports.applyImport = applyImport;
module.exports.sync2026 = sync2026;
