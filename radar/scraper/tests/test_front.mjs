/* ============================================================================
   TESTS FRONT — index.html chargé pour de vrai dans jsdom
   ============================================================================
   Ce qui est vérifié ici :
     - le décodage base64 / int8 des vecteurs écrits par Python (le point de
       jonction le plus fragile entre le scraper et le navigateur)
     - la logique de fraîcheur (first_seen -> badges NEW, pastille, groupement)
     - la dégradation propre quand embeddings.json est absent ou corrompu

   Prérequis :  npm install jsdom
   Lancement :  node tests/test_front.mjs
   ============================================================================ */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");      // radar/scraper
const FRONTEND = join(ROOT, "..", "frontend");                          // radar/frontend
const HTML = readFileSync(join(FRONTEND, "index.html"), "utf8");

const PASS = [];
const FAIL = [];
const ok = (label, cond, detail = "") =>
  cond ? PASS.push(label) : FAIL.push(`${label}${detail ? "  — " + detail : ""}`);
const eq = (label, got, want) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? PASS.push(label)
    : FAIL.push(`${label}\n      attendu : ${JSON.stringify(want)}\n      obtenu  : ${JSON.stringify(got)}`);

/* index.html déclare DATA, EMB_MODE et state avec `let` : dans un script
   classique, ces liaisons vivent dans la portée lexicale globale et n'existent
   PAS comme propriétés de window. On y accède donc par eval, dans le realm de
   la page. (Les `function` de haut niveau, elles, sont bien sur window.) */
const V = (win, expr) => win.eval(expr);

const iso = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10);
};

/* ---------------------------------------------------------------------------
   Charge index.html dans jsdom en stubbant fetch() et l'import dynamique de
   transformers.js (pas de réseau pendant les tests).
   --------------------------------------------------------------------------- */
async function boot(files) {
  const vc = new VirtualConsole(); // on ne veut pas polluer la sortie des tests
  const logs = [];
  vc.on("error", (m) => logs.push(String(m)));
  vc.on("warn", (m) => logs.push(String(m)));
  vc.on("info", (m) => logs.push(String(m)));

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: "https://radar.local/",
    beforeParse(win) {
      win.fetch = (url) => {
        const key = String(url).split("/").pop();
        if (!(key in files)) return Promise.resolve({ ok: false, status: 404 });
        const body = files[key];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(typeof body === "string" ? JSON.parse(body) : body),
        });
      };
      // transformers.js est chargé par import() dynamique : on le neutralise
      win.eval("globalThis.__origImport = null;");
    },
  });

  // laisse tourner init() + loadEmbeddings()
  await new Promise((r) => setTimeout(r, 350));
  return { win: dom.window, logs };
}

/* ---------------------------------------------------------------------------
   Fabrique un embeddings.json avec le VRAI code Python, pour tester la vraie
   jonction Python -> JS plutôt qu'une reimplémentation du format.
   --------------------------------------------------------------------------- */
function pythonEmbeddings(urls, vectors) {
  const dir = mkdtempSync(join(tmpdir(), "radaremb-"));
  const payload = join(dir, "in.json");
  const out = join(dir, "embeddings.json");
  writeFileSync(payload, JSON.stringify({ urls, vectors }));
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scrape_openmedias import write_embeddings
blob = json.load(open(${JSON.stringify(payload)}))
records = [{"url": u} for u in blob["urls"]]
cache = dict(zip(blob["urls"], blob["vectors"]))
write_embeddings(${JSON.stringify(out)}, records, cache)
`;
  execFileSync("python3", ["-c", script], { stdio: "pipe" });
  return readFileSync(out, "utf8");
}

const catalogue = (rows) => JSON.stringify(rows);

const rec = (over = {}) => ({
  source: "Nous",
  media: "BFM Business",
  emission: "Focus Entreprises",
  title: "Une entreprise formidable qui fait des choses",
  date: "2026-07-01",
  url: "https://exemple.fr/a",
  thumb: "",
  sector: "Tech / IT / IA / Cyber",
  first_seen: "legacy",
  ...over,
});

/* =========================================================================
   1. DÉCODAGE DES VECTEURS — Python écrit, le navigateur relit
   ========================================================================= */
async function testEmbeddingsDecode() {
  const dim = 384;
  const urls = ["https://exemple.fr/a", "https://exemple.fr/b", "https://exemple.fr/c"];

  // vecteurs normalisés déterministes, avec des valeurs négatives (le piège :
  // charCodeAt renvoie 0..255, il faut repasser en signé)
  const vectors = urls.map((_, i) => {
    const v = Array.from({ length: dim }, (_, k) => Math.sin((k + 1) * (i + 1) * 0.37));
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });

  const embJson = pythonEmbeddings(urls, vectors);
  const blob = JSON.parse(embJson);
  ok("python : vecteurs négatifs présents dans le jeu de test",
     vectors.some((v) => v.some((x) => x < -0.01)));
  eq("python : count écrit", blob.count, 3);
  eq("python : quantification déclarée", blob.quant, "int8");

  const rows = urls.map((u, i) => rec({ url: u, title: `Episode numero ${i} de la serie` }));
  const { win } = await boot({ "catalogue.json": catalogue(rows), "embeddings.json": embJson });

  eq("front : catalogue chargé", V(win, "DATA.length"), 3);
  ok("front : vecteurs rattachés aux 3 entrées",
     V(win, "DATA").every((r) => r.emb && r.emb.length === dim),
     `emb=${V(win, "DATA").map((r) => (r.emb ? r.emb.length : null))}`);
  // jsdom n'a pas accès au CDN, donc l'encodeur de requête (transformers.js) ne
  // peut pas se charger. Sans encodeur, pas de recherche sémantique possible :
  // le bon comportement est de retomber en TF-IDF. C'est ce qu'on vérifie ici.
  ok("front : sans transformers.js, repli propre en TF-IDF",
     V(win, "EMB_MODE") === false);
  ok("front : badge signale le repli",
     win.document.getElementById("emb-badge").textContent.includes("TF-IDF"),
     win.document.getElementById("emb-badge").textContent);

  // fidélité de l'aller-retour
  let worst = 0;
  V(win, "DATA").forEach((r, i) => {
    for (let k = 0; k < dim; k++) worst = Math.max(worst, Math.abs(vectors[i][k] - r.emb[k]));
  });
  ok("front : erreur de quantification < 1/127", worst < 1 / 127, `max=${worst.toFixed(6)}`);

  // les valeurs négatives ont bien survécu (le bug classique donnerait des
  // valeurs positives autour de +1.9 au lieu de négatives)
  ok("front : signe des composantes préservé",
     V(win, "DATA").every((r) => Array.from(r.emb).some((x) => x < -0.01)));
  ok("front : aucune composante hors de [-1, 1]",
     V(win, "DATA").every((r) => Array.from(r.emb).every((x) => x >= -1.001 && x <= 1.001)));

  // le cosinus doit rester exploitable
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const attendu = dot(vectors[0], vectors[1]);
  const obtenu = win.dotProduct(Array.from(V(win, "DATA")[0].emb), V(win, "DATA")[1].emb);
  ok("front : cosinus préservé (dérive < 0.005)",
     Math.abs(attendu - obtenu) < 0.005,
     `attendu=${attendu.toFixed(5)} obtenu=${obtenu.toFixed(5)}`);

  const badge = win.document.getElementById("emb-badge");
  ok("front : badge sémantique révélé", badge.style.display === "inline-flex");
}

/* =========================================================================
   1bis. RECHERCHE SÉMANTIQUE — chemin complet, avec un encodeur simulé
   ------------------------------------------------------------------------
   En production, l'encodeur de requête vient de transformers.js (CDN). Ici on
   l'injecte à la main pour vérifier que searchSemantic exploite bien les
   vecteurs déquantifiés : c'est la brique qui n'a jamais tourné jusqu'ici,
   puisque le catalogue ne contenait aucun vecteur.
   ========================================================================= */
async function testSemanticSearch() {
  const dim = 64;
  const mk = (seed) => {
    const v = Array.from({ length: dim }, (_, k) => Math.sin((k + 1) * seed));
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const urls = ["https://x.fr/cible", "https://x.fr/proche", "https://x.fr/loin"];
  // "proche" = cible légèrement bruitée ; "loin" = vecteur sans rapport
  const cible = mk(0.31);
  const proche = cible.map((x, k) => x + (k % 7 === 0 ? 0.02 : 0));
  const nProche = Math.hypot(...proche);
  const vectors = [cible, proche.map((x) => x / nProche), mk(2.71)];

  const embJson = pythonEmbeddings(urls, vectors);
  const rows = [
    rec({ url: urls[0], title: "Le sujet exactement cible ici", first_seen: "legacy" }),
    rec({ url: urls[1], title: "Un sujet tres proche du premier", first_seen: "legacy" }),
    rec({ url: urls[2], title: "Un sujet totalement sans rapport", first_seen: "legacy" }),
  ];

  const { win } = await boot({ "catalogue.json": catalogue(rows), "embeddings.json": embJson });
  ok("sémantique : vecteurs bien chargés",
     V(win, "DATA").every((r) => r.emb && r.emb.length === dim));

  // on rebranche le mode sémantique avec un encodeur qui renvoie le vecteur cible
  V(win, `
    EMB_MODE = true;
    pipelineReady = true;
    encodeQuery = async () => ${JSON.stringify(cible)};
  `);

  const results = await V(win, 'search("peu importe, l encodeur est simule", "all")');
  ok("sémantique : au moins un résultat", results.length >= 1, `n=${results.length}`);
  eq("sémantique : la cible arrive première", results[0].r.url, urls[0]);
  ok("sémantique : la cible score très haut", results[0].score >= 80, `score=${results[0].score}`);
  if (results.length > 1) {
    ok("sémantique : le proche passe devant le hors-sujet",
       results.findIndex((o) => o.r.url === urls[1]) <
       (results.findIndex((o) => o.r.url === urls[2]) + 1 || Infinity));
  }
  ok("sémantique : le hors-sujet est filtré ou relégué",
     !results.slice(0, 1).some((o) => o.r.url === urls[2]));
}

/* =========================================================================
   2. DÉGRADATION PROPRE
   ========================================================================= */
async function testNoEmbeddings() {
  const { win } = await boot({ "catalogue.json": catalogue([rec()]) });
  eq("sans embeddings : catalogue quand même chargé", V(win, "DATA.length"), 1);
  ok("sans embeddings : mode sémantique désactivé", V(win, "EMB_MODE") === false);
  ok("sans embeddings : badge masqué",
     win.document.getElementById("emb-badge").style.display === "none");
  const grid = win.document.getElementById("grid-nous").innerHTML;
  ok("sans embeddings : la vue principale rend quand même", grid.includes("formidable"),
     grid.slice(0, 120));
}

async function testCorruptEmbeddings() {
  const bad = JSON.stringify({ dim: 384, urls: ["https://exemple.fr/a"], data: "AAAA" });
  const { win } = await boot({ "catalogue.json": catalogue([rec()]), "embeddings.json": bad });
  ok("embeddings corrompus : pas de plantage, retour TF-IDF", V(win, "EMB_MODE") === false);
  eq("embeddings corrompus : catalogue intact", V(win, "DATA.length"), 1);
}

async function testMismatchedEmbeddings() {
  // vecteurs pour des URLs qui ne sont pas dans le catalogue
  const embJson = pythonEmbeddings(
    ["https://autre.fr/x"],
    [Array.from({ length: 8 }, () => 0.3535)]
  );
  const { win } = await boot({ "catalogue.json": catalogue([rec()]), "embeddings.json": embJson });
  ok("embeddings d'un autre catalogue : ignorés proprement", V(win, "EMB_MODE") === false);
}

/* =========================================================================
   3. FRAÎCHEUR — badges, pastille, groupement
   ========================================================================= */
async function testFreshness() {
  const rows = [
    rec({ url: "https://x.fr/1", title: "Detecte aujourd hui meme absolument", first_seen: iso(0) }),
    rec({ url: "https://x.fr/2", title: "Detecte hier dans la journee entiere", first_seen: iso(1) }),
    rec({ url: "https://x.fr/3", title: "Detecte il y a trois jours pile", first_seen: iso(3) }),
    rec({ url: "https://x.fr/4", title: "Detecte il y a vingt jours pile", first_seen: iso(20) }),
    rec({ url: "https://x.fr/5", title: "Ancienne entree sans suivi aucun", first_seen: "legacy" }),
    rec({ url: "https://x.fr/6", title: "Concurrent detecte ce matin meme",
          first_seen: iso(0), source: "Concurrents" }),
  ];
  const { win } = await boot({ "catalogue.json": catalogue(rows) });

  eq("fraîcheur : daysSince(aujourd'hui)", win.daysSince(iso(0)), 0);
  eq("fraîcheur : daysSince(hier)", win.daysSince(iso(1)), 1);
  ok("fraîcheur : legacy = jamais nouveau", win.daysSince("legacy") === Infinity);
  ok("fraîcheur : date illisible = jamais nouveau", win.daysSince("n'importe quoi") === Infinity);
  ok("fraîcheur : vide = jamais nouveau", win.daysSince("") === Infinity);

  const news = rows.filter((r) => win.isNew(r)).length;
  eq("fraîcheur : 4 entrées dans la fenêtre de 7 jours", news, 4);

  // pastille du header
  const pill = win.document.getElementById("news-pill");
  eq("pastille : compte les nouveautés", pill.textContent, "4");
  ok("pastille : visible", pill.style.display === "inline-flex");
  ok("bouton : état has-new", win.document.getElementById("news-btn").classList.contains("has-new"));

  // badge NEW dans la vue principale
  const grid = win.document.getElementById("grid-nous").innerHTML;
  const badges = (grid.match(/tag-new/g) || []).length;
  eq("badge NEW : 3 cartes OpenMedias récentes sur 4 affichées", badges, 3);
  ok("badge NEW : absent de l'entrée legacy",
     !grid.split("Ancienne entree")[1]?.includes("tag-new"));

  // dernière mise à jour
  eq("footer : dernière détection = aujourd'hui", win.lastUpdate(), iso(0));
  ok("footer : date de MAJ affichée",
     win.document.getElementById("footer").innerHTML.includes("Mis à jour le"));
}

/* =========================================================================
   4. PANNEAU NOUVEAUTÉS
   ========================================================================= */
async function testNewsPanel() {
  const rows = [
    rec({ url: "https://x.fr/1", title: "Nous aujourd hui premier sujet", first_seen: iso(0) }),
    rec({ url: "https://x.fr/2", title: "Nous aujourd hui deuxieme sujet", first_seen: iso(0) }),
    rec({ url: "https://x.fr/3", title: "Concu hier un sujet interessant",
          first_seen: iso(1), source: "Concurrents" }),
    rec({ url: "https://x.fr/4", title: "Concu il y a quinze jours deja",
          first_seen: iso(15), source: "Concurrents" }),
    rec({ url: "https://x.fr/5", title: "Tres vieux sujet hors fenetre", first_seen: iso(200) }),
    rec({ url: "https://x.fr/6", title: "Entree legacy jamais dans le flux", first_seen: "legacy" }),
  ];
  const { win } = await boot({ "catalogue.json": catalogue(rows) });

  win.document.getElementById("news-btn").dispatchEvent(new win.Event("click"));
  ok("panneau : s'ouvre",
     win.document.getElementById("news-overlay").classList.contains("show"));

  const list = () => win.document.getElementById("news-list").innerHTML;
  eq("panneau : 4 items sur 30 jours par défaut",
     (list().match(/class="news-item/g) || []).length, 4);
  ok("panneau : l'entrée legacy est exclue", !list().includes("legacy jamais"));
  ok("panneau : le sujet hors fenêtre est exclu", !list().includes("Tres vieux"));
  ok("panneau : groupement par jour présent",
     list().includes("Aujourd'hui") && list().includes("Hier"));
  ok("panneau : ordre chronologique décroissant",
     list().indexOf("Aujourd'hui") < list().indexOf("Hier"));
  ok("panneau : sous-titre chiffre les deux camps",
     /2 chez nous/.test(win.document.getElementById("news-sub").innerHTML) &&
     /2 chez les concurrents/.test(win.document.getElementById("news-sub").innerHTML),
     win.document.getElementById("news-sub").textContent);

  // fenêtre 7 jours
  const w7 = win.document.querySelector('#news-window [data-days="7"]');
  w7.dispatchEvent(new win.Event("click", { bubbles: true }));
  eq("panneau : fenêtre 7 jours -> 3 items",
     (list().match(/class="news-item/g) || []).length, 3);
  ok("panneau : chip 7 jours active", w7.classList.contains("on"));

  // filtre source
  const bConcu = win.document.querySelector('#news-src [data-src="Concurrents"]');
  bConcu.dispatchEvent(new win.Event("click", { bubbles: true }));
  eq("panneau : filtre Concurrents sur 7 jours -> 1 item",
     (list().match(/class="news-item/g) || []).length, 1);
  ok("panneau : item marqué concu", list().includes('news-item concu'));

  const b90 = win.document.querySelector('#news-window [data-days="90"]');
  b90.dispatchEvent(new win.Event("click", { bubbles: true }));
  eq("panneau : Concurrents sur 90 jours -> 2 items",
     (list().match(/class="news-item/g) || []).length, 2);

  // fermeture
  win.document.getElementById("news-close").dispatchEvent(new win.Event("click"));
  ok("panneau : se ferme",
     !win.document.getElementById("news-overlay").classList.contains("show"));
}

async function testNewsEmpty() {
  const rows = [rec({ first_seen: "legacy" }), rec({ url: "https://x.fr/2", first_seen: iso(400) })];
  const { win } = await boot({ "catalogue.json": catalogue(rows) });
  const pill = win.document.getElementById("news-pill");
  ok("vide : pastille masquée", pill.style.display === "none");
  win.document.getElementById("news-btn").dispatchEvent(new win.Event("click"));
  ok("vide : message explicite",
     win.document.getElementById("news-list").innerHTML.includes("Rien de neuf"));
}

/* =========================================================================
   5. NON-RÉGRESSION — le vrai catalogue doit toujours s'afficher
   ========================================================================= */
async function testRealCatalogue() {
  let real;
  try {
    real = readFileSync(join(FRONTEND, "catalogue.json"), "utf8");
  } catch {
    FAIL.push("catalogue.json introuvable — test réel non joué");
    return;
  }
  const { win } = await boot({ "catalogue.json": real });
  const n = JSON.parse(real).length;
  eq("catalogue réel : entièrement chargé", V(win, "DATA.length"), n);
  ok("catalogue réel : chips secteurs construites",
     win.document.getElementById("chips").children.length > 5);
  ok("catalogue réel : chips médias construites",
     win.document.getElementById("media-chips").children.length > 1);
  ok("catalogue réel : cartes rendues",
     win.document.getElementById("grid-nous").innerHTML.includes("card-nous"));
  ok("catalogue réel : compteur du footer juste",
     win.document.getElementById("footer").innerHTML.includes(String(n)));

  // recherche TF-IDF sur un thème présent en base
  await V(win, '(async()=>{ state.q = "rénovation énergétique"; await run(); })()');
  const html = win.document.getElementById("grid-nous").innerHTML;
  ok("catalogue réel : la recherche TF-IDF renvoie des résultats",
     html.includes("card-nous"), html.slice(0, 160));
}

/* =========================================================================
   6. PARITÉ DE LA DA — radar/frontend vs client/src/styles.css
   ------------------------------------------------------------------------
   Le radar recopie les tokens du dashboard au lieu de les importer (c'est un
   HTML autonome, sans build ni bundler). Sans garde-fou, les deux fichiers
   divergent dès la première retouche de DA d'un seul côté — exactement ce que
   l'audit UX avait relevé entre dashboard et planning. Ce test échoue si une
   valeur partagée cesse de correspondre.
   ========================================================================= */
/* `selector` est un sélecteur CSS BRUT (ex: '[data-theme="light"]') — c'est
   cette fonction qui l'échappe. Ne pas passer une chaîne déjà échappée : le
   double échappement produit un motif qui ne matche rien, et les comparaisons
   de tokens deviennent alors des undefined === undefined qui passent en
   silence (piège rencontré en écrivant ce test). */
function cssBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(escaped + "\\s*\\{([\\s\\S]*?)\\n\\}"));
  if (!m) return {};
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}

async function testDesignTokenParity() {
  const dash = readFileSync(join(ROOT, "..", "..", "client", "src", "styles.css"), "utf8");
  const radar = HTML;

  // Tokens dont la valeur DOIT être identique dans les deux fichiers.
  // (--orange n'est volontairement pas dans la liste light : voir le commentaire
  // dans index.html — le radar en dérive --concu, utilisé comme couleur de
  // texte, qui doit être assombri en thème clair pour rester lisible.)
  const SHARED_DARK = [
    "--bg", "--panel", "--panel-2", "--border", "--border-soft",
    "--text", "--text-soft", "--text-muted",
    "--om-blue", "--om-blue-light", "--om-blue-lighter",
    "--orange", "--green", "--radius", "--radius-sm",
  ];
  const SHARED_LIGHT = [
    "--bg", "--panel", "--panel-2", "--border", "--border-soft",
    "--text", "--text-soft", "--text-muted", "--radius", "--radius-sm",
  ];

  const dDark = cssBlock(dash, ":root");
  const rDark = cssBlock(radar, ":root");
  const dLight = cssBlock(dash, '[data-theme="light"]');
  const rLight = cssBlock(radar, '[data-theme="light"]');

  ok("DA : bloc :root trouvé dans les deux fichiers",
     Object.keys(dDark).length > 5 && Object.keys(rDark).length > 5,
     `dashboard=${Object.keys(dDark).length} radar=${Object.keys(rDark).length}`);
  ok("DA : bloc light trouvé dans les deux fichiers",
     Object.keys(dLight).length > 5 && Object.keys(rLight).length > 5,
     `dashboard=${Object.keys(dLight).length} radar=${Object.keys(rLight).length}`);

  // On exige que le token soit RÉELLEMENT présent des deux côtés : sans ça, deux
  // absences se comparent égales et le test passe sans rien vérifier.
  for (const t of SHARED_DARK) {
    ok(`DA dark : ${t} défini des deux côtés`, dDark[t] !== undefined && rDark[t] !== undefined,
       `dashboard=${dDark[t]} radar=${rDark[t]}`);
    eq(`DA dark : ${t} identique`, rDark[t], dDark[t]);
  }
  for (const t of SHARED_LIGHT) {
    ok(`DA light : ${t} défini des deux côtés`, dLight[t] !== undefined && rLight[t] !== undefined,
       `dashboard=${dLight[t]} radar=${rLight[t]}`);
    eq(`DA light : ${t} identique`, rLight[t], dLight[t]);
  }

  // Polices : même déclaration de famille
  ok("DA : Sora en police d'affichage", /--font-display:\s*'Sora'/.test(radar));
  ok("DA : Inter en police de texte", /--font-body:\s*'Inter'/.test(radar));

  // Contrat de thème partagé entre les trois apps
  ok("DA : le radar lit la clé localStorage partagée 'theme'",
     /localStorage\.getItem\("theme"\)/.test(radar));
  ok("DA : le radar écrit la clé localStorage partagée 'theme'",
     /localStorage\.setItem\("theme", mode\)/.test(radar));
  ok("DA : défaut clair, comme dashboard et planning",
     /localStorage\.getItem\("theme"\)\s*\|\|\s*"light"/.test(radar));
}

async function testAppSwitch() {
  const { win } = await boot({ "catalogue.json": catalogue([rec()]) });
  const btns = [...win.document.querySelectorAll(".app-switch-btn")];
  eq("nav : 4 boutons (Dashboard, Planning, Radar, Paramètres)", btns.length, 4);
  ok("nav : Radar est l'onglet actif",
     btns.find((b) => b.classList.contains("active"))?.textContent.includes("Radar"));
  ok("nav : Paramètres masqué par défaut (admin uniquement)",
     btns.find((b) => b.classList.contains("admin-only"))?.style.display === "none");
  ok("nav : lien vers le dashboard", btns.some((b) => b.getAttribute("onclick") === "goApp('/')"));
  ok("nav : lien vers le planning",
     btns.some((b) => b.getAttribute("onclick") === "goApp('/planning')"));
  ok("nav : le mode démo masque la navigation",
     /\.demo-mode \.app-switch\{display:none!important\}/.test(HTML));
}

/* =========================================================================
   11. SCAN URL — l'analyse d'un site prospect doit ABOUTIR
   Régression : une ReferenceError (hostname utilisé avant son const) laissait
   l'UI bloquée sur "Analyse en cours…", bouton désactivé, sans jamais finir.
   ========================================================================= */
async function testScanUrl() {
  const prospectUrl = "https://www.beoffframe.com/";
  const apiKey = "page-text?url=" + encodeURIComponent(prospectUrl);
  const { win } = await boot({
    "catalogue.json": catalogue([rec({
      title: "Une marque mise en avant par une agence de publicité",
      sector: "Média / Communication / Culture / Luxe",
      url: "https://exemple.fr/pub",
    })]),
    [apiKey]: {
      title: "Be Off Frame — Agence de communication",
      text: "Be Off Frame est une agence de communication innovante. Nous accompagnons les marques dans leur stratégie de communication, publicité, branding et identité visuelle. frame frame frame.",
    },
  });

  await win.eval(`scanURL(${JSON.stringify(prospectUrl)})`);

  ok("scan URL : l'analyse aboutit (mots-clés affichés)",
     win.document.getElementById("scan-txt").textContent.includes("Mots-clés"));
  ok("scan URL : le bouton est réactivé à la fin",
     win.document.getElementById("scan-btn").disabled === false);
  const q = win.document.getElementById("q").value;
  ok("scan URL : le nom de l'entreprise est exclu des mots-clés", !q.includes("frame"));
  ok("scan URL : le métier ressort dans les mots-clés", q.includes("communication"));
  eq("scan URL : secteur auto = Média/Communication (pas Immobilier)",
     win.eval("state.sector"), "Média / Communication / Culture / Luxe");
}

/* =========================================================================
   RUNNER
   ========================================================================= */
const tests = [
  testEmbeddingsDecode,
  testSemanticSearch,
  testNoEmbeddings,
  testCorruptEmbeddings,
  testMismatchedEmbeddings,
  testFreshness,
  testNewsPanel,
  testNewsEmpty,
  testDesignTokenParity,
  testAppSwitch,
  testRealCatalogue,
  testScanUrl,
];

for (const t of tests) {
  try {
    await t();
  } catch (e) {
    FAIL.push(`${t.name} a levé ${e.name}: ${e.message}\n${(e.stack || "").split("\n").slice(1, 4).join("\n")}`);
  }
}

console.log(`\n${"=".repeat(74)}`);
console.log(`  ${PASS.length} OK   ·   ${FAIL.length} ECHEC`);
console.log("=".repeat(74));
if (FAIL.length) {
  FAIL.forEach((f) => console.log(`\n  ECHEC  ${f}`));
  process.exit(1);
}
console.log("  Tout est vert.");
