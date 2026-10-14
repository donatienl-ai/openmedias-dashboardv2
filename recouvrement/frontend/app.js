const API = 'api'; // relatif : résout vers /recouvrement/api/... une fois servi sous /recouvrement/

// ── SESSION / LOGIN ──────────────────────────────────────────────────────────
// Réutilise le même système de comptes que le planning et le dashboard
// (commercial_users, mêmes clés localStorage commercialId/commercialNom) —
// pas de second système d'auth à maintenir, et la SSO entre les 3 apps
// continue de fonctionner (login une seule fois, quel que soit le point
// d'entrée).
let commercialId = localStorage.getItem('commercialId') || null;
let commercialNom = localStorage.getItem('commercialNom') || '';
let meta = {};
let isAccountAdmin = false;

// Seuls finance et admin ont leur place ici. Un autre rôle est renvoyé vers
// sa vraie page d'accueil — même logique (inversée) que /planning et le
// dashboard React, qui renvoient déjà 'finance' vers /recouvrement.
function redirectAwayIfNotAllowed(accountRole,accountRoles){
  // Rôles multiples (09/2026) : il suffit d'avoir finance ou admin parmi ses rôles.
  const rs=Array.isArray(accountRoles)&&accountRoles.length?accountRoles:[accountRole];
  if(rs.includes('admin')||rs.includes('finance'))return false;
if(accountRole==='edito'||accountRole==='communication'){ window.location.href='/planning'; return true; }
window.location.href='/';
return true;
}
function activateSession(d){
isAccountAdmin = d.accountRole==='admin'||(d.accountRoles||[]).includes('admin');
commercialId=d.commercial_id;
commercialNom=d.nom||'';
localStorage.setItem('commercialId',commercialId);
localStorage.setItem('commercialNom',commercialNom);
document.getElementById('pin-screen').style.display='none';
document.getElementById('app').style.display='flex';
document.getElementById('role-badge').textContent = isAccountAdmin?'Admin':'Finance';
document.getElementById('role-badge').className = `role-badge ${isAccountAdmin?'admin':'finance'}`;
init();
}
// SSO : si un commercialId existe déjà (arrivée depuis le planning ou le
// dashboard, ou onglet précédent), on retente une session silencieuse via
// /api/auth/me plutôt que de redemander les identifiants.
async function tryAutoLogin(){
if(!commercialId)return false;
try{
const r=await fetch(`${API}/auth/me`,{headers:{'x-commercial-id':commercialId}});
if(!r.ok)throw new Error('session invalide');
const d=await r.json();
if(redirectAwayIfNotAllowed(d.accountRole,d.accountRoles))return true;
activateSession(d);
return true;
}catch{
// Compte supprimé/désactivé depuis, ou rôle non autorisé ici : on nettoie
// pour retomber proprement sur l'écran de connexion.
localStorage.removeItem('commercialId');
localStorage.removeItem('commercialNom');
commercialId=null;
commercialNom='';
return false;
}
}
async function commercialLoginSubmit(){
const email=document.getElementById('commercial-email').value.trim();
const password=document.getElementById('commercial-password').value;
const errEl=document.getElementById('commercial-login-error');
if(!email||!password){errEl.textContent='Email et mot de passe requis.';return;}
try{
const r=await fetch(`${API}/auth/commercial`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
const d=await r.json();
if(r.ok){
if(redirectAwayIfNotAllowed(d.accountRole,d.accountRoles))return;
activateSession(d);
}else{
errEl.textContent=d.error||'Email ou mot de passe incorrect.';
}
}catch{errEl.textContent='Erreur réseau.';}
}
function showForgotPassword(event){
if(event)event.preventDefault();
document.getElementById('pin-card-commercial').style.display='none';
document.getElementById('pin-card-forgot').style.display='';
document.getElementById('forgot-error').textContent='';
document.getElementById('forgot-success').style.display='none';
document.getElementById('forgot-email').value='';
document.getElementById('forgot-email').focus();
}
function hideForgotPassword(event){
if(event)event.preventDefault();
document.getElementById('pin-card-forgot').style.display='none';
document.getElementById('pin-card-commercial').style.display='';
}
async function forgotPasswordSubmit(){
const email=document.getElementById('forgot-email').value.trim();
const errEl=document.getElementById('forgot-error');
const okEl=document.getElementById('forgot-success');
errEl.textContent='';okEl.style.display='none';
if(!email){errEl.textContent='Email requis.';return;}
try{
await fetch(`${API}/auth/forgot-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
okEl.textContent="Si ce compte existe, un email avec un lien de réinitialisation vient d'être envoyé.";
okEl.style.display='';
}catch{errEl.textContent='Erreur réseau.';}
}
function logout(){
localStorage.removeItem('commercialId');
localStorage.removeItem('commercialNom');
commercialId=null;
commercialNom='';
document.getElementById('app').style.display='none';
document.getElementById('pin-screen').style.display='flex';
document.getElementById('pin-card-commercial').style.display='';
document.getElementById('pin-card-forgot').style.display='none';
document.getElementById('pin-card-refused').style.display='none';
document.getElementById('commercial-email').value='';
document.getElementById('commercial-password').value='';
}

// ── THEME (même clé localStorage 'theme' que /planning et le dashboard) ─────
if(localStorage.getItem('theme')==='dark'){
document.documentElement.setAttribute('data-theme','dark');
}
function toggleTheme(){
const dark=document.documentElement.getAttribute('data-theme')==='dark';
if(dark){document.documentElement.removeAttribute('data-theme');document.getElementById('theme-btn').textContent='☀️';localStorage.setItem('theme','light');}
else{document.documentElement.setAttribute('data-theme','dark');document.getElementById('theme-btn').textContent='🌙';localStorage.setItem('theme','dark');}
}
if(localStorage.getItem('theme')==='dark'&&document.getElementById('theme-btn'))document.getElementById('theme-btn').textContent='🌙';

// ── HELPERS PARTAGÉS (mêmes qu'ailleurs dans l'app, copiés ici pour que cette
// page reste autonome sans dépendre du reste du planning) ─────────────────
function closeModal(event){if(event&&event.target!==document.getElementById('modal-overlay'))return;document.getElementById('modal-overlay').style.display='none';}
function showToast(msg,type='success'){const el=document.createElement('div');el.className=`toast ${type}`;el.innerHTML=`<span>${type==='success'?'✅':'⚠️'}</span><span>${msg}</span>`;document.body.appendChild(el);setTimeout(()=>el.remove(),4000);}
function formatDateFR(str){if(!str)return '—';const[y,m,d]=str.split('-');return `${d}/${m}/${y}`;}
// Centimes affichés et pris en compte (demande Lina 24/09/2026) — avant,
// maximumFractionDigits:0 arrondissait tout à l'euro près à l'affichage
// (les montants stockés/calculés, eux, gardaient déjà les centimes partout,
// aussi bien côté Pennylane que sur les échéances locales — seul l'AFFICHAGE
// les cachait).
function fmtCA(v){return new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',minimumFractionDigits:2,maximumFractionDigits:2}).format(v||0);}
function fmtCACompact(v){ v=v||0; if(Math.abs(v)<10000)return fmtCA(v); return new Intl.NumberFormat('fr-FR',{notation:'compact',style:'currency',currency:'EUR',minimumFractionDigits:0,maximumFractionDigits:1}).format(v); }
// Lecture explicite en UTC d'un timestamp SQLite ("YYYY-MM-DD HH:MM:SS", écrit
// par datetime('now'), donc sans indicateur de fuseau) : new Date(str) tout
// seul l'interprète comme une heure LOCALE, ce qui décale l'affichage de
// l'offset UTC (2h en été/CEST, 1h en hiver/CET) — bug corrigé le 09/2026,
// voir financeCommentsListHtml ci-dessous.
function parseSqliteUtc(str){ if(!str)return null; const d=new Date(String(str).replace(' ','T')+'Z'); return Number.isNaN(d.getTime())?null:d; }

// Statuts d'échéance personnalisables (Paramètres > Recouvrement) — chargés
// une fois au démarrage, indexés par id pour un accès O(1) depuis les
// colonnes Éch. 2/3/4 et les pastilles de statut ci-dessous.
let financeInstallmentStatuses=[];
let financeInstallmentStatusById={};

// ── Pastille de statut cliquable (remplace le <select> natif) ───────────────
// Un <select>/<option> natif ne peut pas afficher la couleur choisie dans
// Paramètres (la plupart des navigateurs ignorent tout style sur <option>),
// ce qui rendait la personnalisation invisible à l'usage. Ce petit composant
// maison affiche la couleur en permanence (pastille + libellé) et ouvre au
// clic une liste d'options elles-mêmes colorées — remplace le select partout
// où un statut d'échéance se choisit (fiche détail, ajout, ajout rapide).
let financeStatusPillCallbacks={};
let financeStatusPillSeq=0;
// "Sans statut" a été retiré des options proposées (09/2026, demande Lina) :
// une échéance a désormais toujours un vrai statut, "Douteux" par défaut
// (voir planning/backend/db.js et financeRoutes.js, defaultInstallmentStatusId)
// — ce composant ne propose donc plus jamais l'option vide.
function financeStatusPillContentHtml(id,statusId){
const cur=statusId!=null?financeInstallmentStatusById[statusId]:null;
const opts=financeInstallmentStatuses.map(s=>`<button type="button" class="finance-status-picker-opt" onclick="selectFinanceStatusPill('${id}',${s.id})"><span class="finance-status-pill-dot" style="background:${s.color}"></span>${s.label}</button>`).join('');
return `<button type="button" class="finance-status-pill" onclick="toggleFinanceStatusPicker('${id}',event)">
<span class="finance-status-pill-dot" style="background:${cur?cur.color:'var(--text-muted)'}"></span>${cur?cur.label:'—'}<span class="finance-status-pill-caret">▾</span>
</button>
<div class="finance-status-picker" style="display:none">${opts}</div>`;
}
// onSelect(statusId) est appelé après la mise à jour visuelle de la pastille —
// à l'appelant de décider quoi en faire (PATCH immédiat sur une échéance
// existante, ou simple mémorisation pour un formulaire d'ajout pas encore
// soumis).
function financeStatusPillHtml(statusId,onSelect){
const id='fsp'+(++financeStatusPillSeq);
financeStatusPillCallbacks[id]=onSelect;
return `<div class="finance-status-pill-wrap" id="${id}">${financeStatusPillContentHtml(id,statusId)}</div>`;
}
function toggleFinanceStatusPicker(id,event){
event.stopPropagation();
const wrap=document.getElementById(id);
if(!wrap)return;
const picker=wrap.querySelector('.finance-status-picker');
const willOpen=picker.style.display==='none';
closeFinanceStatusPickers();
if(willOpen)picker.style.display='';
}
function closeFinanceStatusPickers(){
document.querySelectorAll('.finance-status-picker').forEach(p=>p.style.display='none');
}
function selectFinanceStatusPill(id,statusId){
const wrap=document.getElementById(id);
if(!wrap)return;
wrap.innerHTML=financeStatusPillContentHtml(id,statusId);
closeFinanceStatusPickers();
const cb=financeStatusPillCallbacks[id];
if(cb)cb(statusId);
}
// Ferme picker de statut ET popover d'ajout rapide (cf. plus bas) au clic en
// dehors, ou à l'échap — deux popovers indépendants mais même réflexe de
// fermeture, donc un seul jeu d'écouteurs globaux pour les deux.
document.addEventListener('click',(e)=>{
if(!e.target.closest('.finance-status-pill-wrap'))closeFinanceStatusPickers();
if(!e.target.closest('#finance-quickadd-popover')&&!e.target.closest('.finance-installment-add-btn'))closeFinanceInstallmentQuickAdd();
});
document.addEventListener('keydown',(e)=>{
if(e.key==='Escape'){closeFinanceStatusPickers();closeFinanceInstallmentQuickAdd();}
});

async function init(){
meta=await fetch(`${API}/meta`).then(r=>r.json());
financeInstallmentStatuses=await fetch(`${API}/finance/installment-statuses`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]);
financeInstallmentStatusById=Object.fromEntries(financeInstallmentStatuses.map(s=>[s.id,s]));
await loadFinance();
}

// ── RECOUVREMENT (Pennylane) ─────────────────────────────────────────────────
// Pennylane reste la source de vérité facturation (l'app n'y écrit jamais) ;
// cette vue ajoute le suivi de recouvrement par-dessus (statut, historique de
// relances, KPI, commentaires, échéances personnalisées) — remplace l'Excel +
// Trello utilisés jusque-là.
// "En cours" est affiché "Relancé" depuis 09/2026 (demande Lina — ce mot
// parle plus à l'équipe compta) : c'est un renommage d'AFFICHAGE pur, la clé
// technique en_cours ne change pas (base de données, API, filtres, mail
// quotidien) — voir planning/backend/db.js, FINANCE_INTERNAL_STATUSES.
const FINANCE_STATUS_LABEL={a_relancer:'À relancer',en_cours:'Relancé',douteux:'Douteux',litige:'Litige',promesse_paiement:'Promesse de paiement',solde:'Soldée'};
const FINANCE_STATUS_COLOR={a_relancer:'var(--gold)',en_cours:'var(--accent)',douteux:'#f97316',litige:'#dc2626',promesse_paiement:'#0d9488',solde:'var(--green)'};
const FINANCE_CANAL_LABEL={email:'📧 Email',telephone:'📞 Téléphone',courrier:'✉️ Courrier',sms:'💬 SMS',autre:'Autre'};
let financeInvoicesCache=[];
let financeSelectedInvoiceId=null; // facture ouverte dans le modal de détail
let financeCommentsCache=[]; // commentaires de la facture ouverte dans le modal (pour l'édition inline, cf. financeCommentsListHtml)
let financeNewInstallmentStatusId=null; // statut choisi dans le formulaire "nouvelle échéance" de la fiche
// Filtre actif de la barre d'onglets (façon Pennylane : Toutes/À venir/En
// retard/Encaissée/…) — remplace l'ancien select de statut + case "en retard
// uniquement" par des chips cliquables avec compteur en direct. Multi-sélection :
// plusieurs chips peuvent être actifs à la fois (ex. "À venir" + "En retard"),
// une facture matche dès qu'elle correspond à AU MOINS un des chips actifs.
// "Toutes" est exclusif — le sélectionner désactive tout le reste, et
// désélectionner le dernier chip actif retombe automatiquement sur "Toutes"
// plutôt que de laisser le tableau vide sans filtre visible.
let financeActiveFilters=new Set(['all']);
// Tri du tableau (colonne cliquée + sens) — les en-têtes du tableau n'étaient
// pas triables ici alors que d'autres tableaux de l'app le sont déjà
// (.sortable-th), gênant sur un métier de relance où trier par échéance ou
// montant restant dû est souvent le premier réflexe (relevé dans l'audit UX).
let financeSortKey=null; // 'deadline' | 'retard' | 'montant' | 'priority' | null
let financeSortDir=1; // 1 = croissant, -1 = décroissant
// Direction par défaut au premier clic sur une colonne — pour "priorité", ça
// n'aurait aucun sens de démarrer croissant (le pire cas tout en bas) : on
// veut le plus urgent en premier, donc décroissant par défaut sur ce tri-là.
const FINANCE_SORT_DEFAULT_DIR={priority:-1};
function setFinanceSort(key){
if(financeSortKey===key)financeSortDir=-financeSortDir;
else{financeSortKey=key;financeSortDir=FINANCE_SORT_DEFAULT_DIR[key]||1;}
renderFinanceInvoices();
}
function financeSortArrow(key){
if(financeSortKey!==key)return '';
return `<span class="sort-arrow">${financeSortDir===1?'▲':'▼'}</span>`;
}

// Filtre de période : calendrier personnalisable (Du/Au), sur la date
// d'ÉCHÉANCE de la facture — remplace l'ancien système à granularités fixes
// (Semaine/Mois/Année) par une plage de dates libre. Aucune borne posée (par
// défaut) ne restreint rien : ce filtre est purement un affichage par-dessus
// les données déjà synchronisées, il ne touche jamais à la synchro elle-même
// (on a explicitement retiré tout filtre de date de syncFinance() pour éviter
// que des factures sortent du champ suivi et se figent). Les KPI (cf.
// computeFinanceKpisFromCache) et la barre d'onglets suivent la même plage.
let financePeriodFrom=null; // 'YYYY-MM-DD' ou null
let financePeriodTo=null; // 'YYYY-MM-DD' ou null
// Factorisé pour être réutilisable avec des bornes EXPLICITES (pas seulement
// les globales financePeriodFrom/To) — sert au calcul de la période N-1 pour
// la comparaison affichée sur les KPI (cf. financePreviousPeriodBounds).
function invoiceInRange(inv,from,to){
if(!from&&!to)return true;
if(!inv.deadline)return false; // pas d'échéance (ex. brouillon) : hors période dès qu'une borne est posée
if(from&&inv.deadline<from)return false;
if(to&&inv.deadline>to)return false;
return true;
}
function financeMatchesPeriod(inv){ return invoiceInRange(inv,financePeriodFrom,financePeriodTo); }
// Bornes de la période "précédente" (même durée, juste avant) — sert à
// afficher un delta sur les 2 principales cartes KPI, comme le fait
// Kollekt/LeanPay ("DSO 47j ↑1,8% vs période précédente"). Sans borne Du/Au
// posée, on compare les 30 derniers jours aux 30 précédents par défaut.
function financePreviousPeriodBounds(){
if(financePeriodFrom||financePeriodTo){
if(!financePeriodFrom)return null; // "Au" seul, sans point de départ : durée non définie, pas de comparaison
const from=new Date(`${financePeriodFrom}T00:00:00`);
const to=financePeriodTo?new Date(`${financePeriodTo}T00:00:00`):new Date();
const lengthMs=to-from;
if(lengthMs<0)return null;
const prevTo=new Date(from.getTime()-86400000);
const prevFrom=new Date(prevTo.getTime()-lengthMs);
return {from:prevFrom.toISOString().slice(0,10),to:prevTo.toISOString().slice(0,10)};
}
const today=new Date();
today.setHours(0,0,0,0);
const to=new Date(today.getTime()-86400000);
const from=new Date(today.getTime()-30*86400000);
return {from:from.toISOString().slice(0,10),to:to.toISOString().slice(0,10)};
}
function setFinancePeriodFrom(v){ financePeriodFrom=v||null; onFinancePeriodChange(); }
function setFinancePeriodTo(v){ financePeriodTo=v||null; onFinancePeriodChange(); }
function resetFinancePeriod(){
financePeriodFrom=null;
financePeriodTo=null;
const f=document.getElementById('finance-period-from'), t=document.getElementById('finance-period-to');
if(f)f.value='';
if(t)t.value='';
onFinancePeriodChange();
}
function onFinancePeriodChange(){
const resetBtn=document.getElementById('finance-period-reset');
if(resetBtn)resetBtn.style.display=(financePeriodFrom||financePeriodTo)?'':'none';
renderFinanceTabs();
renderFinanceInvoices();
renderFinanceKpis(computeFinanceKpisFromCache());
}
function financeHeaders(json){ const h={'x-commercial-id':commercialId}; if(json)h['Content-Type']='application/json'; return h; }
async function loadFinance(){ await refreshFinanceInvoices(); }
async function refreshFinanceInvoices(){
const [kpis,invoices]=await Promise.all([
fetch(`${API}/finance/kpis`,{headers:financeHeaders()}).then(r=>r.json()),
fetch(`${API}/finance/invoices`,{headers:financeHeaders()}).then(r=>r.json()),
]);
financeInvoicesCache=Array.isArray(invoices)?invoices:[];
// La syncOverview (répartition brute Pennylane, tous statuts confondus) est
// la seule chose qu'on garde du backend telle quelle : c'est un repère de
// cohérence de synchro globale, jamais borné à une période. Les KPI
// affichés, eux, sont recalculés côté front à partir du cache, filtrés par
// la période sélectionnée (cf. computeFinanceKpisFromCache).
renderFinanceSyncOverview(kpis);
renderFinanceKpis(computeFinanceKpisFromCache());
renderFinanceTabs();
renderFinanceInvoices();
}
// Rafraîchit UNE SEULE facture après une édition qui ne concerne qu'elle
// (changement de statut, ajout/édition/suppression d'échéance) — évite de
// refetch les ~2000 factures + recalculer les KPI backend à chaque clic
// (cf. audit perf 09/2026, "trop trop long" à l'enregistrement). Un vrai
// syncFinance() (potentiellement des centaines de lignes touchées) continue
// lui d'utiliser refreshFinanceInvoices() ci-dessus.
async function refreshOneFinanceInvoice(id){
const r=await fetch(`${API}/finance/invoices/${id}`,{headers:financeHeaders()});
if(!r.ok)return;
const updated=await r.json();
const idx=financeInvoicesCache.findIndex(i=>i.id===updated.id);
if(idx>=0)financeInvoicesCache[idx]=updated; else financeInvoicesCache.push(updated);
renderFinanceTabs();
renderFinanceInvoices();
renderFinanceKpis(computeFinanceKpisFromCache());
}
// Statuts Pennylane exclus de l'encours de recouvrement (mêmes exclusions que
// /api/finance/kpis côté back : un brouillon, un avoir, une annulation... ne
// représentent pas une dette à recouvrer). `paid` en fait partie : certaines
// factures encaissées gardent un remaining_amount non nul côté Pennylane (le
// champ ne retombe pas toujours à 0 à l'encaissement — cf. l'onglet Encaissée
// où on voyait un "Xj de retard" rouge sur des factures pourtant soldées),
// donc on exclut par STATUT plutôt que de se fier uniquement à remaining>0.
const FINANCE_HORS_RECOUVREMENT=['draft','credit_note','cancelled','partially_cancelled','archived','incomplete','paid'];
// Sous-ensemble "définitivement soldé" (utilisé pour l'affichage retard, pas
// seulement l'exclusion d'encours) — mêmes valeurs que PENNYLANE_STATUSES_SOLDEES
// côté pennylane.js, qui pilote déjà l'alignement de internalStatus='solde'.
const FINANCE_STATUSES_SOLDEES=['paid','cancelled','partially_cancelled','credit_note'];
// Petit repère visuel sur le Montant TTC quand le reste-dû Pennylane est non
// nul MAIS que la facture est déjà exclue de l'encours par son statut brut
// (typiquement `paid` — cf. commentaire ci-dessus) : sans ça, le montant
// affiché en colonne donne l'impression d'être compté dans les KPI/la barre
// de répartition alors qu'il ne l'est jamais, ce qui n'est pas visible tant
// qu'on ne compare pas au total (source de confusion remontée par Donatien
// sur le donut/la barre "répartition par statut").
function financeExclusEncoursBadge(inv){
if(!inv.status||!FINANCE_HORS_RECOUVREMENT.includes(inv.status))return '';
const remaining=inv.remainingAmountTtc!=null?inv.remainingAmountTtc:(inv.remainingAmount||0);
if(!(remaining>0))return '';
const label=PENNYLANE_STATUS_LABEL[inv.status]||inv.status;
return `<span class="finance-hors-encours-badge" title="Reste-dû Pennylane non nul, mais statut « ${label} » — cette facture n'est jamais comptée dans l'encours ni dans la répartition par statut">ⓘ</span>`;
}
// Statuts internes déjà "pris en charge" autrement qu'en relance active (même
// exclusion que côté back et que le digest mail quotidien) — un litige en
// cours ou une promesse de paiement obtenue n'attend pas une relance du jour.
// 'douteux' ajouté le 24/09/2026 (demande Lina) — même liste que côté back
// (financeRoutes.js), à garder synchronisée.
const FINANCE_STATUTS_NON_ACTIONABLES=['litige','promesse_paiement','solde','douteux'];
// Recalcule les KPI de recouvrement (encours, montant actionable, taux de
// retard, aging, répartition par statut, DSO) côté front, à partir du cache
// local déjà filtré par la période ET les chips de filtre actifs — reproduit
// exactement le calcul de /api/finance/kpis (même exclusions, même définition
// d'actionable) mais borné à la plage Du/Au et au(x) filtre(s) en cours, ce
// que l'endpoint back ne fait pas. Permet aussi aux cartes KPI de réagir
// immédiatement à un changement de statut interne, de période, ou de filtre,
// sans réappeler le serveur.
function computeFinanceKpisFromCache(boundsOverride,filtersOverride){
const from=boundsOverride?boundsOverride.from:financePeriodFrom;
const to=boundsOverride?boundsOverride.to:financePeriodTo;
const filters=filtersOverride||financeActiveFilters;
const list=financeInvoicesCache.filter(inv=>invoiceInRange(inv,from,to)&&financeMatchesFilters(inv,filters));
const unpaid=list.filter(inv=>{
const remaining=inv.remainingAmountTtc!=null?inv.remainingAmountTtc:(inv.remainingAmount||0);
return remaining>0 && (!inv.status||!FINANCE_HORS_RECOUVREMENT.includes(inv.status));
});
let totalEncours=0,montantEnRetard=0,nbEnRetard=0,montantActionable=0,nbActionable=0;
const aging={j0_30:0,j31_60:0,j61_90:0,j90_plus:0};
const parStatut={}; // vue "pipeline" : répartition de l'encours par statut interne, retard ou pas
for(const inv of unpaid){
const remaining=inv.remainingAmountTtc!=null?inv.remainingAmountTtc:(inv.remainingAmount||0);
totalEncours+=remaining;
const statut=inv.internalStatus||'a_relancer';
if(!parStatut[statut])parStatut[statut]={count:0,montant:0};
parStatut[statut].count+=1;
parStatut[statut].montant+=remaining;
const daysLate=inv.daysLate;
if(daysLate!=null&&daysLate>0){
nbEnRetard+=1;
montantEnRetard+=remaining;
if(!FINANCE_STATUTS_NON_ACTIONABLES.includes(statut)){
nbActionable+=1;
montantActionable+=remaining;
}
if(daysLate<=30)aging.j0_30+=remaining;
else if(daysLate<=60)aging.j31_60+=remaining;
else if(daysLate<=90)aging.j61_90+=remaining;
else aging.j90_plus+=remaining;
}
}
// DSO : CA facturé sur la période sélectionnée (ou 90j glissants par défaut
// quand aucune borne Du/Au n'est posée), rapporté à l'encours de cette même
// période — une approximation cohérente avec la formule back, mais bornée
// à la période choisie plutôt que toujours glissante sur 90j.
let periodStartStr,periodDays=90;
if(from||to){
periodStartStr=from||null;
if(from){
const fromD=new Date(`${from}T00:00:00`);
const toD=to?new Date(`${to}T00:00:00`):new Date();
periodDays=Math.max(1,Math.round((toD-fromD)/86400000)+1);
}
}else{
const d=new Date();
d.setHours(0,0,0,0);
d.setDate(d.getDate()-90);
periodStartStr=d.toISOString().slice(0,10);
}
const caPeriode=financeInvoicesCache.reduce((sum,inv)=>{
if(!financeMatchesFilters(inv,filters))return sum;
if(!inv.dateEmission)return sum;
if(periodStartStr&&inv.dateEmission<periodStartStr)return sum;
if(to&&inv.dateEmission>to)return sum;
return sum+(inv.amountTtc!=null?inv.amountTtc:(inv.amount||0));
},0);
const dso=caPeriode>0?Math.round((totalEncours/caPeriode)*periodDays):null;
const tauxDeRetard=totalEncours>0?Math.round((montantEnRetard/totalEncours)*1000)/10:0;
return {
totalEncours,
montantEnRetard,
nbFacturesEnRetard:nbEnRetard,
nbFacturesTotal:unpaid.length,
montantActionable,
nbFacturesActionable:nbActionable,
tauxDeRetard,
dso,
aging,
parStatut,
periodJours:periodDays,
};
}
// Statuts bruts Pennylane (champ status de l'API) -> libellé FR, pour le
// repère de cohérence de synchro. Couvre tout ce qu'on a vu dans la doc
// Pennylane, y compris les statuts qu'on exclut du recouvrement (brouillon,
// avoir, annulée...) puisque le but ici est justement de vérifier qu'ils ont
// bien été ramenés par la synchro, pas de les filtrer.
const PENNYLANE_STATUS_LABEL={
draft:'Brouillon', incomplete:'Incomplète', cancelled:'Annulée', partially_cancelled:'Partiellement annulée',
paid:'Encaissée', partially_paid:'Partiellement encaissée', upcoming:'À venir', late:'En retard',
credit_note:'Avoir', archived:'Archivée', proforma:'Proforma', shipping_order:'Bon de livraison',
purchasing_order:'Bon de commande', estimate_pending:'Devis en attente', estimate_accepted:'Devis accepté',
estimate_invoiced:'Devis facturé', estimate_denied:'Devis refusé', inconnu:'Sans statut',
};
let financeSyncOverviewOpen=false;
let financeKpisCache=null;
function toggleFinanceSyncOverview(){ financeSyncOverviewOpen=!financeSyncOverviewOpen; renderFinanceSyncOverview(financeKpisCache); }
function renderFinanceSyncOverview(k){
const wrap=document.getElementById('finance-sync-overview');
const toggle=document.getElementById('finance-sync-detail-toggle');
if(!wrap)return;
if(k)financeKpisCache=k;
const overview=financeKpisCache&&financeKpisCache.syncOverview;
if(toggle)toggle.textContent=financeSyncOverviewOpen?'Masquer le détail':'Détail de la synchro';
if(!financeSyncOverviewOpen||!overview||!overview.total){wrap.style.display='none';wrap.innerHTML='';return;}
const parts=Object.entries(overview.byStatus||{})
.sort((a,b)=>b[1]-a[1])
.map(([status,n])=>`${PENNYLANE_STATUS_LABEL[status]||status} ${n}`)
.join(' · ');
wrap.style.display='';
wrap.innerHTML=`Synchro Pennylane — Toutes ${overview.total} · ${parts}`;
}
// Barre de répartition empilée (remplace l'ancien donut SVG, jugé "pas
// terrible" à l'usage) — chaque statut est un segment coloré dont la largeur
// est sa part de l'encours total, dans l'ordre de FINANCE_STATUS_LABEL.
function financeStatutBarHtml(segs){
const parts=segs.filter(s=>s.pct>0)
.map(s=>`<div class="finance-statut-bar-seg" style="width:${s.pct}%;background:${s.color}" title="${s.label} — ${Math.round(s.pct*10)/10}%"></div>`)
.join('');
return `<div class="finance-statut-bar">${parts||'<div class="finance-statut-bar-empty"></div>'}</div>`;
}
// Delta vs période précédente (même durée, juste avant) — affiché en petit
// sous le chiffre principal, comme "DSO 47j ↑1,8% vs période précédente" chez
// Kollekt. Une hausse d'encours/montant actionable est présentée en rouge
// (ça se dégrade), une baisse en vert (ça s'améliore) — l'inverse du sens
// "hausse = bon" qu'on utiliserait pour un CA par exemple.
function financeKpiDeltaHtml(curVal,prevVal){
if(prevVal==null)return '';
if(!prevVal)return curVal>0?'<span class="finance-kpi-delta up">▲ nouveau</span>':'';
const pct=Math.round(((curVal-prevVal)/prevVal)*100);
if(pct===0)return '<span class="finance-kpi-delta flat">= vs période préc.</span>';
const up=pct>0;
return `<span class="finance-kpi-delta ${up?'up':'down'}">${up?'▲':'▼'} ${Math.abs(pct)}% vs préc.</span>`;
}
function renderFinanceKpis(k){
const wrap=document.getElementById('finance-kpis');
if(!wrap||!k)return;
const statutSegs=Object.keys(FINANCE_STATUS_LABEL).map(key=>({key,label:FINANCE_STATUS_LABEL[key],color:FINANCE_STATUS_COLOR[key]}));
const parStatut=k.parStatut||{};
// Filet de sécurité : une facture dont internalStatus ne correspond à aucun
// des 5 statuts connus (donnée invalide/orpheline) ne doit pas silencieusement
// disparaître de la barre — elle tombe dans un segment "Autre" visible plutôt
// que de fausser le total sans qu'on puisse le voir.
const knownKeys=new Set(statutSegs.map(s=>s.key));
let autreMontant=0,autreCount=0;
for(const [key,v] of Object.entries(parStatut)){
if(!knownKeys.has(key)){ autreMontant+=v.montant||0; autreCount+=v.count||0; }
}
if(autreCount>0)statutSegs.push({key:'__autre',label:'Autre',color:'var(--text-muted)'});
const statutTotal=Object.values(parStatut).reduce((s,v)=>s+(v.montant||0),0);
const nonActionable=(k.montantEnRetard||0)-(k.montantActionable||0);
const prevBounds=financePreviousPeriodBounds();
const prevK=prevBounds?computeFinanceKpisFromCache(prevBounds):null;
const parStatutForSegs={...parStatut,__autre:{count:autreCount,montant:autreMontant}};
const barSegs=statutSegs.map(s=>({label:s.label,pct:statutTotal?((parStatutForSegs[s.key]||{}).montant||0)/statutTotal*100:0,color:s.color}));
wrap.innerHTML=`
<div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:var(--accent)"></span>Encours total</div><div class="kpi-val" title="${fmtCA(k.totalEncours)}">${fmtCACompact(k.totalEncours)}</div><div class="kpi-lbl">${k.nbFacturesTotal} facture(s) non soldée(s) ${financeKpiDeltaHtml(k.totalEncours,prevK?prevK.totalEncours:null)}</div></div>
<div class="kpi-card" title="Hors factures soldées, annulées, ou suivies séparément (litige / promesse de paiement / douteux)"><div class="kpi-eyebrow"><span class="dot" style="background:#dc2626"></span>À relancer aujourd'hui ⓘ</div><div class="kpi-val" style="color:#dc2626" title="${fmtCA(k.montantActionable)}">${fmtCACompact(k.montantActionable)}</div><div class="kpi-lbl">${k.nbFacturesActionable} facture(s) en retard${nonActionable>0?` · ${fmtCA(nonActionable)} en litige/promesse/douteux (suivi à part)`:''} ${financeKpiDeltaHtml(k.montantActionable,prevK?prevK.montantActionable:null)}</div></div>
<div class="kpi-card" title="Hors factures soldées, annulées, ou suivies séparément (litige / promesse de paiement)"><div class="kpi-eyebrow"><span class="dot" style="background:var(--gold)"></span>Taux de retard ⓘ</div><div class="kpi-val" style="color:var(--gold)">${k.tauxDeRetard}%</div><div class="kpi-lbl">Part de l'encours en retard (${k.nbFacturesEnRetard} facture(s))</div></div>
<div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:#8b5cf6"></span>DSO</div><div class="kpi-val" style="color:#8b5cf6">${k.dso!=null?k.dso+'j':'—'}</div><div class="kpi-lbl">Délai moyen de paiement (${(financePeriodFrom||financePeriodTo)?`période sélectionnée, ${k.periodJours}j`:`${k.periodJours}j glissants`})</div></div>
<div class="kpi-card" style="grid-column:1/-1">
<div class="kpi-eyebrow"><span class="dot" style="background:var(--text-muted)"></span>Répartition de l'encours par statut</div>
<div class="finance-statut-bar-row">
${financeStatutBarHtml(barSegs)}
<div class="finance-statut-bar-total">${fmtCACompact(statutTotal)}<span>encours</span></div>
</div>
<div class="finance-aging-legend">${statutSegs.filter(s=>(parStatutForSegs[s.key]||{}).count).map(s=>`<span><span class="dot" style="background:${s.color}"></span>${s.label} — ${(parStatutForSegs[s.key]||{}).count} · ${fmtCA((parStatutForSegs[s.key]||{}).montant||0)}</span>`).join('')}</div>
</div>
`;
}
// Barre de progression du retard : avant échéance, progression entre la date
// d'émission et l'échéance (repère visuel de "combien de temps il reste") ;
// après échéance, barre rouge dont la longueur croît avec le nombre de jours
// de retard (plafonnée à 90j de retard pour rester lisible au-delà).
// Depuis que le tableau affiche AUSSI les factures encaissées/annulées/avoirs
// (barre d'onglets calquée sur Pennylane, plus seulement les impayées), une
// vieille facture payée dont l'échéance est passée depuis longtemps ne doit
// plus s'afficher comme "en retard" en rouge — elle est réglée, ça n'a pas de
// sens. On neutralise la barre dès que le reste dû est nul/négatif.
// Ancien badge "Dernière relance il y a Xj" — laissé défini mais plus appelé
// nulle part depuis 09/2026 : remplacé dans le tableau par la date d'émission
// (cf. renderFinanceInvoices ci-dessous, demande Lina). Conservé au cas où.
function financeLastRelanceBadge(inv){
const resolved=inv.internalStatus==='solde'||FINANCE_STATUSES_SOLDEES.includes(inv.status);
if(resolved)return '';
if(!inv.lastRelanceAt)return '<div class="finance-relance-badge never">Jamais relancée</div>';
const days=Math.floor((Date.now()-new Date(inv.lastRelanceAt).getTime())/86400000);
if(days<=0)return '<div class="finance-relance-badge recent">Relancée aujourd\'hui</div>';
return `<div class="finance-relance-badge${days>14?' stale':''}">Relancée il y a ${days}j</div>`;
}
// Date d'émission affichée sous le n° de facture (09/2026, remplace le badge
// "dernière relance" ci-dessus) — réutilise la même classe .finance-relance-badge
// que le badge précédent pour garder exactement le même gabarit visuel.
function financeEmissionDateHtml(inv){
return `<div class="finance-relance-badge">Émise le ${formatDateFR(inv.dateEmission)}</div>`;
}
function financeRetardBarHtml(inv){
const daysLate=inv.daysLate;
const remaining=inv.remainingAmountTtc!=null?inv.remainingAmountTtc:inv.remainingAmount;
// Priorité au statut (interne 'solde', ou Pennylane paid/annulée/avoir) sur
// le montant restant : une facture encaissée peut garder un remaining_amount
// non nul côté Pennylane, et afficher "Xj de retard" en rouge sur une
// facture déjà marquée Soldée à côté serait contradictoire.
const resolved=inv.internalStatus==='solde'||inv.allEcheancesReglees||FINANCE_STATUSES_SOLDEES.includes(inv.status);
if(resolved||(remaining||0)<=0)return '<span style="font-size:11px;color:var(--text-muted)">Soldée</span>';
if(daysLate==null)return '<span style="font-size:11px;color:var(--text-muted)">—</span>';
// Une fois l'échéance 1 validée réglée, la référence de retard glisse sur
// l'échéance 2 (puis 3, 4...) — on le précise ici plutôt que de laisser le
// nombre de jours changer sans que la date affichée en colonne Échéance
// n'ait bougé, ce qui serait déroutant.
const echPrefix=(inv.retardEcheanceNum&&inv.retardEcheanceNum>1)?`Éch. ${inv.retardEcheanceNum} — `:'';
if(daysLate<=0){
const emission=inv.dateEmission?new Date(`${inv.dateEmission}T00:00:00`):null;
const refDue=inv.retardEcheanceDue||inv.deadline;
const deadline=refDue?new Date(`${refDue}T00:00:00`):null;
let pct=0;
if(emission&&deadline&&deadline>emission){
pct=Math.max(0,Math.min(100,((Date.now()-emission)/(deadline-emission))*100));
}
return `<div class="finance-retard-wrap"><div class="finance-retard-bar"><div class="finance-retard-fill" style="width:${pct}%;background:var(--accent)"></div></div><div class="finance-retard-label">${echPrefix}${-daysLate}j avant échéance</div></div>`;
}
const pct=Math.max(6,Math.min(100,(daysLate/90)*100));
return `<div class="finance-retard-wrap"><div class="finance-retard-bar"><div class="finance-retard-fill" style="width:${pct}%;background:#dc2626"></div></div><div class="finance-retard-label" style="color:#dc2626;font-weight:700">${echPrefix}${daysLate}j de retard</div></div>`;
}
// Barre d'onglets = calque du classement Pennylane, chaque onglet testant le
// champ `status` BRUT tel que renvoyé par Pennylane sur la facture (pas notre
// internalStatus interne, qui reste un attribut séparé éditable dans le
// tableau ci-dessous pour le suivi de relance). "Brouillon" et "À traiter"
// (incomplete) ont été retirés de la barre : ce ne sont pas des statuts sur
// lesquels le recouvrement agit, ils encombraient la barre pour rien.
// "Annulée" regroupe cancelled ET partially_cancelled (Pennylane n'affiche
// qu'une seule case Annulée, pas de case séparée pour l'annulation partielle).
const PENNYLANE_TAB_STATUSES={
upcoming:['upcoming'],
late:['late'],
paid:['paid'],
partially_paid:['partially_paid'],
cancelled:['cancelled','partially_cancelled'],
credit_note:['credit_note'],
archived:['archived'],
};
// Couleur par statut brut Pennylane, appliquée à l'onglet quand il est actif —
// avant, tous les onglets passaient au même bleu "accent" une fois cliqués,
// qu'il s'agisse d'un statut critique (En retard) ou neutre (Annulée),
// obligeant à lire le texte pour juger de la gravité (relevé dans l'audit UX).
const FINANCE_TAB_COLOR={
all: {bg:'var(--accent-dim)', fg:'var(--accent)'},
upcoming: {bg:'var(--accent-dim)', fg:'var(--accent)'},
late: {bg:'var(--red-dim)', fg:'#dc2626'},
douteux_manuel: {bg:'rgba(249,115,22,0.14)', fg:'#f97316'},
paid: {bg:'var(--green-dim)', fg:'var(--green)'},
partially_paid: {bg:'rgba(13,148,136,0.12)', fg:'#0d9488'},
cancelled: {bg:'var(--surface2)', fg:'var(--text-dim)'},
credit_note: {bg:'rgba(139,92,246,0.14)', fg:'#8b5cf6'},
archived: {bg:'var(--surface2)', fg:'var(--text-muted)'},
};
// Statuts internes déjà "pris en charge" autrement (litige, promesse de
// paiement, soldée, ou "Relancé" = en_cours) qui, depuis 09/2026 (demande
// Lina, hypothèse à valider visuellement — cf. le prompt de dev), sortent des
// onglets "À venir" et "En retard" : une facture déjà suivie autrement que
// par une relance active n'a plus besoin d'apparaître dans ces deux vues-là.
// Mêmes valeurs que FINANCE_STATUTS_NON_ACTIONABLES ci-dessus, + en_cours.
const FINANCE_TAB_EXCLURE_DEJA_PRISE_EN_CHARGE=['litige','promesse_paiement','solde','en_cours','douteux'];
// Test d'UNE facture contre UN chip donné (utilisé pour les compteurs par
// chip, et comme brique de financeMatchesFilters ci-dessous).
function financeMatchesFilterKey(inv,key){
if(key==='all')return true;
// Onglet "Douteux" manuel (nouveau, 09/2026) : PAS un statut brut Pennylane
// (contrairement aux autres onglets ci-dessous) — filtre sur le champ
// internalStatus, coché à la main par l'équipe, distinct du statut Pennylane
// "upcoming" (qui reste "À venir" dans PENNYLANE_STATUS_LABEL) et distinct
// aussi du statut "Douteux" des échéances (finance_installment_statuses,
// autre système, non lié).
if(key==='douteux_manuel')return inv.internalStatus==='douteux';
const statuses=PENNYLANE_TAB_STATUSES[key];
if(!statuses||!statuses.includes(inv.status))return false;
if((key==='upcoming'||key==='late')&&FINANCE_TAB_EXCLURE_DEJA_PRISE_EN_CHARGE.includes(inv.internalStatus))return false;
return true;
}
// Test contre l'ENSEMBLE des chips actuellement sélectionnés (multi-sélection) —
// une facture matche dès qu'elle correspond à au moins un chip actif.
function financeMatchesFilters(inv,filters){
if(!filters||filters.has('all'))return true;
for(const key of filters){ if(financeMatchesFilterKey(inv,key))return true; }
return false;
}
function setFinanceFilter(key){
if(!key)return;
if(key==='all'){
financeActiveFilters=new Set(['all']);
}else{
financeActiveFilters.delete('all');
if(financeActiveFilters.has(key))financeActiveFilters.delete(key);
else financeActiveFilters.add(key);
if(!financeActiveFilters.size)financeActiveFilters.add('all'); // plus aucun chip actif -> retombe sur Toutes
}
renderFinanceTabs();
renderFinanceInvoices();
renderFinanceKpis(computeFinanceKpisFromCache());
}
// Barre d'onglets avec compteur en direct depuis le cache local — le compteur
// "Toutes" sert aussi de repère rapide pour vérifier que la dernière synchro
// a bien ramené le nombre de factures attendu (à comparer avec le total
// affiché côté Pennylane).
function renderFinanceTabs(){
const wrap=document.getElementById('finance-tabs');
if(!wrap)return;
const list=financeInvoicesCache.filter(financeMatchesPeriod);
const counts={all:list.length};
for(const key of Object.keys(PENNYLANE_TAB_STATUSES)){
counts[key]=list.filter((i)=>financeMatchesFilterKey(i,key)).length;
}
counts.douteux_manuel=list.filter((i)=>financeMatchesFilterKey(i,'douteux_manuel')).length;
const chip=(key,label,title)=>{
const active=financeActiveFilters.has(key);
const c=FINANCE_TAB_COLOR[key]||FINANCE_TAB_COLOR.all;
const style=active?` style="background:${c.bg};color:${c.fg}"`:'';
const countStyle=active?` style="background:${c.fg};color:#fff"`:'';
return `<button type="button" class="finance-tab ${active?'active':''}"${style} onclick="setFinanceFilter('${key}')"${title?` title="${title}"`:''}>${label} <span class="finance-tab-count"${countStyle}>${counts[key]}</span></button>`;
};
wrap.innerHTML=`
${chip('all','Toutes')}
${chip('upcoming','À venir')}
${chip('late','En retard')}
${chip('douteux_manuel','Douteux')}
${chip('paid','Encaissée')}
${chip('partially_paid','Part. encaissée','Partiellement encaissée')}
${chip('cancelled','Annulée')}
${chip('credit_note','Avoir')}
${chip('archived','Archivée')}
`;
}
// Filtrage complet (période + onglets + recherche) — factorisé pour être
// partagé entre l'affichage du tableau (renderFinanceInvoices) et l'export
// CSV (exportFinanceCsv, 09/2026) : l'export doit exporter exactement ce qui
// est affiché à l'écran au moment du clic, pas tout l'historique brut.
function currentFilteredFinanceInvoices(){
const q=(document.getElementById('finance-search')?.value||'').trim().toLowerCase();
return financeInvoicesCache.filter(inv=>{
if(!financeMatchesPeriod(inv))return false;
if(!financeMatchesFilters(inv,financeActiveFilters))return false;
if(q&&!(String(inv.invoiceNumber||'').toLowerCase().includes(q)||inv.customerName.toLowerCase().includes(q)||(inv.contactName||'').toLowerCase().includes(q)))return false;
return true;
});
}
function renderFinanceInvoices(){
const wrap=document.getElementById('finance-invoices-table');
if(!wrap)return;
const priorityBtn=document.getElementById('finance-priority-btn');
if(priorityBtn){
const active=financeSortKey==='priority';
priorityBtn.classList.toggle('active',active);
document.getElementById('finance-priority-arrow').textContent=active?(financeSortDir===1?' ▲':' ▼'):'';
}
let list=currentFilteredFinanceInvoices();
if(!list.length){
wrap.innerHTML='<div class="idea-box-empty" style="padding:24px 0">Aucune facture à afficher — synchronisez Pennylane, ou ajustez les filtres.</div>';
return;
}
if(financeSortKey){
const dir=financeSortDir;
const sortVal=(inv)=>{
if(financeSortKey==='deadline')return inv.deadline||'';
if(financeSortKey==='retard')return inv.daysLate!=null?inv.daysLate:-Infinity;
if(financeSortKey==='montant')return inv.remainingAmountTtc!=null?inv.remainingAmountTtc:(inv.remainingAmount||0);
if(financeSortKey==='priority'){
// Score simple = montant restant dû × jours de retard — répond à
// "qu'est-ce que je traite en premier aujourd'hui", ce que le tri
// colonne par colonne ne peut pas faire (relevé dans l'audit UX v2) :
// une petite facture en retard depuis peu ne doit pas passer avant une
// grosse facture en retard depuis presque aussi longtemps. Les
// factures non en retard ou déjà soldées/en litige-suivi-à-part
// tombent en fin de liste (score -1) plutôt que de fausser le tri.
const resolved=inv.internalStatus==='solde'||FINANCE_STATUSES_SOLDEES.includes(inv.status);
if(resolved||inv.daysLate==null||inv.daysLate<=0)return -1;
const remaining=inv.remainingAmountTtc!=null?inv.remainingAmountTtc:(inv.remainingAmount||0);
return remaining*inv.daysLate;
}
return 0;
};
list=[...list].sort((a,b)=>{
const va=sortVal(a),vb=sortVal(b);
if(va<vb)return -1*dir;
if(va>vb)return 1*dir;
return 0;
});
}
const statutOptionsHtml=(inv)=>(meta.financeInternalStatuses||[]).map(s=>`<option value="${s}" ${s===inv.internalStatus?'selected':''}>${FINANCE_STATUS_LABEL[s]||s}</option>`).join('');
wrap.innerHTML=`<table>
<thead><tr><th>Facture</th><th>Entreprise</th><th>Nom Prénom</th><th>Mail</th><th>Téléphone</th><th class="sortable-th" onclick="setFinanceSort('deadline')">Éch. 1${financeSortArrow('deadline')}</th><th title="2e échéance — cf. Échéances de paiement dans la fiche facture">Éch. 2</th><th title="3e échéance">Éch. 3</th><th title="4e échéance">Éch. 4</th><th class="sortable-th" onclick="setFinanceSort('retard')">Retard${financeSortArrow('retard')}</th><th class="sortable-th" onclick="setFinanceSort('montant')">Montant TTC${financeSortArrow('montant')}</th><th>Statut</th></tr></thead>
<tbody>${list.map(inv=>`<tr class="finance-invoice-row" onclick="financeRowClick(event,'${inv.id}')">
<td><button type="button" class="finance-invoice-link" onclick="openFinanceInvoiceDetail('${inv.id}')">${inv.invoiceNumber||inv.id}</button>${financeEmissionDateHtml(inv)}</td>
<td>${inv.customerName||'—'}</td>
<td>${inv.contactName||'—'}</td>
<td>${inv.contactEmail||inv.customerEmail||'—'}</td>
<td>${inv.contactPhone||inv.customerPhone||'—'}</td>
<td><div class="finance-deadline-cell"><input type="date" class="form-input finance-deadline-input" value="${inv.deadline||''}" onchange="patchFinanceInvoice('${inv.id}',{deadline:this.value})" title="${inv.deadlineManual?'Échéance corrigée manuellement — ne sera plus écrasée par la synchro Pennylane':'Échéance Pennylane'}">${inv.deadlineManual?'<span class="finance-deadline-manual-dot" title="Corrigée manuellement">✎</span>':''}${financeDeadlineDotHtml(inv)}</div></td>
<td class="finance-installment-cell">${financeInstallmentCellHtml(inv,0)}</td>
<td class="finance-installment-cell">${financeInstallmentCellHtml(inv,1)}</td>
<td class="finance-installment-cell">${financeInstallmentCellHtml(inv,2)}</td>
<td>${financeRetardBarHtml(inv)}</td>
<td style="font-weight:600;color:var(--accent)">${fmtCA(inv.remainingAmountTtc!=null?inv.remainingAmountTtc:inv.remainingAmount)}${financeExclusEncoursBadge(inv)}</td>
<td><select class="form-select finance-inline-select" style="color:${FINANCE_STATUS_COLOR[inv.internalStatus]||'inherit'}" onchange="patchFinanceInvoice('${inv.id}',{internalStatus:this.value})">${statutOptionsHtml(inv)}</select></td>
</tr>`).join('')}</tbody>
</table>`;
}
// Clic n'importe où sur la ligne = ouvre la fiche facture (avant : seul le
// n° de facture l'ouvrait). Les contrôles interactifs de la ligne (date,
// select de statut, pastilles d'échéance, bouton "+") gardent leur propre
// action et ne doivent PAS en plus ouvrir la fiche — d'où ce garde-fou sur
// l'élément cliqué plutôt qu'un stopPropagation sur chacun d'eux.
function financeRowClick(event,invId){
if(event.target.closest('button,select,input,a,label'))return;
openFinanceInvoiceDetail(invId);
}
// Colonnes Éch. 2/3/4 : une pastille de couleur (statut d'échéance, cf.
// Paramètres > Recouvrement) plutôt que date+montant en clair — reste léger
// visuellement même pour les factures qui n'ont que 2 ou 3 tranches (la
// majorité). Le détail complet (date, montant, solde) est dans le title au
// survol, et l'édition reste dans la fiche facture (clic = ouvre la fiche).
// Depuis 09/2026, la date est aussi affichée en petit sous la pastille
// (demande Lina, notes manuscrites) — texte discret, même gabarit que
// financeEmissionDateHtml ci-dessus, pour ne pas surcharger le tableau.
// idx 0/1/2 = échéance 2/3/4 (l'échéance 1 reste la colonne "Éch. 1" ci-
// dessus, c'est la deadline Pennylane) ; une 5e tranche éventuelle (rare)
// n'est pas cachée silencieusement : elle apparaît en badge "+N" sur la
// dernière colonne plutôt que de rajouter une colonne par tranche possible.
// Case vide (pas encore de tranche à ce rang) : bouton "+" qui ouvre le
// popover d'ajout rapide (cf. openFinanceInstallmentQuickAdd) directement
// depuis le tableau, sans passer par la fiche facture complète.
// Pastille de statut de l'échéance 1 (= la deadline principale), affichée à
// côté de la date dans le tableau — même logique que financeInstallmentCellHtml
// ci-dessous pour 2/3/4, mais toujours visible (l'échéance 1 existe toujours,
// pas de bouton "+" nécessaire) : ouvre la fiche pour l'éditer, comme les
// autres pastilles, la modification en direct se fait via la pastille complète
// dans la fiche détail.
function financeDeadlineDotHtml(inv){
const color=inv.deadlineStatusColor||'var(--text-muted)';
const label=inv.deadlineStatusLabel||'—';
const title=`${label} — échéance 1`.replace(/"/g,'&quot;');
return `<button type="button" class="finance-installment-dot" style="background:${color}" title="${title}" onclick="openFinanceInvoiceDetail('${inv.id}')"></button>`;
}
function financeInstallmentCellHtml(inv,idx){
const list=inv.installments||[];
const inst=list[idx];
if(!inst)return `<button type="button" class="finance-installment-add-btn" title="Ajouter une échéance" onclick="openFinanceInstallmentQuickAdd(event,'${inv.id}')">+</button>`;
const color=inst.statusColor||'var(--text-muted)';
const label=inst.statusLabel||'—';
const title=`${label} — ${formatDateFR(inst.dueDate)} · ${fmtCA(inst.solde)} restant sur ${fmtCA(inst.amount)}`.replace(/"/g,'&quot;');
const extra=(idx===2&&list.length>3)?`<span class="finance-installment-more">+${list.length-3}</span>`:'';
return `<button type="button" class="finance-installment-dot" style="background:${color}" title="${title}" onclick="openFinanceInvoiceDetail('${inv.id}')"></button><div class="finance-relance-badge" style="margin-top:2px">${formatDateFR(inst.dueDate)}</div>${extra}`;
}
// ── Ajout rapide d'une échéance depuis le tableau (sans ouvrir la fiche) ────
let financeQuickAddState=null; // {invoiceId, statusId} tant que le popover est ouvert
function openFinanceInstallmentQuickAdd(event,invoiceId){
event.stopPropagation();
closeFinanceStatusPickers();
closeFinanceInstallmentQuickAdd();
const rect=event.currentTarget.getBoundingClientRect();
const defaultStatusId=financeInstallmentStatuses[0]?financeInstallmentStatuses[0].id:null;
financeQuickAddState={invoiceId,statusId:defaultStatusId};
const pop=document.createElement('div');
pop.id='finance-quickadd-popover';
pop.className='finance-quickadd-popover';
pop.style.top=`${rect.bottom+6+window.scrollY}px`;
pop.style.left=`${Math.min(rect.left+window.scrollX,window.innerWidth-260)}px`;
pop.innerHTML=`
<div class="form-label" style="margin-bottom:6px">Nouvelle échéance</div>
<input class="form-input" id="finance-quickadd-date" type="date" style="margin-bottom:6px;width:100%">
<input class="form-input" id="finance-quickadd-amount" type="number" step="0.01" placeholder="Montant €" style="margin-bottom:8px;width:100%">
<div style="margin-bottom:10px">${financeStatusPillHtml(defaultStatusId,(statusId)=>{if(financeQuickAddState)financeQuickAddState.statusId=statusId;})}</div>
<div style="display:flex;gap:6px">
<button type="button" class="btn-primary" style="flex:1" onclick="submitFinanceInstallmentQuickAdd()">Ajouter</button>
<button type="button" class="btn-secondary" onclick="closeFinanceInstallmentQuickAdd()">Annuler</button>
</div>`;
document.body.appendChild(pop);
document.getElementById('finance-quickadd-date').focus();
}
function closeFinanceInstallmentQuickAdd(){
const pop=document.getElementById('finance-quickadd-popover');
if(pop)pop.remove();
financeQuickAddState=null;
}
async function submitFinanceInstallmentQuickAdd(){
if(!financeQuickAddState)return;
const {invoiceId,statusId}=financeQuickAddState;
const dueDate=document.getElementById('finance-quickadd-date').value;
const amount=Number(document.getElementById('finance-quickadd-amount').value);
if(!dueDate){ showToast('Date d’échéance requise','error'); return; }
if(!amount||amount<=0){ showToast('Montant invalide','error'); return; }
const r=await fetch(`${API}/finance/invoices/${invoiceId}/installments`,{method:'POST',headers:financeHeaders(true),body:JSON.stringify({dueDate,amount,statusId})});
const d=await r.json();
if(!r.ok){ showToast(d.error||'Échec de l’ajout','error'); return; }
closeFinanceInstallmentQuickAdd();
await refreshOneFinanceInvoice(invoiceId);
showToast('Échéance ajoutée ✓');
}
async function patchFinanceInvoice(id,patch){
try{
const res=await fetch(`${API}/finance/invoices/${id}`,{method:'PATCH',headers:financeHeaders(true),body:JSON.stringify(patch)});
if(!res.ok){ const err=await res.json().catch(()=>({})); throw new Error(err.error||'Échec de la mise à jour'); }
// Un simple changement de statut ou de date peut faire glisser la référence
// de retard côté serveur (chaîne de validation des échéances), mais ça reste
// scopé à CETTE facture : plus besoin de refetch les ~2000 factures pour ça,
// GET /finance/invoices/:id (09/2026, perf) renvoie l'état recalculé serveur
// pour cette seule ligne.
await refreshOneFinanceInvoice(id);
if(financeSelectedInvoiceId===id)openFinanceInvoiceDetail(id);
showToast('Facture mise à jour');
}catch(e){ showToast(e.message||"Échec de la mise à jour",'error'); }
}
// Un seul bouton : synchro complète Pennylane + Trello en parallèle (14/10/2026,
// demande Lina). Trello est en lecture seule ; s'il n'est pas configuré ou ne
// répond pas, la synchro Pennylane se fait quand même et on le signale.
async function syncFinance(){
const btn=document.getElementById('finance-sync-btn');
if(btn){ btn.disabled=true; btn.textContent='⏳ Synchronisation…'; }
try{
const [rp,rt]=await Promise.allSettled([
fetch(`${API}/finance/sync`,{method:'POST',headers:financeHeaders()}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'Échec de la synchro Pennylane');return d;}),
fetch(`${API}/finance/trello/sync`,{method:'POST',headers:financeHeaders()}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Trello indisponible');return d;})
]);
const parts=[];
if(rp.status==='fulfilled'){ parts.push(`Pennylane : ${rp.value.invoicesSynced} facture(s)`); }
else showToast(rp.reason.message||'Échec de la synchro Pennylane','error');
if(rt.status==='fulfilled'){ parts.push(`Trello : ${rt.value.nouvellesActions||0} nouveauté(s)`); }
else showToast('Connexion Trello interrompue : '+(rt.reason.message||''),'error');
document.getElementById('finance-last-sync').textContent=`Dernière synchro : ${new Date().toLocaleString('fr-FR')}${parts.length?' ('+parts.join(' · ')+')':''}`;
if(rp.status==='fulfilled'&&rt.status==='fulfilled')showToast('Synchro Pennylane + Trello effectuée');
await refreshFinanceInvoices();
}catch(e){ showToast(e.message||'Échec de la synchro','error'); }
finally{ if(btn){ btn.disabled=false; btn.textContent='↻ Synchroniser'; } }
}
// ── Import des créances douteuses (fichier Excel de la compta) — 29/09/2026 ──
// Demande Lina : les fichiers « créances douteuses 2025 / 2026 » alimentent le
// statut Douteux. Le fichier est envoyé tel quel au serveur (POST octet-stream),
// qui le lit et renvoie un compte rendu détaillé (voir creancesDouteuses.js).
async function importDouteuxExcel(input){
const file=input.files&&input.files[0];
input.value='';
if(!file)return;
const btn=document.getElementById('finance-douteux-btn');
if(btn){ btn.disabled=true; btn.textContent='⏳ Import en cours…'; }
try{
const r=await fetch(`${API}/finance/douteux/import`,{method:'POST',headers:{'x-commercial-id':commercialId,'Content-Type':'application/octet-stream'},body:file});
const d=await r.json();
if(!r.ok)throw new Error(d.error||"Échec de l'import");
showDouteuxImportReport(d,file.name);
await refreshFinanceInvoices();
}catch(e){ showToast(e.message||"Échec de l'import",'error'); }
finally{ if(btn){ btn.disabled=false; btn.textContent='⬆ Importer douteux (Excel)'; } }
}
function showDouteuxImportReport(d,fileName){
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const block=(title,items,fmt,open)=>items.length?`<details ${open?'open':''} style="margin-top:10px"><summary style="cursor:pointer;font-weight:600">${title} (${items.length})</summary><ul style="margin:6px 0 0 18px;font-size:12px;color:var(--text-muted)">${items.map(i=>`<li>${fmt(i)}</li>`).join('')}</ul></details>`:'';
const line=(n,label)=>`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border,#2a2f3a)"><span>${label}</span><strong>${n}</strong></div>`;
document.getElementById('modal-title').textContent=`Import créances douteuses ${esc(d.exercice)}`;
document.getElementById('modal-body').innerHTML=
`<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${esc(fileName)} — ${d.lignes} ligne(s), ${d.facturesDansFichier} n° de facture</div>`
+line(d.marquees.length,'Passées en Douteux')
+line(d.dejaDouteux.length,'Déjà en Douteux')
+line(d.protegees.length,'Non modifiées (litige / promesse / soldée)')
+line(d.ignoreesSoldeZero.length,'Solde de fin d\'exercice à 0 (ignorées)')
+line(d.remplaceesParExerciceRecent.length,'Remplacées par un exercice plus récent')
+line(d.introuvables.length,'Introuvables dans les factures Pennylane')
+block('Passées en Douteux',d.marquees,i=>`${esc(i.numero)} — ${esc(i.client)} (${fmtCA(i.soldeFin)})`,false)
+block('Non modifiées (statut protégé)',d.protegees,i=>`${esc(i.numero)} — ${esc(i.client)} : ${esc(i.raison)}`,true)
+block('Introuvables dans Pennylane',d.introuvables,i=>`${esc(i.numero)} — ${esc(i.client)} (${fmtCA(i.soldeFin)})`,true)
+block('Émises avant 2025 (masquées par la règle d\'affichage 2025+)',d.avant2025,i=>`${esc(i.numero)} — ${esc(i.client)} (${esc(i.dateEmission)})`,false);
document.getElementById('modal-footer').innerHTML='<button class="btn-secondary" onclick="closeModal()">Fermer</button>';
document.getElementById('modal-overlay').style.display='flex';
}

// ── Export CSV (09/2026, demande Lina — "à la façon de Meta Business Suite")
// Séparateur ; + BOM UTF-8 pour une ouverture directe dans Excel sans souci
// d'accents ni de colonnes fusionnées — même pattern déjà utilisé dans
// client/src/App.js (fonction exportCsv du dashboard React), adapté ici en
// JS vanilla. Exporte exactement ce qui est affiché à l'écran au moment du
// clic (période + onglets + recherche actifs), pas tout l'historique brut.
function csvField(v){ return `"${String(v==null?'':v).replace(/"/g,'""')}"`; }
function exportFinanceCsv(){
const list=currentFilteredFinanceInvoices();
if(!list.length){ showToast('Rien à exporter avec les filtres actuels','error'); return; }
const header=['Facture','Entreprise','Nom Prénom','Mail','Téléphone','Éch. 1','Éch. 2','Éch. 3','Éch. 4','Retard (j)','Montant TTC','Statut'];
const echDate=(inv,idx)=>{ const i=(inv.installments||[])[idx]; return i?formatDateFR(i.dueDate):''; };
const lines=[header.map(csvField).join(';')];
for(const inv of list){
lines.push([
csvField(inv.invoiceNumber||inv.id),
csvField(inv.customerName||''),
csvField(inv.contactName||''),
csvField(inv.contactEmail||inv.customerEmail||''),
csvField(inv.contactPhone||inv.customerPhone||''),
csvField(formatDateFR(inv.deadline)),
csvField(echDate(inv,0)),
csvField(echDate(inv,1)),
csvField(echDate(inv,2)),
inv.daysLate!=null?inv.daysLate:'',
String(inv.remainingAmountTtc!=null?inv.remainingAmountTtc:(inv.remainingAmount||0)).replace('.',','),
csvField(FINANCE_STATUS_LABEL[inv.internalStatus]||inv.internalStatus||''),
].join(';'));
}
const csv=String.fromCharCode(0xfeff)+lines.join('\r\n');
const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
const url=URL.createObjectURL(blob);
const a=document.createElement('a');
a.href=url;
a.download=`recouvrement_${new Date().toISOString().slice(0,10)}.csv`;
document.body.appendChild(a);
a.click();
a.remove();
URL.revokeObjectURL(url);
}

// ── Modal de détail facture : infos + PDF + statut + commentaires + échéances ──
// "Relances" (l'historique des actions de recouvrement déjà menées auprès du
// client — appel, email, courrier...) a été retiré de la fiche le 09/2026
// (demande Lina, confirmée) : le formulaire "Nouvelle relance" et
// l'"Historique" ne s'affichent plus. Les routes backend GET/POST
// /api/finance/invoices/:id/relances restent en place côté serveur (juste
// plus appelées depuis ce front) au cas où elles seraient réutilisées plus
// tard. Conséquence connue : la transition automatique de statut
// "à relancer" -> "Relancé" qui se déclenchait sur l'ancien POST /relances
// ne se produit donc plus jamais automatiquement — le passage à "Relancé"
// se fait désormais uniquement à la main via le select de statut.
async function openFinanceInvoiceDetail(id){
financeSelectedInvoiceId=id;
const inv=financeInvoicesCache.find(i=>i.id===id);
if(!inv)return;
document.getElementById('modal-title').textContent=`Facture ${inv.invoiceNumber||inv.id}`;
document.getElementById('modal-overlay').style.display='flex';
document.getElementById('modal-body').innerHTML='<div style="font-size:12px;color:var(--text-muted)">Chargement…</div>';
document.getElementById('modal-footer').innerHTML=`<button class="btn-secondary" onclick="closeModal()">Fermer</button>`;
const [comments,installments]=await Promise.all([
fetch(`${API}/finance/invoices/${id}/comments`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]),
fetch(`${API}/finance/invoices/${id}/installments`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]),
]);
financeCommentsCache=comments;
const statutOptionsHtml=(meta.financeInternalStatuses||[]).map(s=>`<option value="${s}" ${s===inv.internalStatus?'selected':''}>${FINANCE_STATUS_LABEL[s]||s}</option>`).join('');
// État du formulaire "nouvelle échéance" (pastille de statut, cf. plus
// haut) — remis au premier statut de la liste à chaque ouverture de fiche.
financeNewInstallmentStatusId=financeInstallmentStatuses[0]?financeInstallmentStatuses[0].id:null;
const newInstallmentStatusPillHtml=financeStatusPillHtml(financeNewInstallmentStatusId,(statusId)=>{financeNewInstallmentStatusId=statusId;});
document.getElementById('modal-body').innerHTML=`
<div class="finance-detail-section">
<div class="form-group" style="margin-bottom:8px">
<div class="form-label">Client</div>
<div style="font-size:13px">${inv.customerName||'—'}</div>
<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${inv.contactName?`${inv.contactName} · `:''}${inv.contactEmail||inv.customerEmail||''}${(inv.contactPhone||inv.customerPhone)?` · ${inv.contactPhone||inv.customerPhone}`:''}</div>
${financeClientSnapshotHtml(inv)}
</div>
<div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin-bottom:10px">
<div><div class="form-label">Émission</div>${formatDateFR(inv.dateEmission)}</div>
<div><div class="form-label">Montant HT</div>${fmtCA(inv.amountHt)}</div>
<div><div class="form-label">Montant TTC</div>${fmtCA(inv.amountTtc)}</div>
<div><div class="form-label">Restant dû HT</div>${fmtCA(inv.remainingAmountHt)}</div>
<div><div class="form-label">Restant dû TTC</div><strong style="color:var(--accent)">${fmtCA(inv.remainingAmountTtc)}</strong></div>
</div>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
<button class="btn-secondary" onclick="viewFinanceInvoicePdf('${id}')">📄 Voir le PDF</button>
<select class="form-select" style="max-width:200px;color:${FINANCE_STATUS_COLOR[inv.internalStatus]||'inherit'}" onchange="patchFinanceInvoice('${id}',{internalStatus:this.value})">${statutOptionsHtml}</select>
</div>
</div>
<div class="finance-detail-section">
<div class="form-label">Commentaires</div>
<div style="display:flex;gap:8px;margin:6px 0 8px">
<input class="form-input" id="finance-comment-input" placeholder="Ajouter un commentaire…">
<button class="btn-primary" style="white-space:nowrap" onclick="submitFinanceComment('${id}')">+ Ajouter</button>
</div>
<div id="finance-comments-list">${financeCommentsListHtml(id,comments)}</div>
</div>
<div class="finance-detail-section">
<div class="form-label">Échéances de paiement</div>
<div id="finance-installments-list">${financeInstallmentsListHtml(id,installments,inv)}</div>
<div class="form-label" style="margin-top:10px;font-size:11px">Ajouter l'échéance ${financeProchainNumeroEcheance(inv,installments)}</div>
<div style="display:flex;gap:8px;margin:6px 0 8px;flex-wrap:wrap">
<input class="form-input" id="finance-installment-label" placeholder="Libellé (optionnel)…" style="max-width:150px">
<input class="form-input" id="finance-installment-date" type="date">
<input class="form-input" id="finance-installment-amount" type="number" step="0.01" placeholder="Montant €" style="max-width:110px">
${newInstallmentStatusPillHtml}
<button class="btn-primary" style="white-space:nowrap" onclick="submitFinanceInstallment('${id}')">+ Ajouter</button>
</div>
</div>
`;
}
// Snapshot risque client dans la fiche détail : un décompte EN DIRECT sur nos
// propres factures suivies (jamais un score externe ou une évaluation IA) —
// n'affiche rien si ce client n'a pas d'autre facture ouverte en ce moment,
// pour ne pas polluer la fiche d'un encadré vide/inutile.
function financeClientSnapshotHtml(inv){
if(!inv.customerId)return '';
const others=financeInvoicesCache.filter(i=>i.customerId===inv.customerId&&i.id!==inv.id&&(!i.status||!FINANCE_HORS_RECOUVREMENT.includes(i.status)));
if(!others.length)return '';
const nbEnRetard=others.filter(i=>(i.daysLate||0)>0).length;
const nbLitige=others.filter(i=>i.internalStatus==='litige').length;
const montantTotal=others.reduce((s,i)=>s+(i.remainingAmountTtc!=null?i.remainingAmountTtc:(i.remainingAmount||0)),0);
return `<div class="finance-client-snapshot">
<div class="form-label">Ce client, en direct (hors cette facture)</div>
<div class="finance-client-snapshot-row">
<span><strong>${others.length}</strong> autre(s) facture(s) ouverte(s)</span>
<span style="${nbEnRetard?'color:#dc2626':''}"><strong>${nbEnRetard}</strong> en retard</span>
${nbLitige?`<span style="color:#dc2626"><strong>${nbLitige}</strong> en litige</span>`:''}
<span><strong>${fmtCA(montantTotal)}</strong> d'encours</span>
</div>
<div class="finance-client-snapshot-note">Décompte sur les factures suivies ici, pas un score externe.</div>
</div>`;
}
// Timestamp parsé explicitement en UTC (cf. parseSqliteUtc plus haut) — corrige
// le bug de décalage horaire signalé par Lina (un commentaire posté à 14h32
// heure de Paris s'affichait "12:32" faute d'indicateur de fuseau sur le
// timestamp SQLite).
// Modification des commentaires (09/2026, demande Lina) : ouverte à tout
// compte finance/admin, sans restriction de personnes — cf. le bouton
// "Modifier" ci-dessous et PATCH /api/finance/invoices/:id/comments/:commentId
// côté serveur. Le texte brut est repris depuis financeCommentsCache (jamais
// ré-injecté depuis le HTML déjà échappé) pour ne pas avoir à gérer l'échappement
// des guillemets/apostrophes dans un attribut HTML.
function financeCommentsListHtml(invoiceId,comments){
if(!comments.length)return '<div class="idea-box-empty">Aucun commentaire pour l’instant</div>';
return comments.map(c=>financeCommentRowHtml(invoiceId,c)).join('');
}
function financeCommentRowHtml(invoiceId,c){
const modifie=c.updated_at?' · <em>modifié</em>':'';
return `<div class="finance-relance-entry" id="finance-comment-${c.id}">
<div>${(c.comment||'').replace(/</g,'&lt;')}</div>
<div class="finance-relance-meta" style="display:flex;align-items:center;gap:8px">
<span>${c.auteur||'—'} · ${(parseSqliteUtc(c.created_at)||new Date(c.created_at)).toLocaleString('fr-FR')}${modifie}</span>
<button type="button" class="btn-secondary" style="margin-left:auto;font-size:11px;padding:3px 8px" onclick="startEditFinanceComment('${invoiceId}',${c.id})">Modifier</button>
<button type="button" class="btn-secondary" style="font-size:11px;padding:3px 8px" onclick="deleteFinanceComment('${invoiceId}',${c.id})">Supprimer</button>
</div>
</div>`;
}
function financeCommentRowEditHtml(invoiceId,c){
return `<div class="finance-relance-entry" id="finance-comment-${c.id}">
<div style="display:flex;gap:8px;align-items:flex-start">
<input class="form-input" id="finance-comment-edit-input-${c.id}" style="flex:1">
<button class="btn-primary" style="white-space:nowrap" onclick="saveFinanceComment('${invoiceId}',${c.id})">Enregistrer</button>
<button class="btn-secondary" style="white-space:nowrap" onclick="cancelEditFinanceComment('${invoiceId}',${c.id})">Annuler</button>
</div>
</div>`;
}
function startEditFinanceComment(invoiceId,commentId){
const el=document.getElementById(`finance-comment-${commentId}`);
const c=financeCommentsCache.find(x=>x.id===commentId);
if(!el||!c)return;
el.outerHTML=financeCommentRowEditHtml(invoiceId,c);
const input=document.getElementById(`finance-comment-edit-input-${commentId}`);
input.value=c.comment||''; // valeur posée en JS (pas dans l'attribut HTML) pour éviter tout souci d'échappement
input.focus();
}
function cancelEditFinanceComment(invoiceId,commentId){
const el=document.getElementById(`finance-comment-${commentId}`);
const c=financeCommentsCache.find(x=>x.id===commentId);
if(!el||!c)return;
el.outerHTML=financeCommentRowHtml(invoiceId,c);
}
async function saveFinanceComment(invoiceId,commentId){
const input=document.getElementById(`finance-comment-edit-input-${commentId}`);
const comment=input.value.trim();
if(!comment)return;
try{
const r=await fetch(`${API}/finance/invoices/${invoiceId}/comments/${commentId}`,{method:'PATCH',headers:financeHeaders(true),body:JSON.stringify({comment})});
const updated=await r.json();
if(!r.ok)throw new Error(updated.error||'Impossible de modifier le commentaire');
const idx=financeCommentsCache.findIndex(x=>x.id===commentId);
if(idx>=0)financeCommentsCache[idx]=updated;
document.getElementById(`finance-comment-${commentId}`).outerHTML=financeCommentRowHtml(invoiceId,updated);
}catch(e){ showToast(e.message||'Impossible de modifier le commentaire','error'); }
}
// Suppression d'un commentaire (demande Lina 24/09/2026, bouton "Supprimer" à
// côté de "Modifier" — cf. financeCommentRowHtml). Même modèle que les autres
// suppressions de l'outil (échéances, cf. deleteFinanceInstallment) : pas de
// popup de confirmation, cohérent avec le reste de l'app.
async function deleteFinanceComment(invoiceId,commentId){
try{
const r=await fetch(`${API}/finance/invoices/${invoiceId}/comments/${commentId}`,{method:'DELETE',headers:financeHeaders()});
if(!r.ok&&r.status!==204){
const d=await r.json().catch(()=>({}));
throw new Error(d.error||'Impossible de supprimer le commentaire');
}
const idx=financeCommentsCache.findIndex(x=>x.id===commentId);
if(idx>=0)financeCommentsCache.splice(idx,1);
document.getElementById('finance-comments-list').innerHTML=financeCommentsListHtml(invoiceId,financeCommentsCache);
}catch(e){ showToast(e.message||'Impossible de supprimer le commentaire','error'); }
}
// Liste fusionnée des échéances (09/2026, demande Lina, confirmée) : la 1ère
// ligne est désormais l'échéance 1 (= inv.deadline/inv.deadlineStatusId,
// PATCH sur /api/finance/invoices/:id comme avant — le modèle de données ne
// change pas, seule la présentation devient une liste unique), suivie des
// échéances 2/3/4 comme avant (finance_invoice_installments). Le bouton
// "supprimer" est absent sur la 1ère ligne : une facture a toujours une
// échéance principale, "supprimer" n'a pas de sens pour elle.
// Acomptes / échéances saisis dans Pennylane (lus dans la mention spéciale de la
// facture, 13/10/2026). Lecture seule : pour les modifier, on modifie la facture
// dans Pennylane. L'état (soldé / en retard…) est calculé à partir du restant dû.
function pennylaneAcomptesHtml(inv){
const data=inv&&inv.echeancesPennylane;
if(!data||(!(data.acomptes||[]).length&&!(data.alertes||[]).length))return '';
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ETAT={soldee:['Soldé','#16a34a'],partielle:['Partiellement réglé','#d97706'],en_retard:['En retard','#dc2626'],a_venir:['À venir','#64748b'],inconnu:['État inconnu','#64748b']};
const lignes=(data.acomptes||[]).map((a)=>{
const [lib,col]=ETAT[a.etat]||ETAT.inconnu;
const nom=a.type==='solde'?'Solde':(a.rang===1?'1er ':a.rang+'e ')+(a.type==='acompte'?'acompte':'échéance');
const detail=a.etat==='partielle'||(a.etat==='en_retard'&&a.regle>0)?' · réglé '+fmtCA(a.regle)+' / reste '+fmtCA(a.resteAPayer):(a.etat==='en_retard'?' · reste '+fmtCA(a.resteAPayer):'');
const alerte=a.alerte?'<div style="font-size:11px;color:#b45309;margin-top:2px">⚠ '+esc(a.alerte)+' — à corriger dans Pennylane</div>':'';
return '<div class="finance-installment-row" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--border,#e5e7eb)">'
+'<strong style="font-size:12px">'+esc(nom)+'</strong>'
+'<span style="font-size:12px">'+(a.date?formatDateFR(a.date):'date ?')+' · '+(a.montant!=null?fmtCA(a.montant):'montant ?')+esc(detail)+'</span>'
+'<span style="margin-left:auto;font-size:11px;font-weight:600;color:'+col+'">'+lib+'</span>'
+'<div style="flex-basis:100%;font-size:10px;color:var(--text-muted)">Source : Pennylane</div>'+alerte+'</div>';
}).join('');
const alertes=(data.alertes||[]).map((x)=>'<div style="font-size:11px;color:#b45309">⚠ '+esc(x)+'</div>').join('');
return '<div class="finance-pennylane-acomptes" style="margin:4px 0 8px">'+lignes+alertes+'</div>';
}
// Échéance 1 = date d'échéance de la facture. Elle n'est affichée dans la liste
// que lorsqu'elle a été « rentrée » : date modifiée à la main, statut posé, ou
// échéances suivantes déjà saisies (demande Lina 13/10/2026). Sinon la première
// échéance se saisit directement dans le formulaire « Ajouter l'échéance 1 ».
function financeEcheance1Saisie(inv,installments){
if(!inv)return false;
if(((inv.echeancesPennylane&&inv.echeancesPennylane.acomptes)||[]).length)return false;
return !!(inv.deadlineManual||inv.deadlineStatusId!=null||(installments||[]).length);
}
function financeProchainNumeroEcheance(inv,installments){
const pl=((inv&&inv.echeancesPennylane&&inv.echeancesPennylane.acomptes)||[]).length;
if(pl)return pl+(installments||[]).length+1;
return financeEcheance1Saisie(inv,installments)?(installments||[]).length+2:1;
}
function financeInstallmentsListHtml(invoiceId,installments,inv){
const acomptesPl=(inv&&inv.echeancesPennylane&&inv.echeancesPennylane.acomptes)||[];
const autresMontant=(installments||[]).reduce((s,x)=>s+(Number(x.amount)||0),0);
const ech1=financeEcheance1Saisie(inv,installments)?[{
isEcheance1:true,
dueDate:inv.deadline,
amount:Math.max(0,Math.round(((Number(inv.amountTtc)||0)-autresMontant)*100)/100),
solde:inv.remainingAmountTtc!=null?inv.remainingAmountTtc:(inv.remainingAmount||0),
statusId:inv.deadlineStatusId,
statusColor:inv.deadlineStatusColor,
statusLabel:inv.deadlineStatusLabel,
}]:[];
const rows=[...ech1,...(installments||[])];
const plHtml=pennylaneAcomptesHtml(inv);
if(!rows.length)return plHtml||'<div class="idea-box-empty">Aucune échéance.</div>';
return plHtml+rows.map((inst,idx)=>{
const numero=acomptesPl.length+idx+(ech1.length?1:2);
const label=inst.isEcheance1?'Échéance 1':('Échéance '+numero+(inst.label&&!/^\s*(é|e)ch(é|e)ance\s*\d+\s*$/i.test(inst.label)?' · '+inst.label:''));
const dateHtml=inst.isEcheance1
? `<input type="date" class="form-input finance-deadline-input" style="max-width:130px;margin-left:6px" value="${inst.dueDate||''}" onchange="patchFinanceInvoice('${invoiceId}',{deadline:this.value})">`
: ` ${formatDateFR(inst.dueDate)} · ${fmtCA(inst.amount)}`;
const deleteBtn=inst.isEcheance1?'':`<button class="btn-secondary" style="font-size:11px;padding:3px 8px;margin-left:auto" onclick="deleteFinanceInstallment('${invoiceId}',${inst.id})">✕</button>`;
const statusPill=inst.isEcheance1
? financeStatusPillHtml(inst.statusId,(statusId)=>patchFinanceInvoice(invoiceId,{deadlineStatusId:statusId}))
: financeStatusPillHtml(inst.statusId,(statusId)=>patchFinanceInstallment(invoiceId,inst.id,{statusId}));
const paidField=inst.isEcheance1?'':`<label class="finance-installment-paid-field">Réglé <input type="number" class="form-input" step="0.01" min="0" style="max-width:100px" value="${inst.paidAmount||0}" onchange="patchFinanceInstallment('${invoiceId}',${inst.id},{paidAmount:this.value})"></label>`;
// Le "X € restant" en rouge à droite de chaque échéance a été retiré
// (demande Lina 24/09/2026) — le "Soldée" en vert reste affiché quand
// l'échéance est intégralement réglée, seul le compteur rouge disparaît.
const soldeLabel=(inst.isEcheance1||inst.solde>0)
? '' // le restant dû de l'échéance 1 est déjà affiché plus haut dans la fiche (Restant dû TTC)
: `<span style="font-size:12px;font-weight:600;color:var(--green)">Soldée</span>`;
return `<div class="finance-installment-row">
<div class="finance-installment-row-top">
<span class="finance-installment-dot" style="background:${inst.statusColor||'var(--text-muted)'}"></span>
<span>${label?`${label} — `:''}${dateHtml}</span>
${deleteBtn}
</div>
<div class="finance-installment-row-fields">
${statusPill}
${paidField}
${soldeLabel}
</div>
</div>`;
}).join('');
}
async function viewFinanceInvoicePdf(id){
try{
const r=await fetch(`${API}/finance/invoices/${id}/pdf`,{headers:financeHeaders()});
const d=await r.json();
if(!r.ok)throw new Error(d.error||'PDF indisponible');
window.open(d.url,'_blank');
}catch(e){ showToast(e.message||'Impossible de récupérer le PDF','error'); }
}
async function submitFinanceComment(id){
const input=document.getElementById('finance-comment-input');
const comment=input.value.trim();
if(!comment)return;
await fetch(`${API}/finance/invoices/${id}/comments`,{method:'POST',headers:financeHeaders(true),body:JSON.stringify({comment})});
input.value='';
const comments=await fetch(`${API}/finance/invoices/${id}/comments`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]);
financeCommentsCache=comments;
document.getElementById('finance-comments-list').innerHTML=financeCommentsListHtml(id,comments);
}
async function submitFinanceInstallment(id){
const label=document.getElementById('finance-installment-label').value.trim();
const dueDate=document.getElementById('finance-installment-date').value;
const amount=Number(document.getElementById('finance-installment-amount').value);
const statusId=financeNewInstallmentStatusId;
if(!dueDate){ showToast('Date d’échéance requise','error'); return; }
const invCache=financeInvoicesCache.find(i=>i.id===id);
if(invCache&&financeProchainNumeroEcheance(invCache,invCache.installments)===1){
// Échéance 1 = date d'échéance de la facture (montant = TTC moins les échéances suivantes).
document.getElementById('finance-installment-label').value='';
document.getElementById('finance-installment-date').value='';
document.getElementById('finance-installment-amount').value='';
await patchFinanceInvoice(id,{deadline:dueDate,deadlineStatusId:statusId});
return;
}
if(!amount||amount<=0){ showToast('Montant invalide','error'); return; }
const r=await fetch(`${API}/finance/invoices/${id}/installments`,{method:'POST',headers:financeHeaders(true),body:JSON.stringify({label,dueDate,amount,statusId})});
const d=await r.json();
if(!r.ok){ showToast(d.error||'Échec de l’ajout','error'); return; }
document.getElementById('finance-installment-label').value='';
document.getElementById('finance-installment-date').value='';
document.getElementById('finance-installment-amount').value='';
// Recharge la facture (perf 09/2026, cf. refreshOneFinanceInvoice) : la
// nouvelle échéance doit remonter dans les colonnes Éch. 2/3/4 du tableau
// derrière le modal.
await refreshOneFinanceInvoice(id);
openFinanceInvoiceDetail(id);
}
// Édition d'une échéance existante (statut et/ou montant réglé).
async function patchFinanceInstallment(invoiceId,installmentId,patch){
try{
const res=await fetch(`${API}/finance/invoices/${invoiceId}/installments/${installmentId}`,{method:'PATCH',headers:financeHeaders(true),body:JSON.stringify(patch)});
if(!res.ok){ const err=await res.json().catch(()=>({})); throw new Error(err.error||'Échec de la mise à jour'); }
// Valider une échéance (statut "compte comme réglée") peut faire glisser la
// référence de retard sur l'échéance suivante et faire basculer la facture
// en "Soldée" côté serveur — le nouveau GET /finance/invoices/:id (perf
// 09/2026) renvoie déjà cet état recalculé pour cette seule facture, plus
// besoin d'un fetch complet des ~2000 factures.
await refreshOneFinanceInvoice(invoiceId);
if(financeSelectedInvoiceId===invoiceId)openFinanceInvoiceDetail(invoiceId);
}catch(e){ showToast(e.message||'Échec de la mise à jour','error'); }
}
async function deleteFinanceInstallment(invoiceId,installmentId){
await fetch(`${API}/finance/invoices/${invoiceId}/installments/${installmentId}`,{method:'DELETE',headers:financeHeaders()});
await refreshOneFinanceInvoice(invoiceId);
openFinanceInvoiceDetail(invoiceId);
}

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────
(async function bootstrap(){
const ok=await tryAutoLogin();
if(!ok){
document.getElementById('pin-screen').style.display='flex';
document.getElementById('commercial-email')?.focus();
}
})();
