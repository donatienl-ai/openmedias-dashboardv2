/* ============================================================================
   TESTS — sélecteur de mois unique du planning
   ============================================================================
   Le header (.month-nav) est le seul sélecteur de mois de l'app : il pilote
   soit le calendrier des diffusions, soit le rétroplanning réseaux sociaux,
   selon la vue affichée. Les deux calendriers gardent en revanche leur propre
   mois, pour que la navigation dans le rétroplanning ne fasse pas dépasser
   l'horizon de visibilité du planning de diffusion.

   Prérequis :  npm install   (jsdom en devDependency)
   Lancement :  npm run test:planning
   ============================================================================ */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, "..", "index.html"), "utf8");

const PASS = [];
const FAIL = [];
const ok = (label, cond, detail = "") =>
  cond ? PASS.push(label) : FAIL.push(`${label}${detail ? "  — " + detail : ""}`);
const eq = (label, got, want) =>
  got === want ? PASS.push(label)
    : FAIL.push(`${label}\n      attendu : ${JSON.stringify(want)}\n      obtenu  : ${JSON.stringify(got)}`);

const META = {
  medias: ["TIME", "Capital"],
  slots: { TIME: 1, Capital: 1 },
  formats: { TIME: ["Interview"], Capital: ["Interview"] },
  horizonMois: 3,
  sousMediasSpecialises: [],
  sousMediasListe: [],
  channels: ["Instagram", "LinkedIn", "YouTube", "Newsletter"],
  socialPostStatuses: ["a_faire", "pret", "publie"],
};

/* Le rétroplanning doit contenir des posts sur DEUX mois différents, sinon on
   ne verrait pas la navigation agir. */
const SOCIAL_POSTS = [
  { id: 1, channel: "Instagram", title: "Post de juillet", notes: "", scheduled_date: "2026-07-15", status: "a_faire", assigned_to: "", drive_link: "", image_data: null },
  { id: 2, channel: "LinkedIn", title: "Post d'aout", notes: "", scheduled_date: "2026-08-12", status: "pret", assigned_to: "", drive_link: "", image_data: null },
];

function stubFetch(win) {
  win.fetch = (url) => {
    const u = String(url);
    let body = [];
    if (u.includes("/meta")) body = META;
    else if (u.includes("/social-posts")) body = SOCIAL_POSTS;
    else if (u.includes("/social-team")) body = [];
    // certains endpoints renvoient un objet, pas un tableau
    else if (u.includes("a-programmer")) body = { assignees: [], nonAssignees: [] };
    else body = [];   // emissions, slots, jours-bloques...
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
}

async function boot() {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  vc.on("error", (m) => errors.push(String(m)));

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    // ?pin=1 : sans session en localStorage, bootstrapLogin() redirige vers "/"
    // (comportement normal en prod), ce que jsdom signale en "Not implemented:
    // navigation". Le paramètre pin fait rester sur l'écran de connexion, qu'on
    // court-circuite ensuite via activateSession().
    url: "https://openmedias.local/planning/?pin=1",
    beforeParse: stubFetch,
  });
  const win = dom.window;
  await new Promise((r) => setTimeout(r, 120));

  // Boot en rôle communication : il a accès au planning ET au rétroplanning,
  // sans déclencher le bloc `role==='edit'` d'init() (bannière semaine, à
  // programmer, alertes retard...) qui demanderait de simuler une dizaine
  // d'endpoints de plus sans rien apporter au test du sélecteur de mois.
  // Les tests qui ont besoin d'un autre rôle le réaffectent ensuite.
  await win.eval(`(async () => {
    activateSession({ role: 'com', nom: 'Test', clevel: false, accountRole: 'communication' });
    await init();
  })()`);
  await new Promise((r) => setTimeout(r, 120));
  return { win, errors };
}

const label = (win) => win.document.getElementById("month-label").textContent.trim();
const navVisible = (win) => win.document.getElementById("month-nav").style.display !== "none";
const V = (win, expr) => win.eval(expr);

/* =========================================================================
   1. PLUS QU'UNE SEULE NAVIGATION DE MOIS DANS LE DOM
   ========================================================================= */
async function testSingleControl() {
  const { win, errors } = await boot();
  ok("boot : aucune erreur JS au chargement", errors.length === 0, errors.slice(0, 2).join(" | "));

  eq("un seul bloc .month-nav", win.document.querySelectorAll(".month-nav").length, 1);
  eq("plus de .social-cal-header", win.document.querySelectorAll(".social-cal-header").length, 0);
  eq("plus de #social-cal-title", win.document.querySelectorAll("#social-cal-title").length, 0);
  ok("socialCalendarNav() supprimée",
     V(win, "typeof socialCalendarNav") === "undefined",
     `typeof=${V(win, "typeof socialCalendarNav")}`);
  // On cible l'ATTRIBUT onclick, pas la simple occurrence du nom : le code
  // garde une mention de socialCalendarNav en commentaire, pour signaler qu'une
  // réapparition serait une régression.
  ok("plus aucun bouton câblé sur socialCalendarNav",
     !/onclick\s*=\s*"socialCalendarNav\(/.test(HTML));

  // la grille du rétroplanning est toujours là, elle
  ok("la grille du rétroplanning existe toujours",
     !!win.document.getElementById("social-cal-grid"));
  eq("les jours de semaine du rétroplanning sont conservés",
     win.document.querySelectorAll(".social-cal-weekdays span").length, 7);
}

/* =========================================================================
   2. LE HEADER PILOTE LE CALENDRIER AFFICHÉ
   ========================================================================= */
async function testHeaderDrivesActiveCalendar() {
  const { win } = await boot();

  // --- vue Calendrier (diffusions) ---
  const planningStart = label(win);
  ok("calendrier : le libellé du header est renseigné", planningStart.length > 4, planningStart);
  await V(win, "changeMonth(1)");
  const planningNext = label(win);
  ok("calendrier : le header fait avancer le mois des diffusions",
     planningNext !== planningStart, `${planningStart} -> ${planningNext}`);

  // --- vue Réseaux sociaux ---
  V(win, "switchView('social')");
  await new Promise((r) => setTimeout(r, 60));
  const socialStart = label(win);
  ok("social : le libellé bascule sur le mois du rétroplanning",
     socialStart !== planningNext, `diffusions=${planningNext} social=${socialStart}`);

  const gridBefore = win.document.getElementById("social-cal-grid").innerHTML;
  await V(win, "changeMonth(1)");
  const socialNext = label(win);
  const gridAfter = win.document.getElementById("social-cal-grid").innerHTML;
  ok("social : le header fait avancer le mois du rétroplanning",
     socialNext !== socialStart, `${socialStart} -> ${socialNext}`);
  ok("social : la grille est bien re-rendue", gridAfter !== gridBefore);

  // le post de juillet ne doit plus être visible en août, celui d'août oui.
  // Date épinglée : ce contrôle comparait "le mois prochain" aux deux seuls
  // posts du jeu de test (juillet/août 2026) — il cassait donc tout seul dès
  // septembre. On force août 2026, mois qui contient un post, point.
  V(win, "switchView('social')");
  await new Promise((r) => setTimeout(r, 60));
  V(win, "socialCalendarDate = new Date(2026, 7, 1)");
  V(win, "renderSocialCalendar()");
  ok("social : le mois affiché contient bien les posts du mois",
     win.document.getElementById("social-cal-grid").innerHTML.includes("Post d'aout"));

  // --- indépendance des deux états ---
  V(win, "switchView('calendar')");
  await new Promise((r) => setTimeout(r, 60));
  eq("indépendance : le mois des diffusions n'a pas bougé pendant la navigation sociale",
     label(win), planningNext);
}

/* =========================================================================
   3. LE RÉTROPLANNING N'EST PAS LIMITÉ PAR L'HORIZON DES DIFFUSIONS
   ========================================================================= */
async function testHorizonNotAppliedToSocial() {
  const { win } = await boot();
  // rôle communication : soumis à l'horizon sur les diffusions
  V(win, "role='com'");

  V(win, "switchView('calendar')");
  const start = label(win);
  for (let i = 0; i < 8; i++) await V(win, "changeMonth(1)");
  const blocked = label(win);
  ok("diffusions : l'horizon bloque bien la projection pour un compte communication",
     blocked !== start, `${start} -> ${blocked}`);
  const monthsMoved = V(win, "currentDate.getMonth()") - new Date().getMonth();
  ok("diffusions : pas plus de 3 mois d'avance (horizon)",
     Math.abs(monthsMoved) <= 4, `mois parcourus=${monthsMoved}`);

  V(win, "switchView('social')");
  await new Promise((r) => setTimeout(r, 60));
  const socialStart = V(win, "socialCalendarDate.getTime()");
  for (let i = 0; i < 8; i++) await V(win, "changeMonth(1)");
  const socialEnd = V(win, "socialCalendarDate.getTime()");
  const socialMonths = Math.round((socialEnd - socialStart) / (30.44 * 86400000));
  ok("social : les 8 mois d'avance sont bien parcourus (aucun horizon)",
     socialMonths >= 7, `mois parcourus=${socialMonths}`);
}

/* =========================================================================
   4. AUCUN MOIS SAUTÉ — le bug du 29/30/31
   ------------------------------------------------------------------------
   currentDate.setMonth(getMonth()+1) sur un 29 janvier donnait un 29 février
   inexistant, que JS reporte au 1er mars : février disparaissait purement de
   la navigation. Reproduit ici sur une année non bissextile.
   ========================================================================= */
async function testNoMonthSkipped() {
  const { win } = await boot();
  V(win, "role='edit'");                       // pas d'horizon
  V(win, "switchView('calendar')");
  V(win, "currentDate = new Date(2027, 0, 29)"); // 29 janvier 2027 (non bissextile)

  await V(win, "changeMonth(1)");
  eq("diffusions : 29 janvier + 1 mois -> février (pas mars)",
     V(win, "currentDate.getMonth()"), 1);
  eq("diffusions : normalisé au 1er du mois", V(win, "currentDate.getDate()"), 1);
  eq("diffusions : libellé cohérent", label(win), "Février 2027");

  await V(win, "changeMonth(1)");
  eq("diffusions : puis mars", V(win, "currentDate.getMonth()"), 2);

  // 12 pas en arrière depuis mars 2027 doivent ramener exactement à mars 2026
  for (let i = 0; i < 12; i++) await V(win, "changeMonth(-1)");
  eq("diffusions : 12 mois en arrière -> même mois, année -1",
     V(win, "currentDate.getMonth()"), 2);
  eq("diffusions : année décrémentée une seule fois",
     V(win, "currentDate.getFullYear()"), 2026);

  // même contrôle côté rétroplanning
  V(win, "switchView('social')");
  await new Promise((r) => setTimeout(r, 60));
  V(win, "socialCalendarDate = new Date(2027, 0, 31)");
  await V(win, "changeMonth(1)");
  eq("social : 31 janvier + 1 mois -> février", V(win, "socialCalendarDate.getMonth()"), 1);
}

/* =========================================================================
   5. LE SÉLECTEUR DISPARAÎT LÀ OÙ IL N'A PAS DE SENS
   ========================================================================= */
async function testNavVisibility() {
  const { win } = await boot();

  V(win, "switchView('calendar')");
  ok("visible sur le calendrier des diffusions", navVisible(win));

  V(win, "switchView('list')");
  ok("visible sur la liste des diffusions (elle est mensuelle)", navVisible(win));

  V(win, "switchView('social')");
  await new Promise((r) => setTimeout(r, 60));
  ok("visible sur le calendrier du rétroplanning", navVisible(win));

  V(win, "switchSocialSubview('list')");
  ok("masqué sur la liste du rétroplanning (elle n'est pas mensuelle)", !navVisible(win));

  V(win, "switchSocialSubview('calendar')");
  ok("réaffiché en revenant au calendrier du rétroplanning", navVisible(win));

  V(win, "switchView('calendar')");
  ok("réaffiché en quittant le rétroplanning", navVisible(win));
}

/* =========================================================================
   6. ZOOM FAÇON GOOGLE AGENDA — Mois / Semaine / 3 jours / Journée
   ------------------------------------------------------------------------
   Le zoom ne change que l'échelle : la grille passe de 7 colonnes mensuelles
   à 7 jours / 3 jours / 1 jour, le libellé du header épouse la période
   visible, et les flèches du header avancent du pas correspondant.
   ========================================================================= */
async function testSocialZoom() {
  const { win } = await boot();
  V(win, "switchView('social')");
  await new Promise((r) => setTimeout(r, 60));
  const grid = () => win.document.getElementById("social-cal-grid");

  eq("zoom par défaut : mois", V(win, "socialZoom"), "mois");
  ok("zoom mois : grille non zoomée", !grid().className.includes("zoomed"), grid().className);

  // -- Semaine : 7 cases, semaine du lundi, libellé de plage --
  // (janvier 2027 est choisi : ce n'est jamais le mois courant, donc pas de
  // ré-ancrage sur aujourd'hui au moment du changement de zoom)
  V(win, "socialCalendarDate = new Date(2027, 0, 14)"); // jeudi 14 janvier 2027
  V(win, "setSocialZoom('semaine')");
  eq("semaine : état du zoom", V(win, "socialZoom"), "semaine");
  eq("semaine : 7 cases", grid().children.length, 7);
  ok("semaine : grille zoomée", grid().className.includes("zoomed"), grid().className);
  eq("semaine : 7 en-têtes de jours",
     win.document.querySelectorAll(".social-cal-weekdays span").length, 7);
  eq("semaine : libellé = plage lundi-dimanche", label(win), "11 – 17 Janvier 2027");

  // -- les flèches du header avancent d'une semaine --
  await V(win, "changeMonth(1)");
  eq("semaine : +1 flèche = +7 jours", V(win, "socialCalendarDate.getDate()"), 21);
  eq("semaine : libellé suit", label(win), "18 – 24 Janvier 2027");

  // -- 3 jours : 3 cases, flèches = 3 jours --
  V(win, "setSocialZoom('3jours')");
  eq("3 jours : 3 cases", grid().children.length, 3);
  eq("3 jours : libellé", label(win), "21 – 23 Janvier 2027");
  await V(win, "changeMonth(-1)");
  eq("3 jours : -1 flèche = -3 jours", V(win, "socialCalendarDate.getDate()"), 18);
  eq("3 jours : libellé suit", label(win), "18 – 20 Janvier 2027");

  // -- Journée : 1 case, flèches = 1 jour --
  V(win, "setSocialZoom('jour')");
  eq("journée : 1 case", grid().children.length, 1);
  eq("journée : libellé jour complet", label(win), "Lundi 18 Janvier 2027");
  await V(win, "changeMonth(1)");
  eq("journée : +1 flèche = +1 jour", V(win, "socialCalendarDate.getDate()"), 19);

  // -- retour au mois : normalisé au 1er, grille classique --
  V(win, "setSocialZoom('mois')");
  eq("mois : date renormalisée au 1er", V(win, "socialCalendarDate.getDate()"), 1);
  eq("mois : libellé classique", label(win), "Janvier 2027");
  ok("mois : grille non zoomée", !grid().className.includes("zoomed"), grid().className);

  // -- ré-ancrage : quitter le mois courant cible aujourd'hui --
  const now = new Date();
  V(win, `socialCalendarDate = new Date(${now.getFullYear()}, ${now.getMonth()}, 1)`);
  V(win, "setSocialZoom('jour')");
  eq("mois courant -> journée : ancré sur aujourd'hui",
     V(win, "socialCalendarDate.getDate()"), now.getDate());

  // -- persistance du choix --
  eq("zoom mémorisé en localStorage",
     win.localStorage.getItem("social-zoom"), "jour");
}

/* =========================================================================
   RUNNER
   ========================================================================= */
const tests = [
  testSingleControl,
  testHeaderDrivesActiveCalendar,
  testHorizonNotAppliedToSocial,
  testNoMonthSkipped,
  testNavVisibility,
  testSocialZoom,
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
