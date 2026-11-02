// ==========================================
// BDC -- MOTEUR DE RENDU (fusionne depuis bdc-generator)
// ==========================================
// Meme moteur que l'app standalone bdc-generator (Handlebars + Puppeteer),
// integre directement dans le backend du planning de diffusion pour eviter
// tout aller-retour vers un autre service/domaine. Les templates et les
// bannieres sont des copies exactes de bdc-generator/templates et
// bdc-generator/assets -- si un template est corrige ou qu'un media est
// ajoute la-bas, reporter le meme changement ici (les deux services restent
// volontairement independants).

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const TEMPLATES = {
  'figaro-48h-hp': {
    template: path.join(__dirname, 'templates', 'figaro-48h-hp.html'),
    headerImage: path.join(__dirname, 'assets', 'header-figaro-48h-hp.png'),
    media: 'LE FIGARO',
    descriptionItems: [
      'Interview vidéo, tournée en plateau TV Openmedias, d’environ 5 à 7 minutes',
      'Mise en lumière sur la page d’accueil de https://www.lefigaro.fr/ (pendant 48h)',
      'Mise en lumière sur la rubrique économie de https://www.lefigaro.fr/economie (pendant 48h)',
      'Page web dédiée dans le dossier "Réussites d’Entreprises" sans limite de temps, avec un article rédactionnel, et pavé contact intégrant jusqu’à 2 liens de redirection',
      'Le budget comprend l’intervention de nos équipes de tournage, le montage, le graphisme, l’intégration et la gestion de projet.',
      'Rétrocession des droits sur les éléments.',
      'Référencement SEO',
    ],
  },
  'bfm-business-vision': {
    template: path.join(__dirname, 'templates', 'bfm-business-vision.html'),
    headerImage: path.join(__dirname, 'assets', 'header-bfm-business-vision.png'),
    media: 'BFM BUSINESS',
    descriptionItems: [
      'Sélection interview "Vision d’Entreprises" au sein de la HP https://www.bfmtv.com/economie/',
      'Interview vidéo, tournée en plateau TV Openmedias, d’environ 5 à 8 minutes',
      'Page web dédiée dans la rubrique "Vision d’Entreprises" sur https://www.bfmtv.com/economie/ avec un article rédactionnel, et pavé contact intégrant jusqu’à 1 lien de redirection',
      'Mise en lumière sur la page d’accueil de https://www.bfmtv.com/economie/ (Minimum 2 jours)',
      'Le budget comprend l’intervention de nos équipes de tournage, le montage, le graphisme, l’intégration et la gestion de projet.',
      'Rétrocession des droits sur les éléments.',
      'Référencement SEO',
      'Présence illimitée sur bfmtv.com/economie',
    ],
  },
  'capital-emission': {
    template: path.join(__dirname, 'templates', 'capital-emission.html'),
    headerImage: path.join(__dirname, 'assets', 'header-capital-emission.png'),
    media: 'CAPITAL',
    descriptionItems: [
      'Interview vidéo, tournée en plateau TV Openmedias, d’environ 5 à 7 minutes',
      'Mise en lumière sur la page d’accueil de https://www.capital.fr (pendant 48h)',
      'Mise en lumière dans la rubrique Business sur https://www.capital.fr/entreprises-marches (pendant 48h)',
      'Page web dédiée hébergée sans limite de temps dans le dossier "<a href="#">Le Rendez-vous des Pros</a>" avec un article rédactionnel, et un pavé contact intégrant jusqu’à 2 liens de redirection',
      'Le budget comprend l’intervention de nos équipes de tournage, le montage, le graphisme, l’intégration et la gestion de projet.',
      'Référencement SEO',
      'Rétrocession des droits sur les éléments.',
    ],
  },
};

// Registre genere depuis les PDF sources (_bdc_work/generate_templates.py) :
// 47 templates supplementaires avec bannieres liees. Les chemins y sont
// relatifs a ce dossier (bdc/) -> conversion en absolu au moment du merge.
const GENERATED = require('./templates.generated');
for (const [key, cfg] of Object.entries(GENERATED)) {
  if (TEMPLATES[key]) continue; // ne jamais ecraser un template maintenu a la main
  TEMPLATES[key] = {
    ...cfg,
    template: path.join(__dirname, cfg.template),
    headerImage: cfg.headerImage ? path.join(__dirname, cfg.headerImage) : null,
  };
}

function eur(n) {
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

function imageToDataUri(filePath) {
  const data = fs.readFileSync(filePath);
  return `data:image/png;base64,${data.toString('base64')}`;
}

function isTruthyFlag(v) {
  return v === true || v === 'true' || v === 'on' || v === '1';
}

function normalizeDescriptionItems(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((s) => String(s || '').trim()).filter(Boolean);
}

function compileBdcHtml(templateKey, fields = {}) {
  const cfg = TEMPLATES[templateKey];
  if (!cfg) throw new Error(`Template BDC inconnu: "${templateKey}". Templates disponibles: ${Object.keys(TEMPLATES).join(', ')}`);

  const source = fs.readFileSync(cfg.template, 'utf8');
  const compiled = Handlebars.compile(source);

  const montantHT = Number(fields.montantHT || 0);
  const noTva = isTruthyFlag(fields.noTva);
  const tvaRate = noTva ? 0 : 0.20;
  const tva = montantHT * tvaRate;
  const ttc = montantHT * (1 + tvaRate);

  const descriptionItems = normalizeDescriptionItems(fields.descriptionItems);

  return compiled({
    headerImage: imageToDataUri(cfg.headerImage),
    entreprise: fields.entreprise || '',
    dateDuJour: fields.dateDuJour || new Date().toLocaleDateString('fr-FR'),
    contact: fields.contact || '',
    adresse: fields.adresse || '',
    thematique: fields.thematique || '',
    personneContact: fields.personneContact || fields.contact || '',
    dateDiffusion: fields.dateDiffusion || '',
    respEmission: fields.respEmission || '',
    media: fields.media || cfg.media,
    puHT: eur(montantHT),
    totalHT: eur(montantHT),
    descriptionItems: descriptionItems.length ? descriptionItems : cfg.descriptionItems,
    delaiReglementLigne1: fields.delaiReglementLigne1 || '50% a la commande, 50% un mois avant diffusion',
    delaiReglementLigne2: fields.delaiReglementLigne2 || 'Prelevement SEPA',
    delaiReglementLigne3: fields.delaiReglementLigne3 || '',
    delaiReglementLigne4: fields.delaiReglementLigne4 || '',
    totalNetHT: eur(montantHT),
    tvaLabel: cfg.lang === 'en'
      ? (noTva ? 'VAT (exemption, in €) :' : 'VAT 20% (in €) :')
      : (noTva ? 'TVA (exoneration, en €) :' : 'TVA 20% (en €) :'),
    tva: eur(tva),
    montantTTC: eur(ttc),
  });
}

async function renderBdcHtml(templateKey, fields = {}) {
  return compileBdcHtml(templateKey, fields);
}

// Génération des PDF de BDC (Chromium partagé, 02/11/2026).
// Historique des pannes : le 23/10/2026, deux BDC lancés en même temps ont décompressé
// Chromium dans /tmp au même moment (« spawn ETXTBSY ») → binaire abîmé → tous les BDC
// suivants en « Failed to launch the browser process! » jusqu'au redémarrage ; et le
// service tombait en manque de mémoire (512 Mo) car chaque BDC lançait SON Chromium.
// Désormais :
//  • UN seul Chromium, lancé à la première demande et partagé : chaque BDC n'ouvre
//    qu'un onglet → plusieurs BDC en même temps (3 en parallèle, les suivants attendent
//    quelques secondes), sans relancer Chromium à chaque fois ;
//  • le chemin du binaire n'est calculé qu'une fois (plus de décompression concurrente) ;
//  • si Chromium ne démarre pas : binaire effacé de /tmp, réinstallé, nouvel essai ;
//  • si Chromium s'est arrêté entre deux BDC : relancé automatiquement ;
//  • Chromium est fermé après 60 s sans BDC pour rendre la mémoire au reste du service.
const BDC_EN_PARALLELE = 3;
let cheminChromium = null;
let navigateurPartage = null;
let minuterieFermeture = null;
let bdcEnCours = 0;
const bdcEnAttente = [];
function cheminNavigateur() {
  if (!cheminChromium) cheminChromium = chromium.executablePath().catch((e) => { cheminChromium = null; throw e; });
  return cheminChromium;
}
async function lancerNavigateur() {
  const options = async () => ({ args: chromium.args, executablePath: await cheminNavigateur(), headless: chromium.headless });
  try {
    return await puppeteer.launch(await options());
  } catch (e) {
    console.warn(`[BDC] lancement de Chromium échoué (${e.message}) — binaire réinstallé, nouvel essai`);
    cheminChromium = null;
    for (const f of ['/tmp/chromium', '/tmp/chromium-pack', '/tmp/swiftshader', '/tmp/al2', '/tmp/al2023']) {
      try { fs.rmSync(f, { recursive: true, force: true }); } catch (_) { /* rien */ }
    }
    return puppeteer.launch(await options());
  }
}
function obtenirNavigateur() {
  if (!navigateurPartage) {
    navigateurPartage = lancerNavigateur()
      .then((b) => { b.on('disconnected', () => { navigateurPartage = null; }); return b; })
      .catch((e) => { navigateurPartage = null; throw e; });
  }
  return navigateurPartage;
}
function prendrePlace() {
  if (bdcEnCours < BDC_EN_PARALLELE) { bdcEnCours += 1; return Promise.resolve(); }
  return new Promise((ok) => bdcEnAttente.push(ok));
}
function libererPlace() {
  const suivant = bdcEnAttente.shift();
  if (suivant) suivant(); else bdcEnCours -= 1;
  clearTimeout(minuterieFermeture);
  minuterieFermeture = setTimeout(async () => {
    if (bdcEnCours > 0 || !navigateurPartage) return;
    const p = navigateurPartage; navigateurPartage = null;
    try { (await p).close(); } catch (_) { /* déjà fermé */ }
  }, 60 * 1000);
  if (minuterieFermeture.unref) minuterieFermeture.unref();
}
async function renderBdcPdf(templateKey, fields = {}) {
  const html = compileBdcHtml(templateKey, fields);
  await prendrePlace();
  clearTimeout(minuterieFermeture);
  let page = null;
  try {
    try {
      page = await (await obtenirNavigateur()).newPage();
    } catch (e) {
      // Chromium mort entre deux BDC : on le relance une fois.
      console.warn(`[BDC] Chromium indisponible (${e.message}) — relance`);
      navigateurPartage = null;
      page = await (await obtenirNavigateur()).newPage();
    }
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  } finally {
    if (page) { try { await page.close(); } catch (_) { /* rien */ } }
    libererPlace();
  }
}

module.exports = { renderBdcPdf, renderBdcHtml, eur, TEMPLATES };
