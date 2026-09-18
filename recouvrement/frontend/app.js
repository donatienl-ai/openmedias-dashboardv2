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
function redirectAwayIfNotAllowed(accountRole){
  if(accountRole==='admin'||accountRole==='finance')return false;
  if(accountRole==='edito'||accountRole==='communication'){ window.location.href='/planning'; return true; }
  window.location.href='/';
  return true;
}

function activateSession(d){
  isAccountAdmin = d.accountRole==='admin';
  commercialId=d.commercial_id; commercialNom=d.nom||'';
  localStorage.setItem('commercialId',commercialId); localStorage.setItem('commercialNom',commercialNom);
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
    if(redirectAwayIfNotAllowed(d.accountRole))return true;
    activateSession(d);
    return true;
  }catch{
    // Compte supprimé/désactivé depuis, ou rôle non autorisé ici : on nettoie
    // pour retomber proprement sur l'écran de connexion.
    localStorage.removeItem('commercialId'); localStorage.removeItem('commercialNom');
    commercialId=null; commercialNom='';
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
      if(redirectAwayIfNotAllowed(d.accountRole))return;
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
  localStorage.removeItem('commercialId'); localStorage.removeItem('commercialNom');
  commercialId=null; commercialNom='';
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
//    page reste autonome sans dépendre du reste du planning) ─────────────────
function closeModal(event){if(event&&event.target!==document.getElementById('modal-overlay'))return;document.getElementById('modal-overlay').style.display='none';}
function showToast(msg,type='success'){const el=document.createElement('div');el.className=`toast ${type}`;el.innerHTML=`<span>${type==='success'?'✅':'⚠️'}</span><span>${msg}</span>`;document.body.appendChild(el);setTimeout(()=>el.remove(),4000);}
function formatDateFR(str){if(!str)return '—';const[y,m,d]=str.split('-');return `${d}/${m}/${y}`;}
function fmtCA(v){return new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);}
function fmtCACompact(v){
  v=v||0;
  if(Math.abs(v)<10000)return fmtCA(v);
  return new Intl.NumberFormat('fr-FR',{notation:'compact',style:'currency',currency:'EUR',minimumFractionDigits:0,maximumFractionDigits:1}).format(v);
}

async function init(){
  meta=await fetch(`${API}/meta`).then(r=>r.json());
  await loadFinance();
}

// ── RECOUVREMENT (Pennylane) ─────────────────────────────────────────────────
// Pennylane reste la source de vérité facturation (l'app n'y écrit jamais) ;
// cette vue ajoute le suivi de recouvrement par-dessus (statut, historique de
// relances, KPI, commentaires, échéances personnalisées) — remplace l'Excel +
// Trello utilisés jusque-là.
const FINANCE_STATUS_LABEL={a_relancer:'À relancer',en_cours:'En cours',litige:'Litige',promesse_paiement:'Promesse de paiement',solde:'Soldée'};
const FINANCE_STATUS_COLOR={a_relancer:'var(--gold)',en_cours:'var(--accent)',litige:'#dc2626',promesse_paiement:'#0d9488',solde:'var(--green)'};
const FINANCE_CANAL_LABEL={email:'📧 Email',telephone:'📞 Téléphone',courrier:'✉️ Courrier',sms:'💬 SMS',autre:'Autre'};
let financeInvoicesCache=[];
let financeSelectedInvoiceId=null; // facture ouverte dans le modal de détail
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

// Sous-navigation Vue d'ensemble / Factures / Litiges — sépare la lecture
// (KPI + répartition par statut) de l'action (période/onglets/tableau), et
// donne aux litiges leur propre vue plutôt que noyés dans le tableau général
// filtré par statut interne (relevé dans l'audit UX).
let financeSubview='overview';
function setFinanceSubview(key){
  financeSubview=key;
  document.querySelectorAll('.finance-subnav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===key));
  document.getElementById('finance-view-overview').style.display=key==='overview'?'':'none';
  document.getElementById('finance-view-factures').style.display=key==='factures'?'':'none';
  document.getElementById('finance-view-litiges').style.display=key==='litiges'?'':'none';
  if(key==='litiges')renderFinanceLitiges();
}
// Badge du nombre de litiges en cours sur l'onglet lui-même — mis à jour à
// chaque refresh du cache (synchro, ou changement de statut interne d'une
// facture) sans attendre que l'utilisateur ouvre la vue Litiges.
function updateFinanceLitigesBadge(){
  const badge=document.getElementById('finance-subnav-litiges-count');
  if(!badge)return;
  const n=financeInvoicesCache.filter(i=>i.internalStatus==='litige').length;
  badge.textContent=n;
  badge.parentElement.classList.toggle('litiges-empty',n===0);
  if(financeSubview==='litiges')renderFinanceLitiges();
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
let financePeriodTo=null;   // 'YYYY-MM-DD' ou null

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
function financeMatchesPeriod(inv){
  return invoiceInRange(inv,financePeriodFrom,financePeriodTo);
}
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
  const today=new Date(); today.setHours(0,0,0,0);
  const to=new Date(today.getTime()-86400000);
  const from=new Date(today.getTime()-30*86400000);
  return {from:from.toISOString().slice(0,10),to:to.toISOString().slice(0,10)};
}
function setFinancePeriodFrom(v){ financePeriodFrom=v||null; onFinancePeriodChange(); }
function setFinancePeriodTo(v){ financePeriodTo=v||null; onFinancePeriodChange(); }
function resetFinancePeriod(){
  financePeriodFrom=null; financePeriodTo=null;
  const f=document.getElementById('finance-period-from'), t=document.getElementById('finance-period-to');
  if(f)f.value=''; if(t)t.value='';
  onFinancePeriodChange();
}
function onFinancePeriodChange(){
  const resetBtn=document.getElementById('finance-period-reset');
  if(resetBtn)resetBtn.style.display=(financePeriodFrom||financePeriodTo)?'':'none';
  renderFinanceTabs();
  renderFinanceInvoices();
  renderFinanceKpis(computeFinanceKpisFromCache());
}

function financeHeaders(json){
  const h={'x-commercial-id':commercialId};
  if(json)h['Content-Type']='application/json';
  return h;
}
async function loadFinance(){
  await refreshFinanceInvoices();
}
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
  updateFinanceLitigesBadge();
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
// Statuts internes déjà "pris en charge" autrement qu'en relance active (même
// exclusion que côté back et que le digest mail quotidien) — un litige en
// cours ou une promesse de paiement obtenue n'attend pas une relance du jour.
const FINANCE_STATUTS_NON_ACTIONABLES=['litige','promesse_paiement','solde'];
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
  const parStatut={};
  for(const inv of unpaid){
    const remaining=inv.remainingAmountTtc!=null?inv.remainingAmountTtc:(inv.remainingAmount||0);
    totalEncours+=remaining;
    const statut=inv.internalStatus||'a_relancer';
    if(!parStatut[statut])parStatut[statut]={count:0,montant:0};
    parStatut[statut].count+=1; parStatut[statut].montant+=remaining;
    const daysLate=inv.daysLate;
    if(daysLate!=null&&daysLate>0){
      nbEnRetard+=1; montantEnRetard+=remaining;
      if(!FINANCE_STATUTS_NON_ACTIONABLES.includes(statut)){ nbActionable+=1; montantActionable+=remaining; }
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
    const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-90);
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
    totalEncours, montantEnRetard, nbFacturesEnRetard:nbEnRetard, nbFacturesTotal:unpaid.length,
    montantActionable, nbFacturesActionable:nbActionable, tauxDeRetard, dso, aging, parStatut,
    periodJours:periodDays,
  };
}
// Statuts bruts Pennylane (champ status de l'API) -> libellé FR, pour le
// repère de cohérence de synchro. Couvre tout ce qu'on a vu dans la doc
// Pennylane, y compris les statuts qu'on exclut du recouvrement (brouillon,
// avoir, annulée...) puisque le but ici est justement de vérifier qu'ils ont
// bien été ramenés par la synchro, pas de les filtrer.
const PENNYLANE_STATUS_LABEL={
  draft:'Brouillon', incomplete:'Incomplète', cancelled:'Annulée',
  partially_cancelled:'Partiellement annulée', paid:'Encaissée',
  partially_paid:'Partiellement encaissée', upcoming:'À venir', late:'En retard',
  credit_note:'Avoir', archived:'Archivée', proforma:'Proforma',
  shipping_order:'Bon de livraison', purchasing_order:'Bon de commande',
  estimate_pending:'Devis en attente', estimate_accepted:'Devis accepté',
  estimate_invoiced:'Devis facturé', estimate_denied:'Devis refusé',
  inconnu:'Sans statut',
};
let financeSyncOverviewOpen=false;
let financeKpisCache=null;
function toggleFinanceSyncOverview(){
  financeSyncOverviewOpen=!financeSyncOverviewOpen;
  renderFinanceSyncOverview(financeKpisCache);
}
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
// Donut SVG en pur CSS/SVG (pas de lib de charts) — technique du cercle de
// rayon 15.9155 dont la circonférence vaut ~100, pour poser des pourcentages
// directement en stroke-dasharray/dashoffset. Même esprit visuel que les
// donuts qu'on voit chez Kollekt/LeanPay pour la répartition par statut.
function financeStatutDonutSvg(segs){
  const R=15.9155;
  let acc=0;
  const arcs=segs.filter(s=>s.pct>0).map(s=>{
    const dashoffset=-acc;
    acc+=s.pct;
    return `<circle cx="18" cy="18" r="${R}" fill="none" stroke="${s.color}" stroke-width="4" stroke-dasharray="${s.pct} ${100-s.pct}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 18 18)"></circle>`;
  }).join('');
  return `<svg viewBox="0 0 36 36" class="finance-donut" role="img" aria-label="Répartition de l'encours par statut">
    <circle cx="18" cy="18" r="${R}" fill="none" stroke="var(--surface2)" stroke-width="4"></circle>
    ${arcs}
  </svg>`;
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
  const statutTotal=Object.values(parStatut).reduce((s,v)=>s+(v.montant||0),0);
  const nonActionable=(k.montantEnRetard||0)-(k.montantActionable||0);
  const prevBounds=financePreviousPeriodBounds();
  const prevK=prevBounds?computeFinanceKpisFromCache(prevBounds):null;
  const donutSegs=statutSegs.map(s=>({pct:statutTotal?((parStatut[s.key]||{}).montant||0)/statutTotal*100:0,color:s.color}));
  wrap.innerHTML=`
    <div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:var(--accent)"></span>Encours total</div><div class="kpi-val" title="${fmtCA(k.totalEncours)}">${fmtCACompact(k.totalEncours)}</div><div class="kpi-lbl">${k.nbFacturesTotal} facture(s) non soldée(s) ${financeKpiDeltaHtml(k.totalEncours,prevK?prevK.totalEncours:null)}</div></div>
    <div class="kpi-card" title="Hors factures soldées, annulées, ou suivies séparément (litige / promesse de paiement)"><div class="kpi-eyebrow"><span class="dot" style="background:#dc2626"></span>À relancer aujourd'hui ⓘ</div><div class="kpi-val" style="color:#dc2626" title="${fmtCA(k.montantActionable)}">${fmtCACompact(k.montantActionable)}</div><div class="kpi-lbl">${k.nbFacturesActionable} facture(s) en retard${nonActionable>0?` · ${fmtCA(nonActionable)} en litige/promesse (suivi à part)`:''} ${financeKpiDeltaHtml(k.montantActionable,prevK?prevK.montantActionable:null)}</div></div>
    <div class="kpi-card" title="Hors factures soldées, annulées, ou suivies séparément (litige / promesse de paiement)"><div class="kpi-eyebrow"><span class="dot" style="background:var(--gold)"></span>Taux de retard ⓘ</div><div class="kpi-val" style="color:var(--gold)">${k.tauxDeRetard}%</div><div class="kpi-lbl">Part de l'encours en retard (${k.nbFacturesEnRetard} facture(s))</div></div>
    <div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:#8b5cf6"></span>DSO</div><div class="kpi-val" style="color:#8b5cf6">${k.dso!=null?k.dso+'j':'—'}</div><div class="kpi-lbl">Délai moyen de paiement (${(financePeriodFrom||financePeriodTo)?`période sélectionnée, ${k.periodJours}j`:`${k.periodJours}j glissants`})</div></div>
    <div class="kpi-card" style="grid-column:1/-1">
      <div class="kpi-eyebrow"><span class="dot" style="background:var(--text-muted)"></span>Répartition de l'encours par statut</div>
      <div class="finance-donut-row">
        <div class="finance-donut-wrap">
          ${financeStatutDonutSvg(donutSegs)}
          <div class="finance-donut-center"><div class="finance-donut-center-val">${fmtCACompact(statutTotal)}</div><div class="finance-donut-center-lbl">encours</div></div>
        </div>
        <div class="finance-aging-legend">${statutSegs.filter(s=>(parStatut[s.key]||{}).count).map(s=>`<span><span class="dot" style="background:${s.color}"></span>${s.label} — ${(parStatut[s.key]||{}).count} · ${fmtCA((parStatut[s.key]||{}).montant||0)}</span>`).join('')}</div>
      </div>
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
// Badge "Dernière relance il y a Xj" sous le n° de facture — répond à
// "est-ce que quelqu'un a déjà relancé ce client récemment" sans avoir à
// ouvrir la fiche (audit UX v2, B4). N'apparaît que pour les factures encore
// en jeu (une facture soldée/annulée n'a plus besoin de ce signal).
function financeLastRelanceBadge(inv){
  const resolved=inv.internalStatus==='solde'||FINANCE_STATUSES_SOLDEES.includes(inv.status);
  if(resolved)return '';
  if(!inv.lastRelanceAt)return '<div class="finance-relance-badge never">Jamais relancée</div>';
  const days=Math.floor((Date.now()-new Date(inv.lastRelanceAt).getTime())/86400000);
  if(days<=0)return '<div class="finance-relance-badge recent">Relancée aujourd\'hui</div>';
  return `<div class="finance-relance-badge${days>14?' stale':''}">Relancée il y a ${days}j</div>`;
}
function financeRetardBarHtml(inv){
  const daysLate=inv.daysLate;
  const remaining=inv.remainingAmountTtc!=null?inv.remainingAmountTtc:inv.remainingAmount;
  // Priorité au statut (interne 'solde', ou Pennylane paid/annulée/avoir) sur
  // le montant restant : une facture encaissée peut garder un remaining_amount
  // non nul côté Pennylane, et afficher "Xj de retard" en rouge sur une
  // facture déjà marquée Soldée à côté serait contradictoire.
  const resolved=inv.internalStatus==='solde'||FINANCE_STATUSES_SOLDEES.includes(inv.status);
  if(resolved||(remaining||0)<=0)return '<span style="font-size:11px;color:var(--text-muted)">Soldée</span>';
  if(daysLate==null)return '<span style="font-size:11px;color:var(--text-muted)">—</span>';
  if(daysLate<=0){
    const emission=inv.dateEmission?new Date(`${inv.dateEmission}T00:00:00`):null;
    const deadline=inv.deadline?new Date(`${inv.deadline}T00:00:00`):null;
    let pct=0;
    if(emission&&deadline&&deadline>emission){
      pct=Math.max(0,Math.min(100,((Date.now()-emission)/(deadline-emission))*100));
    }
    return `<div class="finance-retard-wrap"><div class="finance-retard-bar"><div class="finance-retard-fill" style="width:${pct}%;background:var(--accent)"></div></div><div class="finance-retard-label">${-daysLate}j avant échéance</div></div>`;
  }
  const pct=Math.max(6,Math.min(100,(daysLate/90)*100));
  return `<div class="finance-retard-wrap"><div class="finance-retard-bar"><div class="finance-retard-fill" style="width:${pct}%;background:#dc2626"></div></div><div class="finance-retard-label" style="color:#dc2626;font-weight:700">${daysLate}j de retard</div></div>`;
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
  paid: {bg:'var(--green-dim)', fg:'var(--green)'},
  partially_paid: {bg:'rgba(13,148,136,0.12)', fg:'#0d9488'},
  cancelled: {bg:'var(--surface2)', fg:'var(--text-dim)'},
  credit_note: {bg:'rgba(139,92,246,0.14)', fg:'#8b5cf6'},
  archived: {bg:'var(--surface2)', fg:'var(--text-muted)'},
};
// Test d'UNE facture contre UN chip donné (utilisé pour les compteurs par
// chip, et comme brique de financeMatchesFilters ci-dessous).
function financeMatchesFilterKey(inv,key){
  if(key==='all')return true;
  const statuses=PENNYLANE_TAB_STATUSES[key];
  return statuses?statuses.includes(inv.status):false;
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
    ${chip('paid','Encaissée')}
    ${chip('partially_paid','Part. encaissée','Partiellement encaissée')}
    ${chip('cancelled','Annulée')}
    ${chip('credit_note','Avoir')}
    ${chip('archived','Archivée')}
  `;
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
  const q=(document.getElementById('finance-search')?.value||'').trim().toLowerCase();
  let list=financeInvoicesCache.filter(inv=>{
    if(!financeMatchesPeriod(inv))return false;
    if(!financeMatchesFilters(inv,financeActiveFilters))return false;
    if(q&&!(String(inv.invoiceNumber||'').toLowerCase().includes(q)||inv.customerName.toLowerCase().includes(q)||(inv.contactName||'').toLowerCase().includes(q)))return false;
    return true;
  });
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
    <thead><tr><th>Facture</th><th>Entreprise</th><th>Nom Prénom</th><th>Mail</th><th>Téléphone</th><th class="sortable-th" onclick="setFinanceSort('deadline')">Échéance${financeSortArrow('deadline')}</th><th class="sortable-th" onclick="setFinanceSort('retard')">Retard${financeSortArrow('retard')}</th><th>Montant HT</th><th class="sortable-th" onclick="setFinanceSort('montant')">Montant TTC${financeSortArrow('montant')}</th><th>Statut</th></tr></thead>
    <tbody>${list.map(inv=>`<tr>
      <td><button type="button" class="finance-invoice-link" onclick="openFinanceInvoiceDetail('${inv.id}')">${inv.invoiceNumber||inv.id}</button>${financeLastRelanceBadge(inv)}</td>
      <td>${inv.customerName||'—'}</td>
      <td>${inv.contactName||'—'}</td>
      <td>${inv.contactEmail||inv.customerEmail||'—'}</td>
      <td>${inv.contactPhone||inv.customerPhone||'—'}</td>
      <td><div class="finance-deadline-cell"><input type="date" class="form-input finance-deadline-input" value="${inv.deadline||''}" onchange="patchFinanceInvoice('${inv.id}',{deadline:this.value})" title="${inv.deadlineManual?'Échéance corrigée manuellement — ne sera plus écrasée par la synchro Pennylane':'Échéance Pennylane'}">${inv.deadlineManual?'<span class="finance-deadline-manual-dot" title="Corrigée manuellement">✎</span>':''}</div></td>
      <td>${financeRetardBarHtml(inv)}</td>
      <td>${fmtCA(inv.remainingAmountHt!=null?inv.remainingAmountHt:inv.amountHt)}</td>
      <td style="font-weight:600;color:var(--accent)">${fmtCA(inv.remainingAmountTtc!=null?inv.remainingAmountTtc:inv.remainingAmount)}</td>
      <td><select class="form-select finance-inline-select" style="color:${FINANCE_STATUS_COLOR[inv.internalStatus]||'inherit'}" onchange="patchFinanceInvoice('${inv.id}',{internalStatus:this.value})">${statutOptionsHtml(inv)}</select></td>
    </tr>`).join('')}</tbody>
  </table>`;
}
// Vue dédiée "Litiges" — un snapshot en direct des factures actuellement en
// statut interne litige, pas une file d'attente triée par ancienneté (on ne
// garde pas de date de passage en litige, donc pas de tri honnête possible
// par "depuis quand" — cf. le bandeau d'avertissement au-dessus du tableau).
function renderFinanceLitiges(){
  const wrap=document.getElementById('finance-litiges-table');
  if(!wrap)return;
  const list=financeInvoicesCache.filter(inv=>inv.internalStatus==='litige');
  if(!list.length){
    wrap.innerHTML='<div class="idea-box-empty" style="padding:24px 0">Aucun litige en cours 🎉</div>';
    return;
  }
  wrap.innerHTML=`<table>
    <thead><tr><th>Facture</th><th>Entreprise</th><th>Contact</th><th>Échéance</th><th>Retard</th><th>Montant TTC</th><th></th></tr></thead>
    <tbody>${list.map(inv=>`<tr>
      <td><button type="button" class="finance-invoice-link" onclick="openFinanceInvoiceDetail('${inv.id}')">${inv.invoiceNumber||inv.id}</button></td>
      <td>${inv.customerName||'—'}</td>
      <td>${inv.contactName||inv.contactEmail||inv.customerEmail||'—'}</td>
      <td>${formatDateFR(inv.deadline)}</td>
      <td>${financeRetardBarHtml(inv)}</td>
      <td style="font-weight:600;color:#dc2626">${fmtCA(inv.remainingAmountTtc!=null?inv.remainingAmountTtc:inv.remainingAmount)}</td>
      <td><button class="btn-secondary" style="font-size:11px;padding:4px 10px" onclick="openFinanceInvoiceDetail('${inv.id}')">Ouvrir</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}
// Jours de retard recalculés en LOCAL après une correction d'échéance, pour
// rafraîchir tri/KPI/barre de retard sans attendre un refetch complet —
// même formule que joursDeRetard() côté back (router.js).
function financeJoursDeRetard(deadline){
  if(!deadline)return null;
  const d=new Date(`${deadline}T00:00:00`);
  if(Number.isNaN(d.getTime()))return null;
  const today=new Date(); today.setHours(0,0,0,0);
  return Math.round((today-d)/86400000);
}
async function patchFinanceInvoice(id,patch){
  try{
    const res=await fetch(`${API}/finance/invoices/${id}`,{method:'PATCH',headers:financeHeaders(true),body:JSON.stringify(patch)});
    if(!res.ok){ const err=await res.json().catch(()=>({})); throw new Error(err.error||'Échec de la mise à jour'); }
    const updated=await res.json(); // ligne pennylane_invoices brute (snake_case)
    const idx=financeInvoicesCache.findIndex(i=>i.id===id);
    if(idx!==-1){
      const inv=financeInvoicesCache[idx];
      if(patch.internalStatus!==undefined)inv.internalStatus=updated.internal_status;
      if(patch.deadline!==undefined){
        // Ne recalcule QUE ce qui dépend de la date (retard, tri, KPI) — le
        // montant dû n'est jamais touché par une correction d'échéance. La
        // barre d'onglets Pennylane (statut brut `status`), elle, reste
        // volontairement figée sur ce que Pennylane a calculé au dernier
        // sync : ce n'est pas à nous de la recalculer localement (cf. la
        // règle "onglets = miroir exact de Pennylane, jamais de logique
        // maison" posée pour cette barre).
        inv.deadline=updated.deadline;
        inv.deadlineManual=!!updated.deadline_manual;
        inv.daysLate=financeJoursDeRetard(inv.deadline);
      }
    }
    renderFinanceTabs();
    renderFinanceInvoices();
    renderFinanceKpis(computeFinanceKpisFromCache());
    updateFinanceLitigesBadge();
    if(financeSelectedInvoiceId===id)openFinanceInvoiceDetail(id);
    showToast('Facture mise à jour');
  }catch(e){ showToast(e.message||"Échec de la mise à jour",'error'); }
}
async function syncFinance(){
  const btn=document.getElementById('finance-sync-btn');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Synchronisation…'; }
  try{
    const r=await fetch(`${API}/finance/sync`,{method:'POST',headers:financeHeaders()});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Échec de la synchro');
    document.getElementById('finance-last-sync').textContent=`Dernière synchro : ${new Date(d.syncedAt).toLocaleString('fr-FR')} (${d.invoicesSynced} facture(s), ${d.customersSynced} client(s))`;
    showToast('Synchro Pennylane effectuée');
    await refreshFinanceInvoices();
  }catch(e){
    showToast(e.message||'Échec de la synchro Pennylane','error');
  }finally{
    if(btn){ btn.disabled=false; btn.textContent='↻ Synchroniser Pennylane'; }
  }
}
// ── Modal de détail facture : infos + PDF + statut + commentaires + échéances + relances ──
// "Relances" = l'historique des actions de recouvrement déjà menées auprès du
// client (un appel, un email, un courrier...) pour cette facture — ça sert à
// garder une trace de qui a fait quoi et quand, pour ne pas relancer deux fois
// la même semaine ou perdre le fil si quelqu'un d'autre reprend le dossier.
// C'est un JOURNAL D'ACTIONS envers le client, à distinguer des "commentaires"
// juste en dessous qui sont des notes internes (jamais envoyées au client).
async function openFinanceInvoiceDetail(id){
  financeSelectedInvoiceId=id;
  const inv=financeInvoicesCache.find(i=>i.id===id);
  if(!inv)return;
  document.getElementById('modal-title').textContent=`Facture ${inv.invoiceNumber||inv.id}`;
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML='<div style="font-size:12px;color:var(--text-muted)">Chargement…</div>';
  document.getElementById('modal-footer').innerHTML=`<button class="btn-secondary" onclick="closeModal()">Fermer</button>`;
  const [relances,comments,installments]=await Promise.all([
    fetch(`${API}/finance/invoices/${id}/relances`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]),
    fetch(`${API}/finance/invoices/${id}/comments`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]),
    fetch(`${API}/finance/invoices/${id}/installments`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]),
  ]);
  const statutOptionsHtml=(meta.financeInternalStatuses||[]).map(s=>`<option value="${s}" ${s===inv.internalStatus?'selected':''}>${FINANCE_STATUS_LABEL[s]||s}</option>`).join('');
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
        <div><div class="form-label">Échéance${inv.deadlineManual?' <span class="finance-deadline-manual-dot" title="Corrigée manuellement">✎</span>':''}</div><input type="date" class="form-input finance-deadline-input" style="margin-top:2px" value="${inv.deadline||''}" onchange="patchFinanceInvoice('${id}',{deadline:this.value})"></div>
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
      <div class="form-label">Commentaires (notes internes, jamais envoyées au client)</div>
      <div style="display:flex;gap:8px;margin:6px 0 8px">
        <input class="form-input" id="finance-comment-input" placeholder="Ajouter un commentaire…">
        <button class="btn-primary" style="white-space:nowrap" onclick="submitFinanceComment('${id}')">+ Ajouter</button>
      </div>
      <div id="finance-comments-list">${financeCommentsListHtml(comments)}</div>
    </div>

    <div class="finance-detail-section">
      <div class="form-label">Échéances de paiement</div>
      <div style="display:flex;gap:8px;margin:6px 0 8px;flex-wrap:wrap">
        <input class="form-input" id="finance-installment-label" placeholder="Libellé (optionnel)…" style="max-width:150px">
        <input class="form-input" id="finance-installment-date" type="date">
        <input class="form-input" id="finance-installment-amount" type="number" step="0.01" placeholder="Montant €" style="max-width:110px">
        <button class="btn-primary" style="white-space:nowrap" onclick="submitFinanceInstallment('${id}')">+ Ajouter</button>
      </div>
      <div id="finance-installments-list">${financeInstallmentsListHtml(id,installments)}</div>
    </div>

    <div class="finance-detail-section">
      <div class="info-banner neutral">💡 Les relances retracent les actions de recouvrement déjà menées auprès du client (appel, email, courrier…) — un journal partagé pour ne pas relancer deux fois ou perdre le fil si quelqu'un reprend le dossier. Elles ne modifient pas la facturation Pennylane.</div>
      <div class="form-label">Nouvelle relance</div>
      <div style="display:flex;gap:8px;margin:6px 0 8px">
        <select class="form-select" id="finance-relance-canal" style="max-width:160px">
          ${Object.entries(FINANCE_CANAL_LABEL).map(([k,l])=>`<option value="${k}">${l}</option>`).join('')}
        </select>
        <input class="form-input" id="finance-relance-note" placeholder="Note (optionnel)…">
        <button class="btn-primary" style="white-space:nowrap" onclick="submitFinanceRelance('${id}')">+ Ajouter</button>
      </div>
      <div class="form-label">Historique</div>
      <div id="finance-relances-list">${relances.length?relances.map(r=>`
        <div class="finance-relance-entry">
          <div>${FINANCE_CANAL_LABEL[r.canal]||r.canal}${r.note?` — ${r.note}`:''}</div>
          <div class="finance-relance-meta">${r.auteur||'—'} · ${new Date(r.created_at).toLocaleString('fr-FR')}</div>
        </div>`).join(''):'<div class="idea-box-empty">Aucune relance pour l’instant</div>'}</div>
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
function financeCommentsListHtml(comments){
  if(!comments.length)return '<div class="idea-box-empty">Aucun commentaire pour l’instant</div>';
  return comments.map(c=>`
    <div class="finance-relance-entry">
      <div>${(c.comment||'').replace(/</g,'&lt;')}</div>
      <div class="finance-relance-meta">${c.auteur||'—'} · ${new Date(c.created_at).toLocaleString('fr-FR')}</div>
    </div>`).join('');
}
function financeInstallmentsListHtml(invoiceId,installments){
  if(!installments.length)return '<div class="idea-box-empty">Aucune échéance personnalisée — la facture garde son échéance Pennylane unique.</div>';
  return installments.map(inst=>`
    <div class="finance-installment-row ${inst.paid?'paid':''}">
      <label style="display:flex;align-items:center;gap:6px;flex:1;cursor:pointer">
        <input type="checkbox" ${inst.paid?'checked':''} onchange="toggleFinanceInstallmentPaid('${invoiceId}',${inst.id},this.checked)">
        <span>${inst.label?`${inst.label} — `:''}${formatDateFR(inst.due_date)} · ${fmtCA(inst.amount)}</span>
      </label>
      <button class="btn-secondary" style="font-size:11px;padding:3px 8px" onclick="deleteFinanceInstallment('${invoiceId}',${inst.id})">✕</button>
    </div>`).join('');
}
async function viewFinanceInvoicePdf(id){
  try{
    const r=await fetch(`${API}/finance/invoices/${id}/pdf`,{headers:financeHeaders()});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'PDF indisponible');
    window.open(d.url,'_blank');
  }catch(e){
    showToast(e.message||'Impossible de récupérer le PDF','error');
  }
}
async function submitFinanceComment(id){
  const input=document.getElementById('finance-comment-input');
  const comment=input.value.trim();
  if(!comment)return;
  await fetch(`${API}/finance/invoices/${id}/comments`,{method:'POST',headers:financeHeaders(true),body:JSON.stringify({comment})});
  input.value='';
  const comments=await fetch(`${API}/finance/invoices/${id}/comments`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]);
  document.getElementById('finance-comments-list').innerHTML=financeCommentsListHtml(comments);
}
async function submitFinanceInstallment(id){
  const label=document.getElementById('finance-installment-label').value.trim();
  const dueDate=document.getElementById('finance-installment-date').value;
  const amount=Number(document.getElementById('finance-installment-amount').value);
  if(!dueDate){ showToast('Date d’échéance requise','error'); return; }
  if(!amount||amount<=0){ showToast('Montant invalide','error'); return; }
  const r=await fetch(`${API}/finance/invoices/${id}/installments`,{method:'POST',headers:financeHeaders(true),body:JSON.stringify({label,dueDate,amount})});
  const d=await r.json();
  if(!r.ok){ showToast(d.error||'Échec de l’ajout','error'); return; }
  document.getElementById('finance-installment-label').value='';
  document.getElementById('finance-installment-date').value='';
  document.getElementById('finance-installment-amount').value='';
  const installments=await fetch(`${API}/finance/invoices/${id}/installments`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]);
  document.getElementById('finance-installments-list').innerHTML=financeInstallmentsListHtml(id,installments);
}
async function toggleFinanceInstallmentPaid(invoiceId,installmentId,paid){
  await fetch(`${API}/finance/invoices/${invoiceId}/installments/${installmentId}`,{method:'PATCH',headers:financeHeaders(true),body:JSON.stringify({paid})});
}
async function deleteFinanceInstallment(invoiceId,installmentId){
  await fetch(`${API}/finance/invoices/${invoiceId}/installments/${installmentId}`,{method:'DELETE',headers:financeHeaders()});
  const installments=await fetch(`${API}/finance/invoices/${invoiceId}/installments`,{headers:financeHeaders()}).then(r=>r.json()).catch(()=>[]);
  document.getElementById('finance-installments-list').innerHTML=financeInstallmentsListHtml(invoiceId,installments);
}
async function submitFinanceRelance(id){
  const canal=document.getElementById('finance-relance-canal').value;
  const note=document.getElementById('finance-relance-note').value.trim();
  await fetch(`${API}/finance/invoices/${id}/relances`,{method:'POST',headers:financeHeaders(true),body:JSON.stringify({canal,note})});
  // Une relance peut avoir fait passer le statut interne de "à relancer" à
  // "en cours" côté serveur (cf. router.js) : on rafraîchit la liste derrière
  // le modal pour que le select de statut reflète ce changement au retour.
  await refreshFinanceInvoices();
  openFinanceInvoiceDetail(id);
}

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────
(async function bootstrap(){
  const ok=await tryAutoLogin();
  if(!ok){
    document.getElementById('pin-screen').style.display='flex';
    document.getElementById('commercial-email')?.focus();
  }
})();
