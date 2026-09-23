const API = 'api'; // relatif : fonctionne servi à la racine ou derrière un reverse-proxy sous /planning/
// Icône enveloppe en SVG inline plutôt qu'en emoji (✉️ ne s'affiche pas sur
// certaines combinaisons OS/police — ex: Chrome/Windows — et rend une case
// vide). Un SVG s'affiche à l'identique partout.
const ICON_MAIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>';
let role=null, myName=null, isCLevel=false, isAccountAdmin=false, canSeeBudget=false, currentMedia='TIME', currentDate=new Date();
let emissions=[], slotMap=[], joursBlockes=[], meta={};
let pinBuffer='', searchQuery='', bdcFilterActive=false;
let commercialId = localStorage.getItem('commercialId') || null;
let commercialNom = localStorage.getItem('commercialNom') || '';

// Traduit le rôle réel du compte (commercial_users.role) vers le modèle de
// rôle interne du planning ('edit'/'com'/'sales', hérité de l'ancien système
// PIN) — permet à un compte admin/édito/communication/manager/commercial
// d'obtenir les bonnes capacités, qu'il arrive par PIN, par login direct sur
// cette page, ou par SSO depuis OpenDashboard.
function planningRoleFor(accountRole){
  if(accountRole==='admin'||accountRole==='edito')return 'edit';
  if(accountRole==='communication')return 'com';
  // 'finance' n'atteint jamais cette fonction : intercepté et redirigé vers
  // /recouvrement avant activateSession (cf. tryAutoLogin/commercialLoginSubmit).
  return 'sales'; // manager, commercial, ou valeur inconnue -> par défaut le plus restreint
}
// Active la session applicative (affiche l'app, cache l'écran de connexion) de
// façon identique quel que soit le point d'entrée (PIN, login direct, SSO depuis
// le dashboard) — évite de dupliquer cette logique 4 fois de façon divergente.
function activateSession({role:r, nom, clevel, commercialIdVal, commercialNomVal, accountRole}){
  role=r; myName=nom||null; isCLevel=!!clevel; isAccountAdmin=(accountRole==='admin');
// Visibilité Montant/Upsell (diffusions) : ouverte à l'admin, au pôle com
// (accountRole==='communication') et à la finance — même accès que Lola
// (compte admin) demandé pour toute son équipe, sans faire de chacun un
// compte admin (qui donnerait aussi Paramètres/Reporting/etc). Décision
// Lina 09/2026, cf. statut-implementation-recouvrement.md.
canSeeBudget=(isAccountAdmin||accountRole==='communication'||accountRole==='finance'||accountRole==='edito');
  if(commercialIdVal){
    commercialId=commercialIdVal; commercialNom=commercialNomVal||'';
    localStorage.setItem('commercialId',commercialId); localStorage.setItem('commercialNom',commercialNom);
  }
  document.getElementById('pin-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  // Édito/communication n'ont pas accès au dashboard (leur page dédiée est le
  // planning) : inutile de leur montrer un onglet "Dashboard" qui les
  // renverrait aussitôt ici. Un compte admin partage le même rôle interne
  // "edit" qu'un édito (mêmes droits planning) mais A bien accès au dashboard,
  // lui — donc on ne masque l'onglet que si ce n'est pas un admin.
  const hideDashboardTab=(role==='edit'&&!isAccountAdmin)||role==='com';
  document.getElementById('app-tab-dashboard').style.display = hideDashboardTab ? 'none' : '';
  // La barre entière était masquée pour ces rôles : avec le seul Dashboard
  // caché, il ne restait qu'un pavé actif et beaucoup de vide à droite, ce qui
  // ressemblait à un élément cassé plutôt qu'à un choix. Ce n'est plus le cas
  // depuis l'ajout du Radar éditorial, ouvert à tous les rôles : édito et
  // communication ont désormais deux destinations réelles (Planning, Radar), la
  // barre garde donc son sens et reste affichée.
  document.querySelector('.app-switch').style.display = '';
  // Réglages spécifiques au dashboard (reporting, connexions, groupements
  // d'affichage) : réservés aux comptes admin, seuls comptes autorisés côté
  // serveur sur ces routes (requireAdmin).
  const dashAdminCard=document.getElementById('dash-admin-card');
  if(dashAdminCard)dashAdminCard.style.display=isAccountAdmin?'':'none';
  if(role==='sales'){
    document.getElementById('role-badge').textContent=commercialNom||'Commercial';
    document.getElementById('role-badge').className='role-badge sales';
    document.getElementById('btn-bdc-commercial').style.display='';
    document.getElementById('btn-mes-creneaux').style.display='';
    document.getElementById('nav-bdc').style.display='';
  }else{
    // Admin et édito partagent le rôle interne "edit" (mêmes droits côté
    // planning) mais un compte admin garde son propre badge — sinon impossible
    // de voir en un coup d'oeil qu'on est bien connecté avec les droits admin.
    const badgeLabel=isAccountAdmin?'Admin':(role==='edit'?'Édito':(role==='com'?'Communication':'Commercial'));
    const badgeClass=isAccountAdmin?'admin':role;
    document.getElementById('role-badge').textContent=badgeLabel;
    document.getElementById('role-badge').className=`role-badge ${badgeClass}`;
    if(role==='edit')document.querySelectorAll('.edit-only').forEach(el=>el.style.display='');
    // CA/reporting/paramètres : réservés aux comptes admin, pas à l'édito
    // (qui gère la programmation mais n'a pas à voir les chiffres commerciaux).
    if(isAccountAdmin)document.querySelectorAll('.admin-only').forEach(el=>el.style.display='');
    // Rétroplanning communication : édito ET communication (pas sales/commercial).
    if(role==='edit'||role==='com')document.querySelectorAll('.content-only').forEach(el=>el.style.display='');
  }
  // Générateur de BDC : tout compte de commercial_users (sales, manager, ET
  // admin — l'admin pilote l'outil et doit pouvoir générer/envoyer des BDC
  // sans se créer un faux compte "sales"). L'édito au PIN, sans commercialId,
  // reste exclu : les routes /api/bdc/* exigent un compte (requireCommercial).
  // Les boutons de BLOCAGE de créneau, eux, restent réservés aux sales.
  if(commercialId)document.getElementById('nav-bdc').style.display='';
  // Lien direct vers Paramètres depuis l'onglet du dashboard (/planning?view=parametres).
  if(isAccountAdmin && new URLSearchParams(window.location.search).get('view')==='parametres'){
    switchView('parametres');
    window.history.replaceState({},'',window.location.pathname);
  }
  // Le header vient de changer de taille (badge de rôle, boutons admin-only/
  // edit-only révélés ci-dessus) : recale le panneau "À programmer" dessus.
  // Le ResizeObserver (voir plus bas) devrait suffire seul, mais un appel
  // explicite ici évite tout flash visuel le temps qu'il se déclenche.
  if(typeof positionSidePanels==='function')positionSidePanels();
}
// SSO depuis OpenDashboard (ou session déjà ouverte sur cette page) : si un
// commercialId est déjà en localStorage, on retente une session directement
// via /api/auth/me au lieu de redemander les identifiants — c'est tout
// l'intérêt de la fusion (pas de re-login en passant d'un onglet à l'autre).
// Un compte finance n'a plus sa place ici : son outil dédié est /recouvrement
// (gros onglet séparé, plus un sous-onglet du planning). On l'y renvoie avant
// même d'afficher quoi que ce soit — mêmes clés localStorage (commercialId/
// commercialNom) que /recouvrement attend, donc pas de re-login à l'arrivée.
function redirectIfFinance(d){
  if(d.accountRole!=='finance')return false;
  localStorage.setItem('commercialId',d.commercial_id); localStorage.setItem('commercialNom',d.nom||'');
  window.location.href='/recouvrement';
  return true;
}
async function tryAutoLogin(){
  if(!commercialId || window._inviteToken)return false;
  try{
    const r=await fetch(`${API}/auth/me`,{headers:{'x-commercial-id':commercialId}});
    if(!r.ok)throw new Error('session invalide');
    const d=await r.json();
    if(redirectIfFinance(d))return true;
    activateSession({role:planningRoleFor(d.accountRole), nom:d.nom, clevel:false, commercialIdVal:d.commercial_id, commercialNomVal:d.nom, accountRole:d.accountRole});
    await init();
    return true;
  }catch{
    // Compte supprimé/désactivé depuis : on nettoie pour retomber proprement sur l'écran de connexion.
    localStorage.removeItem('commercialId'); localStorage.removeItem('commercialNom');
    commercialId=null; commercialNom='';
    return false;
  }
}

function toggleLoginMode(ev){
  ev.preventDefault();
  const edito=document.getElementById('pin-card-edito'), com=document.getElementById('pin-card-commercial');
  const showCom = edito.style.display!=='none';
  edito.style.display = showCom?'none':'';
  com.style.display = showCom?'':'none';
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
      if(redirectIfFinance(d))return;
      activateSession({role:planningRoleFor(d.accountRole), nom:d.nom, clevel:false, commercialIdVal:d.commercial_id, commercialNomVal:d.nom, accountRole:d.accountRole});
      await init();
    }else{
      errEl.textContent=d.error||'Email ou mot de passe incorrect.';
    }
  }catch{errEl.textContent='Erreur réseau.';}
}

// Connexion "réussie" commune (login classique OU juste après avoir défini son mot
// de passe via le lien d'invitation reçu par email) : bascule vers l'app en rôle sales.
function entrerCommeCommercial(d){
  if(redirectIfFinance(d))return;
  activateSession({role:planningRoleFor(d.accountRole), nom:d.nom, clevel:false, commercialIdVal:d.commercial_id, commercialNomVal:d.nom, accountRole:d.accountRole});
  init();
}

// Mot de passe oublié : bascule vers un 3e écran (email seul) qui appelle
// /api/auth/forgot-password — même réponse générique que le compte existe ou
// non, donc rien à distinguer ici, on affiche toujours le même message succès.
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
    const r=await fetch(`${API}/auth/forgot-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
    const d=await r.json().catch(()=>({}));
    // Avant : le message de succès s'affichait quel que soit le statut HTTP
    // (r.ok jamais vérifié), donc une réponse 429 (limite de fréquence) ou
    // 400 passait inaperçue — l'utilisateur croyait le lien envoyé alors que
    // la demande avait été bloquée. On distingue maintenant l'échec.
    if(!r.ok){ errEl.textContent=d.error||'Une erreur est survenue.'; return; }
    okEl.textContent=d.message||'Si un compte existe avec cet email, un lien de réinitialisation vient de lui être envoyé.';
    okEl.style.display='';
  }catch{errEl.textContent='Erreur réseau.';}
}

// Lien d'invitation reçu par email (?invite=TOKEN) : le commercial choisit son
// propre mot de passe au lieu que l'édito le lui communique à la main.
function checkInviteToken(){
  const token=new URLSearchParams(window.location.search).get('invite');
  if(!token)return;
  window._inviteToken=token;
  document.getElementById('pin-card-edito').style.display='none';
  document.getElementById('pin-card-commercial').style.display='none';
  document.getElementById('pin-card-invite').style.display='';
  // Nettoie l'URL (on ne veut pas laisser le token trainer dans l'historique/les favoris)
  window.history.replaceState({},'',window.location.pathname);
}
async function inviteSubmit(){
  const pw=document.getElementById('invite-password').value;
  const pwConfirm=document.getElementById('invite-password-confirm').value;
  const errEl=document.getElementById('invite-error');
  if(!pw||pw.length<6){errEl.textContent='6 caractères minimum.';return;}
  if(pw!==pwConfirm){errEl.textContent='Les deux mots de passe ne correspondent pas.';return;}
  try{
    const r=await fetch(`${API}/auth/set-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:window._inviteToken,password:pw})});
    const d=await r.json();
    if(r.ok){entrerCommeCommercial(d);}
    else{errEl.textContent=d.error||'Erreur.';}
  }catch{errEl.textContent='Erreur réseau.';}
}
// Portail unique : le point d'entrée par défaut pour se connecter est le
// dashboard ("/"), qui redirige lui-même vers /planning selon le rôle du
// compte. Si on arrive ici sans session valide (ni lien d'invitation), on
// renvoie donc vers "/" au lieu d'afficher un second écran de connexion.
// L'ancien accès par code PIN reste joignable via /planning?pin=1 pour ne
// pas bloquer les personnes pas encore migrées vers un compte (Eva, Flavie...).
async function bootstrapLogin(){
  checkInviteToken();
  if(window._inviteToken)return;
  const ok = await tryAutoLogin();
  if(ok)return;
  // L'auto-login a échoué (pas de session stockée, ou session expirée/compte
  // désactivé) : si le script anti-flash ci-dessus l'avait masqué, il faut le
  // réafficher pour que la personne puisse se reconnecter via /planning?pin=1.
  document.getElementById('pin-screen').style.display='';
  const wantsPin = new URLSearchParams(window.location.search).get('pin')==='1';
  if(!wantsPin){
    window.location.href='/';
  }
}
bootstrapLogin();

// Mesure la hauteur réelle du header, pour que le panneau flottant "À
// programmer" (position fixed) se cale toujours juste en dessous au lieu de
// passer dessous/derrière.
//
// Pourquoi ça recassait encore malgré ce correctif : `header.style.display`
// et son contenu changent APRÈS ce premier appel — le header est caché
// derrière l'écran de PIN/login au chargement (donc mesuré à 0 ou à sa
// hauteur "déconnecté"), et des boutons admin-only/edit-only (Paramètres,
// Reporting, +Ajouter...) n'apparaissent qu'une fois `activateSession()`
// exécutée, ce qui change sa hauteur réelle. Les écouteurs resize/load ne
// se redéclenchent pas pour autant : le panneau restait calé sur l'ANCIENNE
// hauteur (trop petite), donc visuellement sous le header une fois connecté.
//
// Fix robuste : un ResizeObserver sur le header lui-même recalcule à CHAQUE
// changement de sa taille réelle (login, apparition des boutons admin,
// passage du menu burger, etc.), sans avoir à traquer chaque appelant.
function positionSidePanels(){
  const header=document.querySelector('header');
  if(!header)return;
  const bottom=Math.round(header.getBoundingClientRect().bottom);
  document.documentElement.style.setProperty('--header-stack-height',`${bottom}px`);
}
window.addEventListener('resize',positionSidePanels);
window.addEventListener('load',positionSidePanels);
positionSidePanels();
if(window.ResizeObserver){
  const header=document.querySelector('header');
  if(header)new ResizeObserver(positionSidePanels).observe(header);
}
let RESP_EDIT_LIST = ['Lola','Eva','Flavie'];
async function refreshEquipesList(){
  if(role!=='edit')return;
  try{
    const equipes=await fetch(`${API}/admin/equipes`,{headers:{role:'edit'}}).then(r=>r.json());
    const noms=equipes.map(e=>e.nom);
    RESP_EDIT_LIST=[...new Set([...RESP_EDIT_LIST,...noms])];
    const sel=document.getElementById('resp-filter');
    if(sel){
      const current=sel.value;
      sel.innerHTML=`<option value="">👤 Tout le monde</option><option value="_none">Non assignées</option>${RESP_EDIT_LIST.map(r=>`<option value="${r}">${r}</option>`).join('')}`;
      sel.value=current;
    }
  }catch(e){}
}
const MOIS_FR = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
const JOURS_FR = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi']; // indexé par getDay()
const JOURS_COURT_FR = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']; // semaine du lundi
// Un fruit de saison par mois (France) pour le favicon dynamique du planning.
const FRUITS_MOIS = ['🍊','🥝','🍐','🍎','🍓','🍒','🍈','🍑','🍇','🍏','🌰','🍋'];
function setFaviconEmoji(emoji){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${emoji}</text></svg>`;
  let link = document.querySelector("link[rel~='icon']");
  if(!link){ link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
const FERIES = new Set(['2026-01-01','2026-04-06','2026-05-01','2026-05-08','2026-05-14','2026-05-25','2026-07-14','2026-08-15','2026-11-01','2026-11-11','2026-12-25','2025-01-01','2025-04-21','2025-05-01','2025-05-08','2025-05-29','2025-06-09','2025-07-14','2025-08-15','2025-11-01','2025-11-11','2025-12-25']);

function fmtClass(f) {
  if (!f) return '';
  const fl = f.toLowerCase();
  if (fl.includes('plateau')) return 'plateau';
  if (fl.includes('immersion')) return 'immersion';
  if (fl.includes('print')) return 'artprint';
  if (fl.includes('article')||fl.includes('digital')) return 'artdigital';
  return '';
}
function fmtColor(f) { return {plateau:'#2563eb',immersion:'#7c3aed',artprint:'#ea580c',artdigital:'#059669'}[fmtClass(f)]||'#b0b7c3'; }

// ── PIN ─────────────────────────────────────────────────────────────────────
function pinKey(k){if(pinBuffer.length>=4)return;pinBuffer+=k;updateDots();if(pinBuffer.length===4)pinSubmit();}
function pinDel(){pinBuffer=pinBuffer.slice(0,-1);updateDots();}
function updateDots(){for(let i=0;i<4;i++)document.getElementById('d'+i).classList.toggle('filled',i<pinBuffer.length);}
async function pinSubmit(){
  if(!pinBuffer)return;
  try{
    const r=await fetch(`${API}/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pinBuffer})});
    if(r.ok){
      const d=await r.json();
      activateSession({role:d.role, nom:d.nom, clevel:d.clevel});
      await init();
    }else{
      document.getElementById('pin-error').textContent='Code incorrect.';
      pinBuffer='';updateDots();setTimeout(()=>document.getElementById('pin-error').textContent='',2000);
    }
  }catch{document.getElementById('pin-error').textContent='Erreur.';pinBuffer='';updateDots();}
}

// ── INIT ────────────────────────────────────────────────────────────────────
async function init(){
  meta=await fetch(`${API}/meta`).then(r=>r.json());
  joursBlockes=await fetch(`${API}/jours-bloques`).then(r=>r.json());
  buildMediaTabs();
  await loadData();
  renderCalendar();
  if(role==='edit'){
    showSemaineBanner();
    loadAProgrammer();
    checkRetardAlerte();
    refreshEquipesList();
    if(myName)checkMyAProgrammer();
    if(isCLevel)checkCLevelAProgrammer();
  }
  if(role==='sales'&&commercialId){ updateBdcCounter(); }
  if(localStorage.getItem('theme')==='dark'){document.documentElement.setAttribute('data-theme','dark');document.getElementById('theme-btn').textContent='🌙';}
}
function buildMediaTabs(){
  document.getElementById('media-tabs').innerHTML=meta.medias.map(m=>
    `<div class="media-tab${m===currentMedia?' active':''}" onclick="selectMedia('${m}')">${m}</div>`
  ).join('');
}
let respFilter='';
async function loadData(){
  const m=currentDate.getMonth()+1,y=currentDate.getFullYear();
  let url=`${API}/emissions?media=${encodeURIComponent(currentMedia)}&mois=${m}&annee=${y}`;
  if(searchQuery)url+=`&search=${encodeURIComponent(searchQuery)}`;
  if(bdcFilterActive)url+=`&statut=bdc_attente`;
  if(respFilter)url+=`&resp_edit=${encodeURIComponent(respFilter)}`;
  [emissions,slotMap]=await Promise.all([fetch(url,{headers:{role}}).then(r=>r.json()),fetch(`${API}/slots?media=${encodeURIComponent(currentMedia)}&mois=${m}&annee=${y}`).then(r=>r.json())]);
}

// ── NAV ─────────────────────────────────────────────────────────────────────
function switchView(v){
  document.querySelectorAll('.view').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el=>el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  // Paramètres n'a plus de bouton dans le sous-menu (header-nav) depuis que
  // c'est un onglet de premier niveau à côté de Dashboard/Planning — d'où le
  // "?." (sinon erreur, car #nav-parametres n'existe plus).
  document.getElementById('nav-'+v)?.classList.add('active');
  document.getElementById('app-tab-planning')?.classList.toggle('active',v!=='parametres');
  document.getElementById('app-tab-parametres')?.classList.toggle('active',v==='parametres');
  if(v==='list')renderList();
  if(v==='reporting')loadReporting();
  if(v==='parametres')loadParametres();
  if(v==='bdc')bdcOnShow();
  if(v==='social'){loadSocial();loadIdeaBox();}
  // Le sélecteur de mois est partagé : en changeant de vue on change le
  // calendrier qu'il pilote, donc le mois qu'il doit afficher.
  updateMonthLabel();
  refreshMonthNavVisibility();
  // Favicon dynamique : roue crantée sur Paramètres, sinon fruit du mois
  // (repris par renderCalendar au retour sur Calendrier, cf. plus haut).
  setFaviconEmoji(v==='parametres'?'⚙️':FRUITS_MOIS[currentDate.getMonth()]);
  closePlanningMenu();
}

// ── RÉTROPLANNING COMMUNICATION (v3) ──────────────────────────────────────────
// Calendrier de posts Instagram/LinkedIn/YouTube/Newsletter — nouveau projet,
// séparé du planning de diffusion (emissions). Statuts simples : à faire ->
// prêt -> publié. v3 : un post peut viser PLUSIEURS canaux à la fois (stocké
// "Instagram,LinkedIn" en base, voir parseChannels() côté serveur), le filtre
// canal devient multi-sélection, et "Assigné à" pointe vers les comptes
// communication (role='communication') au lieu de l'équipe édito (aucun
// rapport — RESP_EDIT_LIST sert à assigner les ÉMISSIONS, pas les posts).
let socialPostsCache=[];
let socialTeamCache=[]; // comptes communication, pour "Assigné à"
let socialCalendarDate=new Date();
// Zoom du calendrier, façon Google Agenda : 'mois' | 'semaine' | '3jours' |
// 'jour'. Mémorisé entre les sessions ; pilote aussi le pas des flèches du
// header (changeMonth) et le libellé affiché (updateMonthLabel).
let socialZoom=(()=>{const z=localStorage.getItem('social-zoom');return ['mois','semaine','3jours','jour'].includes(z)?z:'mois';})();
let socialSubview='calendar';
let socialFilterChannels=new Set(); // vide = tous les canaux
let socialIdeasCache=[];
let draggedIdea=null; // idée en cours de glisser-déposer vers le calendrier
let editingIdeaId=null; // id de l'idée en cours d'édition inline (clic sur le titre)
let editingIdeaChannels=new Set(); // canaux cochés pour l'idée en cours d'édition
let newIdeaChannels=new Set(); // canaux cochés pour la prochaine idée à ajouter
let socialIdeaBeingConverted=null; // id de l'idée à supprimer si le post est bien créé
const SOCIAL_STATUS_LABEL={a_faire:'À faire',pret:'Prêt',publie:'Publié'};
const SOCIAL_STATUS_ORDER=['a_faire','pret','publie'];
const SOCIAL_CHANNEL_ICON={Instagram:'📷',LinkedIn:'💼',YouTube:'▶️',Newsletter:'✉️'};

function socialChannelsOf(post){
  return String(post.channel||'').split(',').map(c=>c.trim()).filter(Boolean);
}

async function loadSocial(){
  if(!socialTeamCache.length){
    try{ socialTeamCache=await fetch(`${API}/social-team`,{headers:{role}}).then(r=>r.json()); }catch(e){ socialTeamCache=[]; }
  }
  socialPostsCache=await fetch(`${API}/social-posts`,{headers:{role}}).then(r=>r.json());
  renderSocialViews();
}

function switchSocialSubview(v){
  socialSubview=v;
  document.getElementById('social-tab-calendar').classList.toggle('active',v==='calendar');
  document.getElementById('social-tab-list').classList.toggle('active',v==='list');
  document.getElementById('social-subview-calendar').classList.toggle('active',v==='calendar');
  document.getElementById('social-subview-list').classList.toggle('active',v==='list');
  // La liste n'est pas découpée par mois : on retire le sélecteur du header.
  refreshMonthNavVisibility();
}

function renderSocialViews(){
  refreshSocialChannelFilterButton();
  renderSocialCalendar();
  renderSocialList();
}

function socialFilteredPosts(){
  if(!socialFilterChannels.size)return socialPostsCache;
  return socialPostsCache.filter(p=>socialChannelsOf(p).some(c=>socialFilterChannels.has(c)));
}

// ── Filtre canal multi-sélection (bouton + menu à cases à cocher) ────────────
function refreshSocialChannelFilterButton(){
  const btn=document.getElementById('social-filter-channel-btn');
  if(!btn)return;
  const n=socialFilterChannels.size;
  btn.textContent=n===0?'Tous les canaux':n===1?[...socialFilterChannels][0]:`${n} canaux`;
  btn.classList.toggle('ms-filter-active',n>0);
}
function renderSocialChannelFilterMenu(){
  const menu=document.getElementById('social-channel-filter-menu');
  menu.innerHTML=(meta.channels||[]).map(c=>`
    <label class="ms-filter-item">
      <input type="checkbox" value="${c}" ${socialFilterChannels.has(c)?'checked':''} onchange="toggleSocialFilterChannel('${c}')">
      <span>${SOCIAL_CHANNEL_ICON[c]||''} ${c}</span>
    </label>
  `).join('')+(socialFilterChannels.size?'<div class="ms-filter-sep"></div><button type="button" class="ms-filter-clear" onclick="clearSocialChannelFilter()">Tout désélectionner</button>':'');
}
function toggleSocialChannelFilterMenu(event){
  const menu=document.getElementById('social-channel-filter-menu');
  const willOpen=menu.style.display==='none';
  document.querySelectorAll('.ms-filter-menu').forEach(m=>m.style.display='none');
  const ideaBoxMenu=document.getElementById('idea-box-panel');
  if(ideaBoxMenu)ideaBoxMenu.style.display='none';
  if(!willOpen)return;
  renderSocialChannelFilterMenu();
  const rect=event.currentTarget.getBoundingClientRect();
  menu.style.position='fixed';
  menu.style.left=`${rect.left}px`;
  menu.style.top=`${rect.bottom+4}px`;
  menu.style.width=`${Math.max(170,rect.width)}px`;
  menu.style.display='block';
}
function toggleSocialFilterChannel(c){
  if(socialFilterChannels.has(c))socialFilterChannels.delete(c);else socialFilterChannels.add(c);
  renderSocialViews();
  renderSocialChannelFilterMenu();
}
function clearSocialChannelFilter(){
  socialFilterChannels.clear();
  document.getElementById('social-channel-filter-menu').style.display='none';
  renderSocialViews();
}
document.addEventListener('click',e=>{
  if(!e.target.closest('#social-channel-filter-wrap'))document.getElementById('social-channel-filter-menu').style.display='none';
});

// ── Vue calendrier (grille mensuelle, semaine du lundi) ──────────────────────
// La navigation de mois est celle du header (changeMonth) — ce calendrier n'a
// plus la sienne. socialCalendarNav() a été supprimée avec les flèches en
// doublon ; si tu la vois réapparaître dans un diff, c'est une régression.
//
// Zoom façon Google Agenda : Mois / Semaine / 3 jours / Journée. Seule
// l'échelle change — les flèches du header avancent du pas correspondant
// (voir changeMonth) et le libellé du header suit (voir updateMonthLabel).
function setSocialZoom(z){
  if(z===socialZoom)return;
  if(z==='mois'){
    // retour au mois : on normalise au 1er, comme le fait shiftMonth()
    socialCalendarDate=new Date(socialCalendarDate.getFullYear(),socialCalendarDate.getMonth(),1);
  }else if(socialZoom==='mois'){
    // en quittant le mois (date normalisée au 1er), on ré-ancre sur
    // aujourd'hui si c'est le mois courant qu'on regardait, sinon sur le 1er
    const now=new Date();
    if(socialCalendarDate.getFullYear()===now.getFullYear()&&socialCalendarDate.getMonth()===now.getMonth())
      socialCalendarDate=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  }
  socialZoom=z;
  localStorage.setItem('social-zoom',z);
  renderSocialCalendar();
}
function refreshSocialZoomNav(){
  ['mois','semaine','3jours','jour'].forEach(k=>{
    const b=document.getElementById('social-zoom-'+k);
    if(b)b.classList.toggle('active',k===socialZoom);
  });
}
function renderSocialCalendar(){
  // Le libellé (mois, semaine ou journée) vit dans le header, partagé avec le
  // calendrier des diffusions : on le resynchronise à chaque rendu.
  updateMonthLabel();
  refreshSocialZoomNav();
  const posts=socialFilteredPosts();
  const postsByDate={};
  posts.forEach(p=>{(postsByDate[p.scheduled_date]=postsByDate[p.scheduled_date]||[]).push(p);});
  const todayStr=fmtDate(new Date());
  const grid=document.getElementById('social-cal-grid');
  const wd=document.getElementById('social-cal-weekdays');

  const chipHtml=(p,zoomed)=>{
    const chs=socialChannelsOf(p);
    const icons=chs.map(c=>SOCIAL_CHANNEL_ICON[c]||'').join('');
    const dot=zoomed?`<span class="social-dot ${p.status}"></span>`:'';
    return `<div class="social-cal-chip ${chs[0]||''}" onclick="event.stopPropagation();openEditSocialPostModal(${p.id})" title="${chs.join(', ')} — ${p.title} (${SOCIAL_STATUS_LABEL[p.status]})">${dot}${icons} ${p.title}</div>`;
  };

  // ── Mois : grille classique 7 colonnes ──
  if(socialZoom==='mois'){
    const y=socialCalendarDate.getFullYear(), m=socialCalendarDate.getMonth();
    const firstOfMonth=new Date(y,m,1);
    const startDow=(firstOfMonth.getDay()+6)%7; // 0=lundi
    const gridStart=new Date(y,m,1-startDow);
    wd.style.gridTemplateColumns='repeat(7, 1fr)';
    wd.innerHTML=JOURS_COURT_FR.map(j=>`<span>${j}</span>`).join('');
    grid.className='social-cal-grid';
    grid.style.gridTemplateColumns='repeat(7, 1fr)';
    const cells=[];
    for(let i=0;i<42;i++){
      const d=new Date(gridStart);
      d.setDate(gridStart.getDate()+i);
      const dStr=fmtDate(d);
      const outside=d.getMonth()!==m;
      if(outside && i>=35 && d.getDate()>7)break; // pas de 6e ligne inutile
      cells.push(`
        <div class="social-cal-day${outside?' outside':''}${dStr===todayStr?' today':''}" onclick="openCreateSocialPostModal('${dStr}')" ondragover="allowDropIdeaBox(event)" ondrop="dropOnIdeaBox(event,'${dStr}')">
          <div class="social-cal-daynum">${d.getDate()}</div>
          ${(postsByDate[dStr]||[]).map(p=>chipHtml(p,false)).join('')}
        </div>
      `);
    }
    grid.innerHTML=cells.join('');
    return;
  }

  // ── Semaine / 3 jours / Journée : dates visibles ──
  const dates=[];
  if(socialZoom==='semaine'){
    const start=new Date(socialCalendarDate);
    start.setDate(start.getDate()-((socialCalendarDate.getDay()+6)%7)); // lundi
    for(let i=0;i<7;i++){const d=new Date(start);d.setDate(start.getDate()+i);dates.push(d);}
  }else if(socialZoom==='3jours'){
    for(let i=0;i<3;i++){const d=new Date(socialCalendarDate);d.setDate(socialCalendarDate.getDate()+i);dates.push(d);}
  }else{
    dates.push(new Date(socialCalendarDate));
  }
  const n=dates.length;
  wd.style.gridTemplateColumns=`repeat(${n}, 1fr)`;
  wd.innerHTML=dates.map(d=>`<span>${JOURS_COURT_FR[(d.getDay()+6)%7]}${n<=3?` ${d.getDate()}`:''}</span>`).join('');
  grid.className='social-cal-grid zoomed';
  grid.style.gridTemplateColumns=`repeat(${n}, 1fr)`;

  // Journée : une seule case pleine largeur, cartes détaillées
  if(socialZoom==='jour'){
    const dStr=fmtDate(dates[0]);
    const dayPosts=postsByDate[dStr]||[];
    grid.innerHTML=`<div class="social-cal-day${dStr===todayStr?' today':''}" style="min-height:55vh;cursor:default" ondragover="allowDropIdeaBox(event)" ondrop="dropOnIdeaBox(event,'${dStr}')">
      ${dayPosts.length?dayPosts.map(p=>{
        const chs=socialChannelsOf(p);
        const icons=chs.map(c=>SOCIAL_CHANNEL_ICON[c]||'').join(' ');
        return `<div class="social-full-card ${chs[0]||''}" onclick="openEditSocialPostModal(${p.id})" title="Modifier">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700">${icons} ${p.title}</div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:2px">${chs.join(' · ')}${p.assigned_to?` — ${p.assigned_to}`:''}</div>
            ${p.notes?`<div style="font-size:12px;color:var(--text-muted);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.notes}</div>`:''}
          </div>
          <span class="social-status ${p.status}" onclick="event.stopPropagation();cycleSocialPostStatus(${p.id})" title="Cliquer pour changer le statut">${SOCIAL_STATUS_LABEL[p.status]}</span>
        </div>`;
      }).join(''):'<div style="color:var(--text-muted);font-size:13px;padding:24px;text-align:center">Aucun post prévu ce jour.</div>'}
      <button class="btn-secondary" style="align-self:flex-start;margin-top:4px" onclick="openCreateSocialPostModal('${dStr}')">+ Ajouter un post ce jour</button>
    </div>`;
    return;
  }

  // Semaine / 3 jours : grandes cases, chips avec pastille de statut
  grid.innerHTML=dates.map(d=>{
    const dStr=fmtDate(d);
    return `<div class="social-cal-day${dStr===todayStr?' today':''}" onclick="openCreateSocialPostModal('${dStr}')" ondragover="allowDropIdeaBox(event)" ondrop="dropOnIdeaBox(event,'${dStr}')">
      <div class="social-cal-daynum">${d.getDate()}</div>
      ${(postsByDate[dStr]||[]).map(p=>chipHtml(p,true)).join('')}
    </div>`;
  }).join('');
}

// ── Vue liste ─────────────────────────────────────────────────────────────────
function renderSocialList(){
  const el=document.getElementById('social-posts-list');
  const posts=socialFilteredPosts().sort((a,b)=>a.scheduled_date.localeCompare(b.scheduled_date));
  if(!posts.length){
    el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">Aucun post planifié pour l\'instant.</div>';
    return;
  }
  el.innerHTML=posts.map(p=>`
    <div class="param-row">
      <span class="social-channel">${socialChannelsOf(p).map(c=>`${SOCIAL_CHANNEL_ICON[c]||''} ${c}`).join(' · ')}</span>
      <span class="social-date">${formatDateFR(p.scheduled_date)}</span>
      <span class="social-title">${p.title}${p.assigned_to?` <span style="opacity:0.6;font-weight:400">— ${p.assigned_to}</span>`:''}</span>
      ${p.drive_link?`<a href="${p.drive_link}" target="_blank" rel="noopener" title="Ouvrir la pièce jointe (Drive)" onclick="event.stopPropagation()">📎</a>`:''}
      <div class="pr-actions">
        <button class="social-status ${p.status}" onclick="cycleSocialPostStatus(${p.id})" title="Cliquer pour changer le statut">${SOCIAL_STATUS_LABEL[p.status]}</button>
        <button class="btn-secondary" onclick="openSocialPreview(${p.id})" title="Aperçu du rendu">👁</button>
        <button class="btn-secondary" onclick="openEditSocialPostModal(${p.id})" title="Modifier">✎</button>
        <button class="btn-secondary" onclick="deleteSocialPost(${p.id})" title="Supprimer">✕</button>
      </div>
    </div>
  `).join('');
}

async function cycleSocialPostStatus(id){
  const post=socialPostsCache.find(p=>p.id===id);
  if(!post)return;
  const next=SOCIAL_STATUS_ORDER[(SOCIAL_STATUS_ORDER.indexOf(post.status)+1)%SOCIAL_STATUS_ORDER.length];
  const updated=await fetch(`${API}/social-posts/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',role},body:JSON.stringify({status:next})}).then(r=>r.json());
  const idx=socialPostsCache.findIndex(p=>p.id===id);
  if(idx>=0)socialPostsCache[idx]=updated;
  renderSocialViews();
}

// Cases à cocher (pas un select) : un post peut viser plusieurs canaux à la
// fois. selectedArr = tableau des canaux déjà cochés (édition) ou [] (création).
function socialChannelCheckboxesHtml(selectedArr){
  const sel=selectedArr||[];
  return `<div style="display:flex;gap:14px;flex-wrap:wrap">${(meta.channels||[]).map(c=>`
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;cursor:pointer">
      <input type="checkbox" class="social-channel-check" value="${c}" ${sel.includes(c)?'checked':''}>
      ${SOCIAL_CHANNEL_ICON[c]||''} ${c}
    </label>
  `).join('')}</div>`;
}
function socialSelectedChannels(){
  return [...document.querySelectorAll('.social-channel-check:checked')].map(el=>el.value);
}
function socialAssignedOptionsHtml(selected){
  // Comptes communication (role='communication'), pas l'équipe édito
  // (RESP_EDIT_LIST) — sans rapport avec qui doit publier un post.
  return '<option value="">— Non assigné —</option>'+socialTeamCache.map(t=>`<option value="${t.nom}" ${t.nom===selected?'selected':''}>${t.nom}</option>`).join('');
}
function socialStatusOptionsHtml(selected){
  return SOCIAL_STATUS_ORDER.map(s=>`<option value="${s}" ${s===selected?'selected':''}>${SOCIAL_STATUS_LABEL[s]}</option>`).join('');
}

// ── Image de preview : upload direct (pas de lien Drive à partager/dépendre
// d'une session Google active) — lu côté navigateur, redimensionné et
// compressé via un <canvas> pour ne pas envoyer une photo brute de plusieurs
// Mo, puis stocké en data URL. socialPickedImageData tient l'état courant du
// formulaire ouvert (null = pas d'image).
let socialPickedImageData=null;
function imageDataUrlFromFile(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('Lecture du fichier impossible'));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error('Fichier image invalide'));
      img.onload=()=>{
        const maxDim=900;
        let{width,height}=img;
        if(width>maxDim||height>maxDim){
          const ratio=Math.min(maxDim/width,maxDim/height);
          width=Math.round(width*ratio);height=Math.round(height*ratio);
        }
        const canvas=document.createElement('canvas');
        canvas.width=width;canvas.height=height;
        canvas.getContext('2d').drawImage(img,0,0,width,height);
        resolve(canvas.toDataURL('image/jpeg',0.82));
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function handleSocialImagePick(event){
  const file=event.target.files[0];
  if(!file)return;
  try{
    socialPickedImageData=await imageDataUrlFromFile(file);
    renderSocialImagePreview();
  }catch(e){showToast(e.message||'Image illisible','error');}
}
function removeSocialImage(){
  socialPickedImageData=null;
  document.getElementById('social-image-input').value='';
  renderSocialImagePreview();
}
function renderSocialImagePreview(){
  const el=document.getElementById('social-image-preview');
  if(!el)return;
  el.innerHTML=socialPickedImageData
    ? `<div style="position:relative;display:inline-block"><img src="${socialPickedImageData}" style="max-width:160px;max-height:160px;border-radius:8px;border:1px solid var(--border)"><button type="button" class="btn-secondary" style="position:absolute;top:-8px;right:-8px;padding:2px 7px;border-radius:50%" onclick="removeSocialImage()" title="Retirer l'image">✕</button></div>`
    : '';
}
function socialImageFieldHtml(){
  return `
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">Image de preview</label>
      <input class="form-input" type="file" accept="image/*" id="social-image-input" onchange="handleSocialImagePick(event)">
      <div id="social-image-preview" style="margin-top:8px"></div>
    </div>`;
}

function openCreateSocialPostModal(prefillDate,prefillIdea){
  socialPickedImageData=null;
  // Idée glissée depuis la boîte à idées : pré-remplit le titre (et les
  // canaux, si l'idée en avait) ; l'idée n'est supprimée qu'une fois le post
  // effectivement créé (cf. confirmCreateSocialPost), pas dès l'ouverture du
  // modal — sinon une idée se perd si on annule.
  socialIdeaBeingConverted=prefillIdea?prefillIdea.id:null;
  document.getElementById('modal-title').textContent='Ajouter un post';
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Canaux</label>${socialChannelCheckboxesHtml(prefillIdea?socialChannelsOf(prefillIdea):[])}</div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Titre</label><input class="form-input" id="social-title" placeholder="Ex : Teaser campagne rentrée" value="${prefillIdea?prefillIdea.title:''}"></div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Date de publication</label><input class="form-input" type="date" id="social-date" value="${typeof prefillDate==='string'?prefillDate:''}"></div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Assigné à</label><select class="form-select" id="social-assigned">${socialAssignedOptionsHtml()}</select></div>
    ${socialImageFieldHtml()}
    <div class="form-group" style="margin-top:12px"><label class="form-label">Lien Drive (dossier source, optionnel)</label><input class="form-input" id="social-drive" placeholder="https://drive.google.com/…"></div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Notes / légende</label><textarea class="form-input" id="social-notes" rows="3" placeholder="Texte du post, brief…">${prefillIdea&&prefillIdea.notes?prefillIdea.notes:''}</textarea></div>
  `;
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="confirmCreateSocialPost()">Ajouter</button>
  `;
}
async function confirmCreateSocialPost(){
  const channel=socialSelectedChannels();
  const title=document.getElementById('social-title').value.trim();
  const scheduledDate=document.getElementById('social-date').value;
  const assignedTo=document.getElementById('social-assigned').value;
  const driveLink=document.getElementById('social-drive').value.trim();
  const notes=document.getElementById('social-notes').value.trim();
  if(!channel.length){showToast('Sélectionne au moins un canal','error');return;}
  if(!title||!scheduledDate){showToast('Titre et date requis','error');return;}
  await fetch(`${API}/social-posts`,{method:'POST',headers:{'Content-Type':'application/json',role},body:JSON.stringify({channel,title,scheduledDate,assignedTo,driveLink,notes,imageData:socialPickedImageData})});
  // Post créé à partir d'une idée glissée sur le calendrier : elle a fait son
  // office, on la retire de la boîte à idées.
  if(socialIdeaBeingConverted){
    await fetch(`${API}/social-ideas/${socialIdeaBeingConverted}`,{method:'DELETE',headers:{role}});
    socialIdeaBeingConverted=null;
    loadIdeaBox();
  }
  closeModal();
  loadSocial();
  showToast('Post ajouté au rétroplanning');
}

function openEditSocialPostModal(id){
  const post=socialPostsCache.find(p=>p.id===id);
  if(!post)return;
  socialPickedImageData=post.image_data||null;
  document.getElementById('modal-title').textContent='Modifier le post';
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Canaux</label>${socialChannelCheckboxesHtml(socialChannelsOf(post))}</div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Titre</label><input class="form-input" id="social-title" value="${post.title}"></div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Date de publication</label><input class="form-input" type="date" id="social-date" value="${post.scheduled_date}"></div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Assigné à</label><select class="form-select" id="social-assigned">${socialAssignedOptionsHtml(post.assigned_to)}</select></div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Statut</label><select class="form-select" id="social-status">${socialStatusOptionsHtml(post.status)}</select></div>
    ${socialImageFieldHtml()}
    <div class="form-group" style="margin-top:12px"><label class="form-label">Lien Drive (dossier source, optionnel)</label><input class="form-input" id="social-drive" value="${post.drive_link||''}" placeholder="https://drive.google.com/…"></div>
    <div class="form-group" style="margin-top:12px"><label class="form-label">Notes / légende</label><textarea class="form-input" id="social-notes" rows="3">${post.notes||''}</textarea></div>
  `;
  renderSocialImagePreview();
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-danger" onclick="deleteSocialPost(${id})">Supprimer</button>
    <button class="btn-secondary" onclick="openSocialPreview(${id})">👁 Aperçu</button>
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="confirmEditSocialPost(${id})">Enregistrer</button>
  `;
}
async function confirmEditSocialPost(id){
  const channel=socialSelectedChannels();
  const title=document.getElementById('social-title').value.trim();
  const scheduledDate=document.getElementById('social-date').value;
  const assignedTo=document.getElementById('social-assigned').value;
  const status=document.getElementById('social-status').value;
  const driveLink=document.getElementById('social-drive').value.trim();
  const notes=document.getElementById('social-notes').value.trim();
  if(!channel.length){showToast('Sélectionne au moins un canal','error');return;}
  if(!title||!scheduledDate){showToast('Titre et date requis','error');return;}
  await fetch(`${API}/social-posts/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',role},body:JSON.stringify({channel,title,scheduledDate,assignedTo,status,driveLink,notes,imageData:socialPickedImageData})});
  closeModal();
  loadSocial();
  showToast('Post mis à jour');
}
async function deleteSocialPost(id){
  if(!confirm('Supprimer ce post du rétroplanning ?'))return;
  await fetch(`${API}/social-posts/${id}`,{method:'DELETE',headers:{role}});
  closeModal();
  loadSocial();
  showToast('Post supprimé');
}

// ── Aperçu du rendu par réseau ────────────────────────────────────────────────
// Le lien Drive collé dans le formulaire est un lien de PAGE ("/file/d/ID/view"),
// pas une image directement affichable dans une balise <img>. On extrait l'ID
// via l'image uploadée directement dans l'app (post.image_data, une data URL
// déjà compressée côté client — voir imageDataUrlFromFile()) : plus simple
// que de dépendre d'un partage Drive + d'une session Google active dans le
// navigateur (essayé, jugé trop compliqué). Le lien Drive reste possible en
// complément, comme référence vers le dossier source, mais n'est plus ce qui
// alimente le visuel de l'aperçu.
// Un post peut viser plusieurs canaux : on génère une carte d'aperçu par canal.
function socialPreviewCardHtml(post,channel){
  const caption=post.notes||post.title;
  const mediaHeight=channel==='YouTube'?'180px':'220px';
  const placeholderInner=channel==='YouTube'?'▶️':'🖼️';
  const mediaBox=post.image_data
    ? `<div class="social-preview-media" style="height:${mediaHeight};padding:0;overflow:hidden">
         <img src="${post.image_data}" alt="${post.title}" style="width:100%;height:100%;object-fit:cover">
       </div>`
    : `<div class="social-preview-media" style="height:${mediaHeight}">${placeholderInner}</div>`;
  const driveNote=post.drive_link?`<a class="social-preview-link" href="${post.drive_link}" target="_blank" rel="noopener">📎 Dossier source (Drive)</a>`:'';
  if(channel==='Instagram'){
    return `<div class="social-preview-frame">
      <div class="social-preview-head"><div class="social-preview-avatar">OM</div><div><div class="social-preview-name">openmedias</div></div></div>
      ${mediaBox}
      <div class="social-preview-icons"><span>♡</span><span>💬</span><span>➤</span></div>
      <div class="social-preview-body"><strong>openmedias</strong> ${caption}</div>
      ${driveNote}
    </div>`;
  }
  if(channel==='LinkedIn'){
    return `<div class="social-preview-frame">
      <div class="social-preview-head"><div class="social-preview-avatar">OM</div><div><div class="social-preview-name">OpenMedias</div><div class="social-preview-sub">Régie publicitaire média</div></div></div>
      <div class="social-preview-body">${caption}</div>
      ${mediaBox}
      <div class="social-preview-icons"><span>👍</span><span>💬</span><span>🔁</span><span>➤</span></div>
      ${driveNote}
    </div>`;
  }
  if(channel==='YouTube'){
    return `<div class="social-preview-frame">
      ${mediaBox}
      <div class="social-preview-body"><strong>${post.title}</strong><div class="social-preview-sub" style="margin-top:4px">OpenMedias • ${caption}</div></div>
      ${driveNote}
    </div>`;
  }
  // Newsletter
  return `<div class="social-preview-frame">
    <div class="social-preview-head"><div class="social-preview-avatar">OM</div><div><div class="social-preview-name">OpenMedias</div><div class="social-preview-sub">Objet : ${post.title}</div></div></div>
    <div class="social-preview-body">${caption}</div>
    ${driveNote}
  </div>`;
}
function socialPreviewHtml(post){
  const chs=socialChannelsOf(post);
  if(chs.length<=1)return socialPreviewCardHtml(post,chs[0]||'Newsletter');
  return `<div style="display:flex;flex-direction:column;gap:18px">${chs.map(c=>`
    <div>
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px">${SOCIAL_CHANNEL_ICON[c]||''} ${c}</div>
      ${socialPreviewCardHtml(post,c)}
    </div>
  `).join('')}</div>`;
}
function openSocialPreview(id){
  const post=socialPostsCache.find(p=>p.id===id);
  if(!post)return;
  document.getElementById('modal-title').textContent=`Aperçu — ${socialChannelsOf(post).join(', ')}`;
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=socialPreviewHtml(post);
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="openEditSocialPostModal(${id})">← Retour à l'édition</button>
    <button class="btn-primary" onclick="closeModal()">Fermer</button>
  `;
}
// Menu burger mobile (voir bloc RESPONSIVE MOBILE en fin de <style>) : ouvre/
// ferme le panneau qui regroupe navigation mois + actions (header-right) et
// les filtres/badges secondaires (toolbar-extra). Sans effet sur desktop.
function togglePlanningMenu(){
  document.body.classList.toggle('planning-menu-open');
  const open=document.body.classList.contains('planning-menu-open');
  const btn=document.getElementById('planning-burger-btn');
  if(btn)btn.textContent=open?'✕':'☰';
}
function closePlanningMenu(){
  document.body.classList.remove('planning-menu-open');
  const btn=document.getElementById('planning-burger-btn');
  if(btn)btn.textContent='☰';
}
async function selectMedia(m){
  currentMedia=m;
  document.querySelectorAll('.media-tab').forEach(el=>el.classList.toggle('active',el.textContent===m));
  await loadData();renderCalendar();
}
// ── ACTUALISATION MANUELLE (sans reperdre la session PIN) ────────────────────
async function refreshAll(){
  const btn=document.getElementById('refresh-btn');
  btn.style.transform='rotate(360deg)';btn.style.transition='transform 0.5s';
  meta=await fetch(`${API}/meta`).then(r=>r.json());
  joursBlockes=await fetch(`${API}/jours-bloques`).then(r=>r.json());
  await loadData();renderCalendar();
  if(role==='edit')loadAProgrammer();
  if(role==='edit')checkRetardAlerte();
  if(role==='edit')refreshEquipesList();
  if(role==='sales'&&commercialId)updateBdcCounter();
  if(role==='edit')await fetchSemaineData();
  if(document.getElementById('view-list').classList.contains('active'))renderList();
  if(document.getElementById('view-reporting').classList.contains('active'))loadReporting();
  showToast('Actualisé ✓','success');
  setTimeout(()=>{btn.style.transform='';},500);
}

// ── NAVIGATION DE MOIS (contrôle unique) ─────────────────────────────────────
// .month-nav dans le header est le SEUL sélecteur de mois de l'application. Il
// agit sur le calendrier actuellement affiché : celui des diffusions
// (currentDate) ou le rétroplanning réseaux sociaux (socialCalendarDate).
// Les deux gardent leur propre mois — voir le commentaire CSS de .social-cal-*.
function isSocialCalendarActive(){
  return document.getElementById('view-social').classList.contains('active');
}
function activeMonthDate(){
  return isSocialCalendarActive() ? socialCalendarDate : currentDate;
}
function updateMonthLabel(){
  const d=activeMonthDate();
  // En zoom Semaine / 3 jours / Journée, un simple "Juillet 2026" ne dit plus
  // ce qu'on regarde : le libellé épouse alors la période réellement visible.
  const label=(isSocialCalendarActive()&&socialZoom!=='mois')?socialZoomLabel():`${MOIS_FR[d.getMonth()]} ${d.getFullYear()}`;
  document.getElementById('month-label').textContent=label;
}

// Libellé du header pour les zooms social Semaine / 3 jours / Journée.
function socialZoomLabel(){
  const d=socialCalendarDate;
  const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
  if(socialZoom==='jour')return `${cap(JOURS_FR[d.getDay()])} ${d.getDate()} ${MOIS_FR[d.getMonth()]} ${d.getFullYear()}`;
  const start=new Date(d);
  if(socialZoom==='semaine')start.setDate(start.getDate()-((d.getDay()+6)%7));
  const end=new Date(start); end.setDate(end.getDate()+(socialZoom==='semaine'?6:2));
  if(start.getMonth()===end.getMonth())return `${start.getDate()} – ${end.getDate()} ${MOIS_FR[end.getMonth()]} ${end.getFullYear()}`;
  return `${start.getDate()} ${MOIS_FR[start.getMonth()]} – ${end.getDate()} ${MOIS_FR[end.getMonth()]} ${end.getFullYear()}`;
}

// Le seul écran où un sélecteur de mois n'a aucun sens est la sous-vue "Liste"
// du rétroplanning : elle affiche TOUS les posts, sans découpage mensuel (à la
// différence de la vue Liste des diffusions, qui est bien mensuelle). Y laisser
// des flèches actives donnait un contrôle qui ne changeait rien à l'écran.
function refreshMonthNavVisibility(){
  const nav=document.getElementById('month-nav');
  if(!nav)return;
  nav.style.display=(isSocialCalendarActive()&&socialSubview==='list')?'none':'';
}

// Toujours normaliser au 1er du mois. Avec setMonth() sur une date au 29, 30 ou
// 31, un mois plus court était purement sauté : 29 janvier + 1 mois donne un
// 29 février inexistant, que JS reporte au 1er mars — février disparaissait de
// la navigation. Le rétroplanning, lui, construisait déjà ses dates au 1er.
function shiftMonth(date, delta){
  return new Date(date.getFullYear(), date.getMonth()+delta, 1);
}

async function changeMonth(d){
  if(isSocialCalendarActive()){
    // Le garde-fou d'horizon ci-dessous porte sur la visibilité du planning de
    // DIFFUSION (créneaux média vendus). Le rétroplanning réseaux sociaux n'a
    // rien à voir : on n'y limite pas la projection dans le futur.
    if(socialZoom==='mois'){
      socialCalendarDate=shiftMonth(socialCalendarDate,d);
    }else{
      // zoom Semaine / 3 jours / Journée : les flèches avancent du pas du zoom
      const pas=socialZoom==='semaine'?7:socialZoom==='3jours'?3:1;
      const nd=new Date(socialCalendarDate);
      nd.setDate(nd.getDate()+pas*d);
      socialCalendarDate=nd;
    }
    updateMonthLabel();
    renderSocialCalendar();
    return;
  }
  if(role!=='edit'&&d>0){
    const maxDate=new Date(); maxDate.setMonth(maxDate.getMonth()+(meta.horizonMois||3));
    const next=shiftMonth(currentDate,d);
    if(next.getFullYear()>maxDate.getFullYear()||(next.getFullYear()===maxDate.getFullYear()&&next.getMonth()>maxDate.getMonth())){
      showToast(`Visibilité limitée à ${meta.horizonMois||3} mois à l'avance`,'warning');
      return;
    }
  }
  currentDate=shiftMonth(currentDate,d);
  await loadData();renderCalendar();
  if(document.getElementById('view-reporting').classList.contains('active')) loadReporting();
  if(document.getElementById('view-list').classList.contains('active')) renderList();
}
// ── FUZZY SEARCH ─────────────────────────────────────────────────────────────
let allEmissions = []; // cache for search
let searchSelected = -1;

// Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_,i) => Array.from({length: n+1}, (_,j) => j===0?i:0));
  for (let j=1;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function fuzzyScore(query, target) {
  if (!target) return 0;
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const t = target.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (t.includes(q)) return 100; // exact substring = top score
  // word-level match
  const words = q.split(/\s+/);
  const wordMatch = words.every(w => t.includes(w));
  if (wordMatch) return 90;
  // token partial
  const anyWord = words.some(w => t.includes(w));
  if (anyWord) return 70;
  // fuzzy via levenshtein on each word
  const minDist = Math.min(...words.map(w => {
    const tWords = t.split(/\s+/);
    return Math.min(...tWords.map(tw => levenshtein(w, tw)));
  }));
  const maxLen = Math.max(...words.map(w=>w.length));
  if (minDist <= Math.max(1, Math.floor(maxLen * 0.4))) return Math.max(10, 60 - minDist * 15);
  return 0;
}

async function loadAllEmissions() {
  allEmissions = await fetch(`${API}/emissions`).then(r => r.json());
}

async function onSearchInput(val) {
  searchQuery = val;
  searchSelected = -1;
  if (!val.trim()) { closeDropdown(); await loadData(); renderCalendar(); return; }
  if (!allEmissions.length) await loadAllEmissions();

  // Score each emission
  const scored = allEmissions.map(e => {
    const s = Math.max(
      fuzzyScore(val, e.entreprise),
      fuzzyScore(val, e.secteur) * 0.8,
    );
    return { e, s };
  }).filter(x => x.s > 0).sort((a,b) => b.s - a.s).slice(0, 8);

  if (!scored.length) { closeDropdown(); return; }
  renderDropdown(scored.map(x => x.e));
}

function onSearchKey(event) {
  if (event.key === 'Enter' && document.getElementById('search-input').value.trim().toLowerCase() === 'ranzo') {
    event.preventDefault();
    triggerStrawberryRain();
    return;
  }
  const dd = document.getElementById('search-dropdown');
  const items = dd.querySelectorAll('.search-dd-item');
  if (event.key === 'ArrowDown') { searchSelected = Math.min(searchSelected+1, items.length-1); highlightItem(items); event.preventDefault(); }
  else if (event.key === 'ArrowUp') { searchSelected = Math.max(searchSelected-1, 0); highlightItem(items); event.preventDefault(); }
  else if (event.key === 'Enter' && searchSelected >= 0) { items[searchSelected]?.click(); event.preventDefault(); }
  else if (event.key === 'Escape') { closeDropdown(); }
}

// ── EASTER EGG 🍓 ─────────────────────────────────────────────────────────────
function triggerStrawberryRain(){
  document.getElementById('search-input').value = '';
  onSearchInput('');
  closeDropdown();
  const fruit = FRUITS_MOIS[currentDate.getMonth()];
  const n = 45;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'strawberry-drop';
    el.textContent = fruit;
    el.style.left = (Math.random()*100) + 'vw';
    el.style.fontSize = (18 + Math.random()*22) + 'px';
    const dur = 2.2 + Math.random()*2.3;
    el.style.animationDuration = dur + 's';
    el.style.animationDelay = (Math.random()*1) + 's';
    document.body.appendChild(el);
    setTimeout(()=>el.remove(), (dur+1.2)*1000);
  }
  showToast(`${fruit} Ranzo !`,'success');
}

function highlightItem(items) {
  items.forEach((el, i) => el.style.background = i === searchSelected ? 'var(--accent-dim)' : '');
}

function renderDropdown(results) {
  const dd = document.getElementById('search-dropdown');
  dd.innerHTML = results.map((e, i) => {
    const dateStr = formatDateFR(e.date_diffusion);
    const isBdc = e.statut === 'bdc_attente';
    return `<div class="search-dd-item" onclick="jumpToEmission(${e.id}, '${e.date_diffusion}', '${e.media}')"
      style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.1s"
      onmouseenter="this.style.background='var(--accent-dim)'" onmouseleave="this.style.background=''">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.entreprise}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:1px">${e.media} · ${dateStr}${e.secteur?' · '+e.secteur:''}</div>
      </div>
      ${isBdc?'<span style="font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;background:var(--bdc-bg);color:var(--bdc-text)">BDC</span>':''}
    </div>`;
  }).join('');
  dd.style.display = 'block';
}

async function jumpToEmission(id, date, media) {
  closeDropdown();
  document.getElementById('search-input').value = '';
  searchQuery = '';

  // Switch to correct media tab
  currentMedia = media;
  document.querySelectorAll('.media-tab').forEach(el => el.classList.toggle('active', el.textContent === media));

  // Switch to correct month
  const [y, m] = date.split('-').map(Number);
  currentDate = new Date(y, m-1, 1);

  await loadData();
  renderCalendar();

  // Switch to calendar view
  switchView('calendar');

  // Scroll & highlight
  setTimeout(() => {
    const card = document.querySelector(`.emission-card[onclick="openEmission(${id})"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '2px solid var(--accent)';
      card.style.outlineOffset = '2px';
      setTimeout(() => { card.style.outline = ''; card.style.outlineOffset = ''; }, 2500);
    }
  }, 150);
}

function closeDropdown() {
  document.getElementById('search-dropdown').style.display = 'none';
}

// Close dropdown on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) closeDropdown();
});
async function toggleBdcFilter(){bdcFilterActive=!bdcFilterActive;document.getElementById('bdc-filter').classList.toggle('active',bdcFilterActive);await loadData();renderCalendar();}

// ── FILTRE "MES ÉMISSIONS" ────────────────────────────────────────────────────
async function onRespFilterChange(){
  respFilter=document.getElementById('resp-filter').value;
  await loadData();renderCalendar();
  if(document.getElementById('view-list').classList.contains('active'))renderList();
  loadAProgrammer();
}

// ── ALERTE "À ASSIGNER EN RETARD" ─────────────────────────────────────────────
async function checkRetardAlerte(){
  if(role!=='edit')return;
  const rows=await fetch(`${API}/emissions/alerte-retard`).then(r=>r.json());
  const badge=document.getElementById('retard-badge');
  if(rows.length){
    badge.style.display='flex';
    document.getElementById('retard-count').textContent=rows.length;
  }else{
    badge.style.display='none';
  }
}
async function showRetardList(){
  const rows=await fetch(`${API}/emissions/alerte-retard`).then(r=>r.json());
  document.getElementById('modal-title').textContent=`⚠️ ${rows.length} diffusion(s) à assigner en urgence`;
  document.getElementById('modal-body').innerHTML = rows.length ? `<div class="semaine-pills" style="flex-direction:column">
    ${rows.map(e=>`<div class="a-programmer-card" style="box-shadow:inset 3px 0 0 var(--red);cursor:pointer" onclick="openEmission(${e.id})">
      <div class="adc-entreprise">${e.entreprise} <span style="color:var(--red);font-weight:700">— ${formatDateFR(e.date_diffusion)}</span></div>
      <div class="adc-media">${e.media}${e.format?' · '+e.format:''}</div>
    </div>`).join('')}
  </div>` : '<p style="color:var(--text-muted);text-align:center">Tout est assigné 🎉</p>';
  document.getElementById('modal-footer').innerHTML=`<button class="btn-secondary" onclick="closeModal()">Fermer</button>`;
  document.getElementById('modal-overlay').style.display='flex';
}

// ── SEMAINE POPUP ────────────────────────────────────────────────────────────
let semaineData = null;
// Émission actuellement ouverte dans la modale — utilisé par saveEmission()
// pour retomber sur les valeurs montant/upsell existantes quand ces champs ne
// sont pas rendus (compte non-admin), plutôt que les écraser à 0.
let currentEmissionData = null;
async function fetchSemaineData(){
  try{
    semaineData=await fetch(`${API}/reporting/semaine`).then(r=>r.json());
    const btn=document.getElementById('semaine-fab');
    if(!semaineData.emissions.length){btn.style.display='none';return false;}
    btn.style.display='flex';
    btn.textContent=`📅 ${semaineData.emissions.length}`;
    return true;
  }catch(e){return false;}
}
// Ne s'ouvre plus tout seul au chargement (c'était une interruption systématique
// à chaque visite) — on se contente de préparer le badge du bouton flottant
// (semaine-fab), que l'utilisateur ouvre lui-même quand il le souhaite.
async function showSemaineBanner(){
  await fetchSemaineData();
}
function openSemaineModal(){
  if(!semaineData||!semaineData.emissions.length)return;
  const byDay={};
  semaineData.emissions.forEach(e=>{if(!byDay[e.date_diffusion])byDay[e.date_diffusion]=[];byDay[e.date_diffusion].push(e);});
  const pills=Object.entries(byDay).map(([date,ems])=>
    `<div class="semaine-pill"><div class="pill-date">${formatDateFR(date)}</div>${ems.map(e=>`<div class="pill-name">${e.entreprise} <span style="color:var(--text-muted);font-size:10px">— ${e.media}</span></div>`).join('')}</div>`
  ).join('');
  document.getElementById('modal-title').textContent=`📅 Diffusions cette semaine — ${formatDateFR(semaineData.semaine_debut)} › ${formatDateFR(semaineData.semaine_fin)}`;
  document.getElementById('modal-body').innerHTML=`<div class="semaine-pills">${pills}</div>`;
  document.getElementById('modal-footer').innerHTML=`<button class="btn-secondary" onclick="closeModal()">Fermer</button>`;
  document.getElementById('modal-overlay').style.display='flex';
}

// ── NOTIF PERSO "À PROGRAMMER" (Eva/Flavie) ───────────────────────────────────
// Badge toujours visible + popup auto le lundi après 14h (1x/jour), même contenu que la notif email.
let myAProgData=null;
async function checkMyAProgrammer(){
  try{
    myAProgData=await fetch(`${API}/a-programmer/perso?nom=${encodeURIComponent(myName)}`).then(r=>r.json());
  }catch(e){return;}
  const total=myAProgData.assignees.length+myAProgData.nonAssignees.length;
  const badge=document.getElementById('perso-aprog-badge');
  if(myAProgData.assignees.length||myAProgData.nonAssignees.length){
    badge.style.display='flex';
    document.getElementById('perso-aprog-count').textContent=myAProgData.assignees.length;
  }else{
    badge.style.display='none';
  }
  const now=new Date();
  const isLundiApres14h=now.getDay()===1&&now.getHours()>=14;
  const todayKey=`aprog-notif-${myName}-${now.toISOString().slice(0,10)}`;
  if(isLundiApres14h&&!localStorage.getItem(todayKey)&&total>0){
    localStorage.setItem(todayKey,'1');
    openMyAProgrammerModal();
  }
}
function openMyAProgrammerModal(){
  if(!myAProgData)return;
  const renderCol=(titre,couleur,rows)=>`
    <div style="flex:1;min-width:0">
      <div style="color:${couleur};font-weight:700;margin-bottom:8px">${titre} (${rows.length})</div>
      ${rows.length?rows.map(e=>`<div class="a-programmer-card" style="cursor:pointer" onclick="closeModal();openEmission(${e.id})">
        <div class="adc-entreprise">${e.entreprise}</div>
        <div class="adc-media">${e.media}${e.format?' · '+e.format:''}</div>
      </div>`).join(''):'<div style="color:var(--text-muted);font-size:13px">Aucune 🎉</div>'}
    </div>`;
  document.getElementById('modal-title').textContent=`📌 À programmer — ${myName}`;
  document.getElementById('modal-body').innerHTML=`<div style="display:flex;gap:16px">
    ${renderCol(`Assignées à ${myName}`,'#2563eb',myAProgData.assignees)}
    ${renderCol('Non assignées','#d97706',myAProgData.nonAssignees)}
  </div>`;
  document.getElementById('modal-footer').innerHTML=`<button class="btn-secondary" onclick="closeModal()">Fermer</button>`;
  document.getElementById('modal-overlay').style.display='flex';
}

// ── NOTIF "C-LEVEL" (Flavie/Eva/Lola, 3 colonnes) ─────────────────────────────
let clevelAProgData=null;
async function checkCLevelAProgrammer(){
  try{
    clevelAProgData=await fetch(`${API}/a-programmer/clevel`).then(r=>r.json());
  }catch(e){return;}
  const total=Object.values(clevelAProgData).reduce((s,rows)=>s+rows.length,0);
  const badge=document.getElementById('clevel-aprog-badge');
  if(total>0){
    badge.style.display='flex';
    document.getElementById('clevel-aprog-count').textContent=total;
  }else{
    badge.style.display='none';
  }
  const now=new Date();
  const isLundiApres14h=now.getDay()===1&&now.getHours()>=14;
  const todayKey=`aprog-notif-clevel-${now.toISOString().slice(0,10)}`;
  if(isLundiApres14h&&!localStorage.getItem(todayKey)&&total>0){
    localStorage.setItem(todayKey,'1');
    openCLevelAProgrammerModal();
  }
}
function openCLevelAProgrammerModal(){
  if(!clevelAProgData)return;
  const couleurs={Flavie:'#2563eb',Eva:'#7c3aed',Lola:'#059669'};
  const renderCol=(titre,couleur,rows)=>`
    <div style="flex:1;min-width:0">
      <div style="color:${couleur};font-weight:700;margin-bottom:8px">${titre} (${rows.length})</div>
      ${rows.length?rows.map(e=>`<div class="a-programmer-card" style="cursor:pointer" onclick="closeModal();openEmission(${e.id})">
        <div class="adc-entreprise">${e.entreprise}</div>
        <div class="adc-media">${e.media}${e.format?' · '+e.format:''}</div>
      </div>`).join(''):'<div style="color:var(--text-muted);font-size:13px">Aucune 🎉</div>'}
    </div>`;
  document.getElementById('modal-title').textContent='📌 À programmer — vue C-level';
  document.getElementById('modal-body').innerHTML=`<div style="display:flex;gap:16px">
    ${['Flavie','Eva','Lola'].map(nom=>renderCol(nom,couleurs[nom],clevelAProgData[nom]||[])).join('')}
  </div>`;
  document.getElementById('modal-footer').innerHTML=`<button class="btn-secondary" onclick="closeModal()">Fermer</button>`;
  document.getElementById('modal-overlay').style.display='flex';
}

// ── CLIENTS "À PROGRAMMER" (panneau latéral + drag & drop) ────────────────────
// Regroupe les émissions dont le média était ambigu et/ou la date de diffusion
// manquante côté Salesforce : à reclasser/dater manuellement.
async function loadAProgrammer(){
  if(role!=='edit')return;
  const panel=document.getElementById('a-programmer-panel');
  let url=`${API}/a-programmer`;
  if(respFilter)url+=`?resp_edit=${encodeURIComponent(respFilter)}`;
  const items=await fetch(url).then(r=>r.json());
  panel.style.display='block';
  if(!items.length){
    panel.innerHTML=`<div class="a-programmer-panel-title"><span>À programmer</span></div>
      <div class="a-programmer-empty">Glissez une diffusion ici pour la reprogrammer</div>`;
    return;
  }
  const collapsed=localStorage.getItem('aprogrammer-collapsed')==='1';
  panel.innerHTML=`<div class="a-programmer-panel-title" onclick="toggleAProgrammer()" style="cursor:pointer;user-select:none">
      <span>À programmer (${items.length})</span>
      <span id="aprogrammer-toggle" style="margin-left:auto;font-size:11px;font-weight:400">${collapsed?'▼ Voir':'▲ Réduire'}</span>
    </div>
    <div id="aprogrammer-cards-wrap" style="${collapsed?'display:none':''}">
      ${items.map(e=>`<div class="a-programmer-card" draggable="true" ondragstart="dragStartAProgrammer(event,${e.id})" onclick="openEmission(${e.id})" title="Glisser vers une date, ou cliquer pour la saisir">
        <div class="adc-entreprise">${e.entreprise}</div>
        <div class="adc-media">${e.media}${e.format?' · '+e.format:''}</div>
      </div>`).join('')}
    </div>`;
}
function toggleAProgrammer(){
  const wrap=document.getElementById('aprogrammer-cards-wrap');
  const btn=document.getElementById('aprogrammer-toggle');
  if(!wrap)return;
  const nowCollapsed=wrap.style.display!=='none';
  wrap.style.display=nowCollapsed?'none':'';
  btn.textContent=nowCollapsed?'▼ Voir':'▲ Réduire';
  localStorage.setItem('aprogrammer-collapsed',nowCollapsed?'1':'0');
}

let draggedItem=null; // { id, fromAProgrammer: bool }
function dragStartAProgrammer(event,id){
  event.stopPropagation();
  draggedItem={id,fromAProgrammer:true};
  event.dataTransfer.setData('text/plain',id);
  event.dataTransfer.effectAllowed='move';
}
function dragStartEmission(event,id){
  event.stopPropagation();
  draggedItem={id,fromAProgrammer:false};
  event.dataTransfer.setData('text/plain',id);
  event.dataTransfer.effectAllowed='move';
}
function allowDrop(event){
  event.preventDefault();
  event.currentTarget.classList.add('drag-over');
}
async function dropOnDay(event,dateStr){
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  if(!draggedItem)return;
  const {id,fromAProgrammer}=draggedItem;
  const payload={date_diffusion:dateStr};
  if(fromAProgrammer)payload.statut='confirme';
  const r=await fetch(`${API}/emissions/${id}`,{
    method:'PATCH',
    headers:{'Content-Type':'application/json','role':role},
    body:JSON.stringify(payload)
  });
  const d=await r.json();
  draggedItem=null;
  if(d.alertes&&d.alertes.length)alert(d.alertes.join('\n'));
  const updated=await fetch(`${API}/emissions/${id}`).then(r=>r.json());
  // Si l'émission déposée est dans un autre média que celui affiché, on bascule dessus automatiquement
  if(updated.media!==currentMedia){
    await jumpToEmission(id,dateStr,updated.media);
  }else{
    await loadData();renderCalendar();
    setTimeout(()=>{
      const card=document.querySelector(`.emission-card[onclick="openEmission(${id})"]`);
      if(card){
        card.scrollIntoView({behavior:'smooth',block:'center'});
        card.style.outline='2px solid var(--accent)';card.style.outlineOffset='2px';
        setTimeout(()=>{card.style.outline='';card.style.outlineOffset='';},2500);
      }
    },150);
  }
  loadAProgrammer();
  if(role==='edit')fetchSemaineData();
}

// ── RETOUR CALENDRIER → PANNEAU "À PROGRAMMER" ────────────────────────────────
function allowDropAProgrammer(event){
  event.preventDefault();
  document.getElementById('a-programmer-panel').classList.add('drag-over-panel');
}
async function dropOnAProgrammer(event){
  event.preventDefault();
  document.getElementById('a-programmer-panel').classList.remove('drag-over-panel');
  if(!draggedItem||draggedItem.fromAProgrammer)return; // déjà dans le panneau, rien à faire
  const {id}=draggedItem;
  draggedItem=null;
  const r=await fetch(`${API}/emissions/${id}`,{
    method:'PATCH',
    headers:{'Content-Type':'application/json','role':role},
    body:JSON.stringify({statut:'a_programmer'})
  });
  const d=await r.json();
  if(d.alertes&&d.alertes.length)alert(d.alertes.join('\n'));
  await loadData();renderCalendar();loadAProgrammer();
  if(role==='edit')fetchSemaineData();
  showToast('Renvoyé vers "À programmer" ✓','success');
}
document.addEventListener('dragleave', e => {
  if(e.target.classList&&e.target.classList.contains('cal-day'))e.target.classList.remove('drag-over');
  if(e.target.id==='a-programmer-panel')e.target.classList.remove('drag-over-panel');
  if(e.target.classList&&e.target.classList.contains('social-cal-day'))e.target.classList.remove('drag-over-idea');
});

// ── BOÎTE À IDÉES (rétroplanning réseaux sociaux) — v1 ───────────────────────
// Même principe que "À programmer" ci-dessus : panneau latéral de cartes
// glissables, sauf que les idées sont saisies à la main (pas de source auto
// comme les diffusions Salesforce) et qu'on ne glisse que dans un sens —
// idée -> jour du calendrier (pas de retour post -> idée pour cette v1).
async function loadIdeaBox(){
  if(role!=='edit'&&role!=='com')return;
  socialIdeasCache=await fetch(`${API}/social-ideas`,{headers:{role}}).then(r=>r.json());
  renderIdeaBox();
}
// Petits boutons à cocher/décocher pour les canaux (Instagram/LinkedIn/
// YouTube/Newsletter — cf. meta.channels, mêmes valeurs que pour un post
// déjà publié). onMousedown="event.preventDefault()" : évite que cliquer un
// chip ne fasse perdre le focus du champ titre juste à côté (sinon le blur
// déclenche saveEditIdea() avant que le clic sur le chip n'ait eu lieu).
function ideaChannelChipsHtml(selectedSet,toggleFn){
  return `<div class="idc-channels">${(meta.channels||[]).map(c=>`
    <button type="button" class="idc-channel-chip ${selectedSet.has(c)?'active':''}"
      onmousedown="event.preventDefault()" onclick="event.stopPropagation();${toggleFn}('${c}')">${SOCIAL_CHANNEL_ICON[c]||''} ${c}</button>
  `).join('')}</div>`;
}
function toggleNewIdeaChannel(c){
  newIdeaChannels.has(c)?newIdeaChannels.delete(c):newIdeaChannels.add(c);
  renderIdeaBox();
}
function toggleEditIdeaChannel(c){
  editingIdeaChannels.has(c)?editingIdeaChannels.delete(c):editingIdeaChannels.add(c);
  renderIdeaBox();
}
function renderIdeaBox(){
  const panel=document.getElementById('idea-box-panel');
  if(!panel)return;
  const toggleBtn=document.getElementById('idea-box-toggle-btn');
  if(toggleBtn)toggleBtn.textContent=socialIdeasCache.length?`💡 Idées (${socialIdeasCache.length})`:'💡 Idées';
  const addRowHtml=`<div class="idea-box-add-row-wrap">
      ${ideaChannelChipsHtml(newIdeaChannels,'toggleNewIdeaChannel')}
      <div class="idea-box-add-row">
        <input type="text" id="idea-box-new-title" placeholder="Nouvelle idée…" onkeydown="if(event.key==='Enter')submitNewIdea()">
        <button onclick="submitNewIdea()">+ Ajouter</button>
      </div>
    </div>`;
  if(!socialIdeasCache.length){
    panel.innerHTML=`<div class="idea-box-panel-title"><span>💡 Boîte à idées</span></div>
      <div class="idea-box-empty">Aucune idée pour l'instant — glissez-en une sur le calendrier une fois ajoutée.</div>
      ${addRowHtml}`;
    return;
  }
  panel.innerHTML=`<div class="idea-box-panel-title"><span>💡 Boîte à idées (${socialIdeasCache.length})</span></div>
    <div id="idea-box-cards-wrap">
      ${socialIdeasCache.map(idea=>{
        const editing=editingIdeaId===idea.id;
        const chans=socialChannelsOf(idea);
        return `<div class="idea-box-card" draggable="${!editing}" ondragstart="dragStartIdea(event,${idea.id})" title="${editing?'':'Glisser vers une date du calendrier, ou cliquer le titre pour le modifier'}">
        <span class="idc-del" onclick="event.stopPropagation();deleteIdea(${idea.id})" title="Supprimer cette idée">✕</span>
        ${editing
          ? `<input type="text" class="idc-title-input" id="idea-box-edit-input-${idea.id}" value="${idea.title.replace(/"/g,'&quot;')}"
               onclick="event.stopPropagation()"
               onkeydown="event.stopPropagation();if(event.key==='Enter'){event.preventDefault();saveEditIdea(${idea.id});}else if(event.key==='Escape'){event.preventDefault();cancelEditIdea();}"
               onblur="saveEditIdea(${idea.id})">
             ${ideaChannelChipsHtml(editingIdeaChannels,'toggleEditIdeaChannel')}`
          : `<div class="idc-title" onclick="event.stopPropagation();startEditIdea(${idea.id})" title="Cliquer pour modifier">${idea.title}</div>
             ${chans.length?`<div class="idc-channels">${chans.map(c=>`<span class="idc-channel-chip">${SOCIAL_CHANNEL_ICON[c]||''} ${c}</span>`).join('')}</div>`:''}`}
      </div>`;
      }).join('')}
    </div>
    ${addRowHtml}`;
  if(editingIdeaId!=null){
    const input=document.getElementById(`idea-box-edit-input-${editingIdeaId}`);
    if(input){input.focus();input.select();}
  }
}
function startEditIdea(id){
  editingIdeaId=id;
  const idea=socialIdeasCache.find(i=>i.id===id);
  editingIdeaChannels=new Set(idea?socialChannelsOf(idea):[]);
  renderIdeaBox();
}
function cancelEditIdea(){
  editingIdeaId=null;
  renderIdeaBox();
}
async function saveEditIdea(id){
  if(editingIdeaId!==id)return; // déjà sauvegardé/annulé (blur après Enter/Escape)
  const input=document.getElementById(`idea-box-edit-input-${id}`);
  const title=input?input.value.trim():'';
  const channel=[...editingIdeaChannels];
  editingIdeaId=null;
  const current=socialIdeasCache.find(i=>i.id===id);
  const unchanged=current&&title===current.title&&channel.join(',')===socialChannelsOf(current).join(',');
  if(!title||unchanged){renderIdeaBox();return;}
  await fetch(`${API}/social-ideas/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',role},body:JSON.stringify({title,channel})});
  loadIdeaBox();
}
async function submitNewIdea(){
  const input=document.getElementById('idea-box-new-title');
  const title=input.value.trim();
  if(!title)return;
  const channel=[...newIdeaChannels];
  input.value='';
  newIdeaChannels=new Set();
  await fetch(`${API}/social-ideas`,{method:'POST',headers:{'Content-Type':'application/json',role},body:JSON.stringify({title,channel})});
  loadIdeaBox();
}
async function deleteIdea(id){
  await fetch(`${API}/social-ideas/${id}`,{method:'DELETE',headers:{role}});
  loadIdeaBox();
}
function dragStartIdea(event,id){
  event.stopPropagation();
  const idea=socialIdeasCache.find(i=>i.id===id);
  if(!idea)return;
  draggedIdea=idea;
  event.dataTransfer.setData('text/plain',id);
  event.dataTransfer.effectAllowed='move';
}
function allowDropIdeaBox(event){
  if(!draggedIdea)return;
  event.preventDefault();
  event.currentTarget.classList.add('drag-over-idea');
}
function dropOnIdeaBox(event,dateStr){
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over-idea');
  if(!draggedIdea)return;
  const idea=draggedIdea;
  draggedIdea=null;
  openCreateSocialPostModal(dateStr,idea);
}
// Popover ancré sous le bouton "💡 Idées" (même principe que le filtre canaux
// juste à côté dans la barre d'outils, cf. toggleSocialChannelFilterMenu) —
// plutôt qu'un panneau fixe sous le header, qui chevauchait cette barre
// d'outils sur cet onglet.
function toggleIdeaBoxMenu(event){
  const menu=document.getElementById('idea-box-panel');
  const willOpen=menu.style.display==='none';
  document.getElementById('social-channel-filter-menu').style.display='none';
  if(!willOpen){menu.style.display='none';return;}
  renderIdeaBox();
  const rect=event.currentTarget.getBoundingClientRect();
  const width=280;
  menu.style.left=`${Math.max(8,rect.right-width)}px`;
  menu.style.top=`${rect.bottom+6}px`;
  menu.style.display='block';
}
document.addEventListener('click',e=>{
  if(!e.target.closest('#idea-box-wrap'))document.getElementById('idea-box-panel').style.display='none';
});

// ── CALENDRIER ──────────────────────────────────────────────────────────────
// Option d'affichage des mardis/jeudis (jours NON diffusés) : colonnes grisées
// "Pas de diffusion", sans drop ni bouton d'ajout. Utile pour repérer
// visuellement une éventuelle diffusion orpheline sur ces jours (le backend
// les renvoie désormais automatiquement en "à programmer").
let showMarJeu = localStorage.getItem('planning-show-marjeu')==='1';
function toggleMarJeu(){
  showMarJeu = !showMarJeu;
  localStorage.setItem('planning-show-marjeu', showMarJeu?'1':'0');
  renderCalendar();
}

function renderCalendar(){
  const y=currentDate.getFullYear(),m=currentDate.getMonth();
  updateMonthLabel();   // libellé partagé avec le rétroplanning, cf. changeMonth
  setFaviconEmoji(FRUITS_MOIS[m]);
  const lastDay=new Date(y,m+1,0);
  const today=new Date();
  const slotsByDate={};slotMap.forEach(s=>{slotsByDate[s.date_diffusion]=s;});
  const emByDate={};emissions.forEach(e=>{if(!emByDate[e.date_diffusion])emByDate[e.date_diffusion]=[];emByDate[e.date_diffusion].push(e);});
  const blockedSet=new Set(joursBlockes.filter(j=>!j.media||j.media===currentMedia).map(j=>j.date));
  const totalSlots=meta.slots[currentMedia]||1;

  const weeks=[];
  let cur=new Date(y,m,1);
  const dow=cur.getDay()||7;cur.setDate(cur.getDate()-(dow-1));
  while(true){
    const week=[];for(let d=0;d<7;d++){week.push(new Date(cur));cur.setDate(cur.getDate()+1);}
    weeks.push(week);
    if(cur>lastDay&&(cur.getDay()===1||cur.getDay()===0))break;
  }

  const dayIdx = showMarJeu ? [0,1,2,3,4] : [0,2,4]; // indices dans week[] (0=lundi … 4=vendredi)
  const dayNames = showMarJeu ? ['LUNDI','MARDI','MERCREDI','JEUDI','VENDREDI'] : ['LUNDI','MERCREDI','VENDREDI'];
  let html=`<div class="calendar-grid${showMarJeu?' marjeu':''}">`;
  html+='<div class="cal-header" style="border-right:1px solid var(--border)"></div>';
  dayNames.forEach((j,i)=>html+=`<div class="cal-header"${i<dayNames.length-1?' style="border-right:1px solid var(--border)"':''}>${j}</div>`);

  weeks.forEach((week,wi)=>{
    html+=`<div class="cal-week-label" style="border-right:1px solid var(--border);border-top:1px solid var(--border)">S${wi+1}</div>`;
    dayIdx.forEach((dowIdx,di)=>{
      const day=week[dowIdx];
      const isNonDiff = dowIdx===1 || dowIdx===3; // mardi / jeudi : jamais de diffusion
      const inMonth=day.getMonth()===m;
      const dateStr=fmtDate(day);
      const isToday=sameDay(day,today);
      const isFerie=FERIES.has(dateStr);
      const emList=emByDate[dateStr]||[];
      const slot=slotsByDate[dateStr];
      const utilises=slot?slot.utilises:0;
      const complet=utilises>=totalSlots;
      const presque=!complet&&utilises>=totalSlots-1&&totalSlots>1;
      const border=`border-top:1px solid var(--border)${di<dayIdx.length-1?';border-right:1px solid var(--border)':''}`;

      let cls='cal-day';
      if(!inMonth)cls+=' vide';
      else if(isFerie)cls+=' ferie';
      if(isNonDiff&&inMonth)cls+=' non-diffusable';

      html+=`<div class="${cls}" style="${border}" ${inMonth&&!isFerie&&!isNonDiff?`ondragover="allowDrop(event)" ondrop="dropOnDay(event,'${dateStr}')" data-date="${dateStr}"`:''}>`;
      if(inMonth){
        html+=`<div class="cal-day-header">
          <div class="cal-day-num${isToday?' today':''}">${day.getDate()}</div>
          ${isFerie?'<span class="cal-day-badge badge-ferie">Férié</span>':''}
          ${isNonDiff?'':`<span class="badge-slots${complet?' complet':presque?' presque':''}">
            ${utilises}<span style="color:var(--text-muted);font-weight:400">/${totalSlots}</span>
          </span>`}
        </div>`;
        if(isNonDiff)html+=`<div class="nd-label">Pas de diffusion</div>`;

        emList.filter(e=>e.statut!=='annule').forEach(e=>{
          const fc=fmtClass(e.format);
          const isBdc=e.statut==='bdc_attente';
          const isDecale=e.date_diffusion!==e.date_diffusion_originale;
          const cardCls=isBdc?'ec-bdc':(fc?`ec-${fc}`:'');
          const chipCls=isBdc?'chip-bdc':(fc?`chip-${fc}`:'chip-grey');
          const jDiff=Math.round((new Date(e.date_diffusion)-new Date(new Date().toDateString()))/86400000);
          const showJ=!e.resp_edit && jDiff>=0 && jDiff<=10;
          const jColor=jDiff<=2?'var(--red)':jDiff<=5?'var(--bdc-text)':'var(--text-dim)';
          html+=`<div class="emission-card ${cardCls}" ${role==='com'?'style="cursor:default"':`onclick="openEmission(${e.id})"`} ${role==='edit'?`draggable="true" ondragstart="dragStartEmission(event,${e.id})"`:''}>
            <div class="ec-entreprise">${e.entreprise}${e.sous_media?` <span style="font-weight:400;color:var(--text-muted);font-size:11px">· ${e.sous_media}</span>`:''}${isDecale?'<span class="decale-icon" title="Date décalée"> ⟳</span>':''}${showJ?`<span style="float:right;font-size:10px;font-weight:700;color:${jColor}">J-${jDiff}</span>`:''}</div>
            <div class="ec-detail">${e.resp_edit?'📋 '+e.resp_edit:'<span style="color:var(--bdc-text)">À assigner</span>'}${e.commercial&&e.commercial!=='/'?' · '+e.commercial:''}</div>
            <div class="ec-footer">
              ${e.format?`<span class="chip ${chipCls}">${e.format}</span>`:''}
              ${isBdc?'<span class="chip chip-bdc">BDC</span>':''}
              ${e.homepage?'<span class="chip chip-hp">HP</span>':''}
              ${e.homepage_eco?'<span class="chip chip-hp">HP Éco</span>':''}
            </div>
          </div>`;
        });
        if(role==='edit'&&!isFerie&&!isNonDiff&&!complet)html+=`<button class="add-slot-btn" onclick="openAddModal('${dateStr}')">+ Ajouter</button>`;
        if(role==='edit'&&!isNonDiff&&complet)html+=`<button class="add-slot-btn" onclick="openAddModal('${dateStr}',true)" style="font-size:10px">⚙ Forcer</button>`;
      }
      html+='</div>';
    });
  });
  html+='</div>';
  html+=`<button class="marjeu-toggle" onclick="toggleMarJeu()" title="Afficher/masquer les mardis et jeudis (jours sans diffusion)">${showMarJeu?'− masquer mar./jeu.':'+ mar./jeu.'}</button>`;
  document.getElementById('calendar-container').innerHTML=html;
}

// ── LISTE ────────────────────────────────────────────────────────────────────
let listAllCache=[];
let sortState={column:null,dir:'asc'};

function toggleSort(col){
  if(sortState.column===col){sortState.dir=sortState.dir==='asc'?'desc':'asc';}
  else{sortState.column=col;sortState.dir='asc';}
  document.querySelectorAll('.sort-arrow').forEach(el=>el.textContent='');
  const arrow=document.getElementById('sa-'+col);
  if(arrow)arrow.textContent=sortState.dir==='asc'?'▲':'▼';
  applyListFilters();
}

function sortValue(e,col){
  switch(col){
    case 'entreprise': return (e.entreprise||'').toLowerCase();
    case 'media': return (e.media||'').toLowerCase()+' '+(e.sous_media||'').toLowerCase();
    case 'date': return e.date_diffusion||'';
    case 'format': return (e.format||'').toLowerCase();
    case 'secteur': return (e.secteur||'').toLowerCase();
    case 'commercial': return (e.commercial||'').toLowerCase();
    case 'resp': return (e.resp_edit||'').toLowerCase();
    case 'ca': return e.montant||0;
    case 'upsell': return e.upsell||0;
    case 'statut': return (e.statut||'');
    default: return '';
  }
}

async function renderList(){
  const m=currentDate.getMonth()+1,y=currentDate.getFullYear();
  let url=`${API}/emissions?mois=${m}&annee=${y}`;
  if(searchQuery)url+=`&search=${encodeURIComponent(searchQuery)}`;
  if(bdcFilterActive)url+=`&statut=bdc_attente`;
  listAllCache=await fetch(url,{headers:{role}}).then(r=>r.json());
  refreshMsFilterButtons();
  applyListFilters();
}

/* ── Filtres multi-sélection de la vue Liste ──────────────────────────
   Chaque filtre catégoriel (Média, Semaine, Format, Resp. édito, Statut)
   est un Set de valeurs sélectionnées ; un Set vide = "Tous" (pas de filtre). */
const msFilters={media:new Set(),semaine:new Set(),format:new Set(),resp:new Set(),statut:new Set()};
const msFilterDefaultLabel={media:'Tous',semaine:'Toutes',format:'Tous',resp:'Tous',statut:'Tous'};

function msFilterOptionsFor(key){
  if(key==='media')return meta.medias.map(m=>({value:m,label:m}));
  if(key==='format')return [...new Set(listAllCache.map(e=>e.format).filter(Boolean))].sort().map(f=>({value:f,label:f}));
  if(key==='resp')return [{value:'_none',label:'Non assignées'},...RESP_EDIT_LIST.map(r=>({value:r,label:r}))];
  if(key==='statut')return [
    {value:'a_assigner',label:'À assigner'},
    {value:'bdc_attente',label:'BDC en attente'},
    {value:'confirme',label:'Confirmé'},
    {value:'annule',label:'Annulé'},
  ];
  if(key==='semaine'){
    const weeks=[...new Set(listAllCache.filter(e=>e.date_diffusion).map(e=>mondayOfWeek(e.date_diffusion)))].sort();
    return weeks.map(w=>{
      const fin=new Date(w+'T00:00:00'); fin.setDate(fin.getDate()+4);
      return {value:w,label:`Sem. du ${formatDateFR(w)} au ${formatDateFR(fmtDate(fin))}`};
    });
  }
  return [];
}

function msFilterButtonLabel(key){
  const sel=msFilters[key];
  if(sel.size===0)return msFilterDefaultLabel[key];
  const opts=msFilterOptionsFor(key);
  if(sel.size===1){
    const v=[...sel][0];
    return opts.find(o=>o.value===v)?.label||v;
  }
  return `${sel.size} sélectionnés`;
}

function refreshMsFilterButtons(){
  Object.keys(msFilters).forEach(key=>{
    const btn=document.getElementById(`msf-${key}-btn`);
    if(!btn)return;
    btn.textContent=msFilterButtonLabel(key);
    btn.classList.toggle('ms-filter-active',msFilters[key].size>0);
  });
}

/* Un seul menu partagé, sorti du tableau et positionné en fixed : le tableau
   (.table-card) a overflow:hidden pour ses coins arrondis, ce qui rognait les
   anciens popovers imbriqués dans chaque <th>. */
let msFilterOpenKey=null;

function closeMsFilterMenu(){
  msFilterOpenKey=null;
  const menu=document.getElementById('ms-filter-shared-menu');
  menu.style.display='none';
}

function positionMsFilterMenu(btn){
  const menu=document.getElementById('ms-filter-shared-menu');
  const rect=btn.getBoundingClientRect();
  const menuWidth=Math.max(170,rect.width);
  let left=rect.left;
  if(left+menuWidth>window.innerWidth-8)left=window.innerWidth-menuWidth-8;
  if(left<8)left=8;
  let top=rect.bottom+4;
  menu.style.left=`${left}px`;
  menu.style.top=`${top}px`;
  menu.style.width=`${menuWidth}px`;
  const menuRect=menu.getBoundingClientRect();
  if(menuRect.bottom>window.innerHeight-8){
    menu.style.top=`${Math.max(8,rect.top-menuRect.height-4)}px`;
  }
}

function renderMsFilterMenu(key){
  const menu=document.getElementById('ms-filter-shared-menu');
  const opts=msFilterOptionsFor(key);
  const sel=msFilters[key];
  if(!opts.length){
    menu.innerHTML='<div class="ms-filter-empty">Aucune option</div>';
    return;
  }
  menu.innerHTML=opts.map(o=>`
    <label class="ms-filter-item">
      <input type="checkbox" value="${o.value}" ${sel.has(o.value)?'checked':''} onchange="toggleMsFilterValue('${key}','${o.value}')">
      <span>${o.label}</span>
    </label>
  `).join('')+(sel.size?`<div class="ms-filter-sep"></div><button type="button" class="ms-filter-clear" onclick="clearMsFilter('${key}')">Tout désélectionner</button>`:'');
}

function toggleMsFilter(key,event){
  const willOpen=msFilterOpenKey!==key;
  closeMsFilterMenu();
  if(!willOpen)return;
  msFilterOpenKey=key;
  const btn=(event&&event.currentTarget)||document.getElementById(`msf-${key}-btn`);
  renderMsFilterMenu(key);
  const menu=document.getElementById('ms-filter-shared-menu');
  menu.style.display='block';
  positionMsFilterMenu(btn);
}

function toggleMsFilterValue(key,value){
  const sel=msFilters[key];
  if(sel.has(value))sel.delete(value);else sel.add(value);
  refreshMsFilterButtons();
  renderMsFilterMenu(key);
  applyListFilters();
}

function clearMsFilter(key){
  msFilters[key].clear();
  refreshMsFilterButtons();
  closeMsFilterMenu();
  applyListFilters();
}

document.addEventListener('click',e=>{
  if(!e.target.closest('.ms-filter')&&!e.target.closest('#ms-filter-shared-menu'))closeMsFilterMenu();
});
window.addEventListener('resize',()=>{ if(msFilterOpenKey)closeMsFilterMenu(); });
document.addEventListener('scroll',e=>{
  if(msFilterOpenKey&&e.target && e.target.closest && e.target.closest('.table-card'))closeMsFilterMenu();
},true);

function applyListFilters(){
  const fEntreprise=document.getElementById('lf-entreprise').value.trim().toLowerCase();
  const fSecteur=document.getElementById('lf-secteur').value.trim().toLowerCase();
  const fCommercial=document.getElementById('lf-commercial').value.trim().toLowerCase();

  const filtered=listAllCache.filter(e=>{
    if(fEntreprise&&!(e.entreprise||'').toLowerCase().includes(fEntreprise))return false;
    if(msFilters.media.size&&!msFilters.media.has(e.media))return false;
    if(msFilters.semaine.size&&(!e.date_diffusion||!msFilters.semaine.has(mondayOfWeek(e.date_diffusion))))return false;
    if(msFilters.format.size&&!msFilters.format.has(e.format))return false;
    if(fSecteur&&!(e.secteur||'').toLowerCase().includes(fSecteur))return false;
    if(fCommercial&&!(e.commercial||'').toLowerCase().includes(fCommercial))return false;
    if(msFilters.resp.size){
      const matchNone=msFilters.resp.has('_none')&&!e.resp_edit;
      const matchNamed=e.resp_edit&&msFilters.resp.has(e.resp_edit);
      if(!matchNone&&!matchNamed)return false;
    }
    if(msFilters.statut.size&&!msFilters.statut.has(e.statut))return false;
    return true;
  });

  if(sortState.column){
    const dir=sortState.dir==='asc'?1:-1;
    filtered.sort((a,b)=>{
      const va=sortValue(a,sortState.column), vb=sortValue(b,sortState.column);
      if(va<vb)return -1*dir;
      if(va>vb)return 1*dir;
      return 0;
    });
  }

  renderListRows(filtered);
  const caDiffusion=filtered.reduce((a,e)=>a+(e.montant||0),0);
  const caUpsell=filtered.reduce((a,e)=>a+(e.upsell||0),0);
  document.getElementById('stats-row').innerHTML=`
    <div class="stat-pill"><div class="stat-pill-val">${filtered.length}</div><div class="stat-pill-lbl">Diffusions</div></div>
    <div class="stat-pill"><div class="stat-pill-val" style="color:var(--bdc-text)">${filtered.filter(e=>e.statut==='bdc_attente').length}</div><div class="stat-pill-lbl">BDC en attente</div></div>
    <div class="stat-pill"><div class="stat-pill-val" style="color:var(--gold)">${filtered.filter(e=>e.statut==='a_assigner').length}</div><div class="stat-pill-lbl">À assigner</div></div>
    <div class="stat-pill"><div class="stat-pill-val" style="color:var(--green)">${filtered.filter(e=>e.statut==='confirme').length}</div><div class="stat-pill-lbl">Confirmées</div></div>
    ${caDiffusion&&canSeeBudget?`<div class="stat-pill"><div class="stat-pill-val" style="color:var(--accent)">${fmtCA(caDiffusion)}</div><div class="stat-pill-lbl">CA diffusion</div></div>`:''}
    ${caUpsell&&canSeeBudget?`<div class="stat-pill"><div class="stat-pill-val" style="color:var(--gold)">${fmtCA(caUpsell)}</div><div class="stat-pill-lbl">CA upsell</div></div>`:''}
    ${filtered.length!==listAllCache.length?`<span class="list-filter-reset" onclick="resetListFilters()">✕ Réinitialiser les filtres (${listAllCache.length} au total)</span>`:''}
  `;
}

function resetListFilters(){
  ['lf-entreprise','lf-secteur','lf-commercial'].forEach(id=>document.getElementById(id).value='');
  Object.keys(msFilters).forEach(key=>msFilters[key].clear());
  closeMsFilterMenu();
  refreshMsFilterButtons();
  applyListFilters();
}

function renderListRows(all){
  const tbody=document.getElementById('list-tbody');
  if(!all.length){tbody.innerHTML='<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:48px">Aucune diffusion ne correspond à ces filtres</td></tr>';return;}
  tbody.innerHTML=all.map(e=>{
    const fc=fmtClass(e.format);
    const isBdc=e.statut==='bdc_attente';
    const isDecale=e.date_diffusion!==e.date_diffusion_originale;
    return `<tr ${role==='com'?'style="cursor:default"':`onclick="openEmission(${e.id})"`} class="${isBdc?'td-bdc':''}">
      <td data-label="Entreprise"><strong>${e.entreprise}</strong>${isDecale?' <span style="color:var(--bdc-text)">⟳</span>':''}</td>
      <td data-label="Média" style="color:var(--text-dim)">${e.media}${e.sous_media?` <span style="color:var(--text-muted);font-size:11px">· ${e.sous_media}</span>`:''}</td>
      <td data-label="Date">${formatDateFR(e.date_diffusion)}</td>
      <td data-label="Format">${e.format?`<span class="fmt-strip" style="background:${fmtColor(e.format)}"></span>${e.format}`:'—'}</td>
      <td data-label="Secteur" style="color:var(--text-dim);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.secteur||'—'}</td>
      <td data-label="Commercial" style="color:var(--text-dim)">${e.commercial&&e.commercial!=='/'?e.commercial:'—'}</td>
      <td data-label="Resp. édito">${e.resp_edit||'<span style="color:var(--bdc-text);font-weight:500">À assigner</span>'}</td>
      ${canSeeBudget?`<td data-label="CA diffusion">${e.montant?'<strong style="color:var(--accent)">'+fmtCA(e.montant)+'</strong>':'—'}</td>`:''}
      ${canSeeBudget?`<td data-label="CA upsell">${e.upsell?'<strong style="color:var(--gold)">'+fmtCA(e.upsell)+'</strong>':'—'}</td>`:''}
      <td data-label="Statut">${statutBadge(e.statut)}</td>
    </tr>`;
  }).join('');
}

// ── REPORTING ────────────────────────────────────────────────────────────────
// ── SÉLECTEUR DE PÉRIODE ──────────────────────────────────────────────────────
let currentPeriodType = 'mois_courant';
let customDebut = null, customFin = null;

const PERIOD_LABELS = {
  mois_courant: 'Ce mois', mois_precedent: 'Mois précédent', mois_suivant: 'Mois suivant',
  semaine_courante: 'Cette semaine', semaine_precedente: 'Semaine dernière', semaine_suivante: 'Semaine suivante',
  custom: null
};

function togglePeriodMenu(e){
  e.stopPropagation();
  const menu=document.getElementById('period-menu');
  menu.style.display = menu.style.display==='none' ? 'block' : 'none';
}
document.addEventListener('click', e => {
  const menu=document.getElementById('period-menu');
  if(menu && menu.style.display!=='none' && !e.target.closest('.period')) menu.style.display='none';
});
function togglePeriodCustom(e){
  e.stopPropagation();
  const c=document.getElementById('period-custom');
  c.style.display = c.style.display==='none' ? 'block' : 'none';
}
function selectPeriod(type){
  currentPeriodType = type;
  document.getElementById('period-label').textContent = PERIOD_LABELS[type];
  document.getElementById('period-menu').style.display='none';
  loadReporting();
}
function applyCustomPeriod(){
  const d=document.getElementById('period-debut').value;
  const f=document.getElementById('period-fin').value;
  if(!d||!f){ showToast('Sélectionne les deux dates','warning'); return; }
  customDebut=d; customFin=f; currentPeriodType='custom';
  document.getElementById('period-label').textContent = `${formatDateFR(d)} → ${formatDateFR(f)}`;
  document.getElementById('period-menu').style.display='none';
  loadReporting();
}
function getPeriodRange(type){
  const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if(type==='mois_courant'||type==='mois_precedent'||type==='mois_suivant'){
    const now=new Date(currentDate);
    let m=now.getMonth(), y=now.getFullYear();
    if(type==='mois_precedent'){m--; if(m<0){m=11;y--;}}
    if(type==='mois_suivant'){m++; if(m>11){m=0;y++;}}
    const debut=new Date(y,m,1), fin=new Date(y,m+1,0);
    return {debut:fmt(debut), fin:fmt(fin)};
  }
  // semaines : ancrées sur aujourd'hui (lundi -> vendredi, jours de diffusion)
  const today=new Date();
  const dow=today.getDay()||7;
  let lundi=new Date(today); lundi.setDate(today.getDate()-(dow-1));
  if(type==='semaine_precedente') lundi.setDate(lundi.getDate()-7);
  if(type==='semaine_suivante') lundi.setDate(lundi.getDate()+7);
  const vendredi=new Date(lundi); vendredi.setDate(lundi.getDate()+4);
  return {debut:fmt(lundi), fin:fmt(vendredi)};
}

async function sendReportEmail(type, btn){
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Envoi…';
  try{
    const r = await fetch(`${API}/admin/test-report`, {
      method:'POST',
      headers:{'Content-Type':'application/json','role':role},
      body: JSON.stringify({type})
    });
    const d = await r.json();
    if(r.ok) showToast(d.message||'Rapport envoyé ✓','success');
    else showToast(d.error||'Erreur envoi','warning');
  }catch(e){
    showToast('Erreur réseau','warning');
  }
  btn.disabled = false; btn.textContent = original;
}

async function loadReporting(){
  let url;
  if(currentPeriodType==='custom'){
    url=`${API}/reporting?debut=${customDebut}&fin=${customFin}`;
  }else{
    const {debut,fin}=getPeriodRange(currentPeriodType);
    url=`${API}/reporting?debut=${debut}&fin=${fin}`;
  }
  const data=await fetch(url).then(r=>r.json());
  const caTotal=data.total.caDiffusion+data.total.caUpsell;
  const maxCA=Math.max(...data.byMedia.map(r=>(r.ca_diffusion||0)+(r.ca_upsell||0)),1);

  document.getElementById('report-kpis').innerHTML=`
    <div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:var(--accent)"></span>Diffusions</div><div class="kpi-val">${data.total.nb}</div><div class="kpi-lbl">Total période</div></div>
    <div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:var(--green)"></span>CA diffusion</div><div class="kpi-val" style="color:var(--green)">${fmtCA(data.total.caDiffusion)}</div><div class="kpi-lbl">Hors upsell</div></div>
    <div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:var(--gold)"></span>CA upsell</div><div class="kpi-val" style="color:var(--gold)">${fmtCA(data.total.caUpsell)}</div><div class="kpi-lbl">Upsell seul</div></div>
    <div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:var(--text-muted)"></span>Médias</div><div class="kpi-val" style="color:var(--text-dim)">${data.byMedia.length}</div><div class="kpi-lbl">Médias actifs</div></div>
    ${data.total.nb?`<div class="kpi-card"><div class="kpi-eyebrow"><span class="dot" style="background:var(--text-muted)"></span>Panier moyen</div><div class="kpi-val" style="color:var(--text-dim)">${caTotal&&data.total.nb?fmtCA(caTotal/data.total.nb):'—'}</div><div class="kpi-lbl">CA total / diffusion</div></div>`:''}
  `;
  document.getElementById('report-table').innerHTML=`<table>
    <thead><tr><th>Média</th><th>Diffusions</th><th>CA diffusion</th><th>CA upsell</th><th style="min-width:160px">Part</th></tr></thead>
    <tbody>${data.byMedia.map(r=>{
      const rTotal=(r.ca_diffusion||0)+(r.ca_upsell||0);
      return `<tr>
      <td><strong>${r.media}</strong></td>
      <td>${r.nb_emissions}</td>
      <td style="font-weight:600;color:var(--accent)">${fmtCA(r.ca_diffusion||0)}</td>
      <td style="font-weight:600;color:var(--gold)">${fmtCA(r.ca_upsell||0)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:11px;color:var(--text-dim);width:32px">${caTotal?Math.round(rTotal/caTotal*100):0}%</div>
          <div style="flex:1"><div class="ca-bar-wrap"><div class="ca-bar" style="width:${caTotal?(rTotal/maxCA*100):0}%"></div></div></div>
        </div>
      </td>
    </tr>`;}).join('')}</tbody>
  </table>`;
}

// ── MODAL ────────────────────────────────────────────────────────────────────
async function openEmission(id){
  const e=await fetch(`${API}/emissions/${id}`).then(r=>r.json());
  currentEmissionData=e; // conservé pour saveEmission() : ne pas écraser montant/upsell si les champs ne sont pas rendus (non-admin)
  const isEdit=role==='edit';
  const isBdc=e.statut==='bdc_attente';
  const isDecale=e.date_diffusion!==e.date_diffusion_originale;
  const showFigaro=e.media.includes('Figaro');
  const mediasOpts=meta.medias.map(m=>`<option value="${m}" ${m===e.media?'selected':''}>${m}</option>`).join('');
  document.getElementById('modal-title').textContent=e.entreprise;
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=`
    ${isBdc?'<div class="info-banner bdc">⏳ BDC en attente — diffusion réservée, contrat non signé</div>':''}
    ${isDecale?`<div class="info-banner warning">⟳ Date décalée — originale : ${formatDateFR(e.date_diffusion_originale)}</div>`:''}
    ${canSeeBudget&&(e.montant||e.upsell)?`<div class="info-banner neutral">💰 <strong style="color:var(--accent)">${fmtCA((e.montant||0)+(e.upsell||0))}</strong>${e.upsell?' <span style="color:var(--text-muted);font-size:11px">(dont '+fmtCA(e.upsell)+' upsell)</span>':''}</div>`:''}
    <div class="form-row">
      <div class="form-group"><label class="form-label">Entreprise</label><input class="form-input" id="edit-entreprise" value="${e.entreprise}" ${!isEdit?'disabled':''}></div>
      <div class="form-group"><label class="form-label">Commercial</label><input class="form-input" id="edit-commercial" value="${e.commercial||''}" ${!isEdit?'disabled':''}></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Média</label><select class="form-select" id="edit-media" ${!isEdit?'disabled':''} onchange="onEditMediaChange()">${mediasOpts}</select></div>
      <div class="form-group" id="edit-sousmedia-group" style="display:none"><label class="form-label">Média spécialisé</label><select class="form-select" id="edit-sousmedia" ${!isEdit?'disabled':''} onchange="updateEditFormats()"></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date de diffusion</label><input class="form-input" type="date" id="edit-date" value="${e.date_diffusion}" ${!isEdit?'disabled':''} onchange="onDateChange(this)"></div>
      <div class="form-group"><label class="form-label">Format</label><select class="form-select" id="edit-format" ${!isEdit?'disabled':''}></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Secteur</label><input class="form-input" id="edit-secteur" value="${e.secteur||''}" ${!isEdit?'disabled':''}></div>
      <div class="form-group"><label class="form-label">Resp. édito</label>
        <select class="form-select" id="edit-resp" ${!isEdit?'disabled':''}>
          <option value="">— À assigner —</option>
          ${RESP_EDIT_LIST.map(r=>`<option value="${r}" ${e.resp_edit===r?'selected':''}>${r}</option>`).join('')}
        </select>
      </div>
    </div>
    ${canSeeBudget?`<div class="form-row">
      <div class="form-group"><label class="form-label">Montant (€)</label><input class="form-input" type="number" id="edit-montant" value="${e.montant||''}"></div>
      <div class="form-group"><label class="form-label">Upsell (€)</label><input class="form-input" type="number" id="edit-upsell" value="${e.upsell||''}" placeholder="0"></div>
    </div>`:''}
    <div class="form-row">
      <div class="form-group"><label class="form-label">Statut</label>
        <select class="form-select" id="edit-statut" ${!isEdit?'disabled':''}>
          <option value="a_assigner" ${e.statut==='a_assigner'?'selected':''}>À assigner</option>
          <option value="bdc_attente" ${e.statut==='bdc_attente'?'selected':''}>BDC en attente</option>
          <option value="confirme" ${e.statut==='confirme'?'selected':''}>Confirmé</option>
          <option value="a_programmer" ${e.statut==='a_programmer'?'selected':''}>À programmer</option>
          <option value="annule" ${e.statut==='annule'?'selected':''}>Annulé</option>
        </select>
      </div>
    </div>
    ${showFigaro?`<div class="form-group"><label class="form-label">Homepage</label>
      <div class="checkbox-group">
        <label class="checkbox-label"><input type="checkbox" id="edit-hp" ${e.homepage?'checked':''} ${!isEdit?'disabled':''}> Homepage</label>
        <label class="checkbox-label"><input type="checkbox" id="edit-hpeco" ${e.homepage_eco?'checked':''} ${!isEdit?'disabled':''}> Homepage Éco</label>
      </div></div>`:''}
    <div class="form-group">
      <label class="form-label">Notes</label>
      ${isEdit?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
        <button type="button" class="btn-secondary" style="padding:4px 10px;font-size:11px" onclick="appendQuickNote('Script en attente')">📝 Script en attente</button>
        <button type="button" class="btn-secondary" style="padding:4px 10px;font-size:11px" onclick="appendQuickNote('Tournage confirmé')">🎬 Tournage confirmé</button>
        <button type="button" class="btn-secondary" style="padding:4px 10px;font-size:11px" onclick="appendQuickNote('Montage en cours')">✂️ Montage en cours</button>
        <button type="button" class="btn-secondary" style="padding:4px 10px;font-size:11px" onclick="appendQuickNote('Relance client')">📞 Relance client</button>
      </div>`:''}
      <textarea class="form-textarea" id="edit-notes" ${!isEdit?'disabled':''}>${e.notes||''}</textarea>
    </div>
  `;
  window._editCurrent={media:e.media,sousMedia:e.sous_media,format:e.format};
  onEditMediaChange(true);
  document.getElementById('modal-footer').innerHTML=isEdit?`
    <div class="modal-footer-group">
      <button class="btn-danger" onclick="annulerEmission(${e.id})">Annuler la diffusion</button>
      <button class="btn-hard-delete" onclick="hardDeleteEmission(${e.id},'${e.entreprise.replace(/'/g,"\\'")}')" title="Supprimer définitivement (irréversible)">🗑️</button>
    </div>
    <div class="modal-footer-group">
      ${e.sf_opportunity_id?`<button class="btn-secondary" onclick="resyncFromSalesforce(${e.id})" title="Relit l'Opportunité en direct dans Salesforce et met à jour Média/Format/Date/Secteur/Montant si ça a changé depuis">🔄 Resynchroniser</button>`:''}
      <button class="btn-secondary" onclick="closeModal()">Fermer</button>
      <button class="btn-primary" onclick="saveEmission(${e.id})">Enregistrer</button>
    </div>
  `:`<button class="btn-secondary" onclick="closeModal()">Fermer</button>`;
}
function onEditMediaChange(initial=false){
  const media=document.getElementById('edit-media').value;
  const isSpecialise=media==='Médias spécialisés';
  const grp=document.getElementById('edit-sousmedia-group');
  grp.style.display=isSpecialise?'':'none';
  if(isSpecialise){
    const current=initial&&window._editCurrent.media===media?window._editCurrent.sousMedia:'';
    const opts=(meta.sousMediasListe||[]).map(m=>`<option value="${m}" ${m===current?'selected':''}>${m}</option>`).join('');
    document.getElementById('edit-sousmedia').innerHTML=`<option value="">— Choisir —</option>${opts}`;
  }
  updateEditFormats(initial);
}
function updateEditFormats(initial=false){
  const media=document.getElementById('edit-media').value;
  const sousMedia=media==='Médias spécialisés'?document.getElementById('edit-sousmedia').value:null;
  const formats=sousMedia&&meta.sousMediasSpecialises[sousMedia]?meta.sousMediasSpecialises[sousMedia]:(meta.formats[media]||[]);
  const current=initial&&window._editCurrent.media===media?window._editCurrent.format:'';
  // Si la valeur réellement stockée ne fait pas partie des formats autorisés pour ce
  // média/sous-média (ex: valeur héritée d'une résolution SF différente, ou média changé
  // depuis), on l'affiche quand même — au lieu de la faire disparaître silencieusement —
  // pour ne pas laisser croire à tort que le format est "Article digital" (1re option par
  // défaut) et risquer d'écraser la vraie valeur au prochain Enregistrer.
  const opts = (current && !formats.includes(current)) ? [current, ...formats] : formats;
  document.getElementById('edit-format').innerHTML=opts.map(f=>`<option value="${f}" ${f===current?'selected':''}>${f}${(current===f&&!formats.includes(f))?' ⚠️ hors liste (à vérifier)':''}</option>`).join('');
}

function appendQuickNote(text){
  const ta=document.getElementById('edit-notes');
  const stamp=new Date().toLocaleDateString('fr-FR');
  ta.value = ta.value ? `${ta.value}\n[${stamp}] ${text}` : `[${stamp}] ${text}`;
}

async function saveEmission(id){
  const showFigaro=document.getElementById('edit-hp')!==null;
  const media=document.getElementById('edit-media').value;
  const payload={
    entreprise:document.getElementById('edit-entreprise').value.trim(),
    commercial:document.getElementById('edit-commercial').value.trim(),
    media,
    sous_media:media==='Médias spécialisés'?(document.getElementById('edit-sousmedia').value||null):null,
    date_diffusion:document.getElementById('edit-date').value,
    format:document.getElementById('edit-format').value,
    secteur:document.getElementById('edit-secteur').value,
    resp_edit:document.getElementById('edit-resp').value,
    statut:document.getElementById('edit-statut').value,
    notes:document.getElementById('edit-notes').value,
    // Champs non rendus pour un compte non-admin (voir openEmission) : on
    // retombe sur la valeur déjà connue plutôt que d'écraser à 0.
    montant:document.getElementById('edit-montant')?(parseFloat(document.getElementById('edit-montant').value)||0):(currentEmissionData?.montant||0),
    upsell:document.getElementById('edit-upsell')?(parseFloat(document.getElementById('edit-upsell').value)||0):(currentEmissionData?.upsell||0),
  };
  if(!payload.entreprise){showToast('Entreprise ne peut pas être vide','warning');return;}
  if(showFigaro){payload.homepage=document.getElementById('edit-hp').checked;payload.homepage_eco=document.getElementById('edit-hpeco').checked;}
  const r=await fetch(`${API}/emissions/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json','role':'edit'},body:JSON.stringify(payload)});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  closeModal();
  const onCalendar=document.getElementById('view-calendar').classList.contains('active');
  const onList=document.getElementById('view-list').classList.contains('active');
  if(media!==currentMedia&&onCalendar){
    await jumpToEmission(id,payload.date_diffusion,media);
  }else{
    if(media!==currentMedia){
      currentMedia=media;
      document.querySelectorAll('.media-tab').forEach(el=>el.classList.toggle('active',el.textContent===media));
    }
    await loadData();renderCalendar();
    if(onList)renderList();
  }
  loadAProgrammer();
  if(role==='edit'){fetchSemaineData();checkRetardAlerte();}
  d.alertes&&d.alertes.length?showToast(d.alertes.join('\n'),'warning'):showToast('Enregistré ✓','success');
}

async function annulerEmission(id){
  if(!confirm('Annuler cette diffusion ?'))return;
  await fetch(`${API}/emissions/${id}`,{method:'DELETE',headers:{'role':'edit'}});
  closeModal();await loadData();renderCalendar();loadAProgrammer();
  if(document.getElementById('view-list').classList.contains('active'))renderList();
  if(role==='edit')fetchSemaineData();
}

// Relit l'Opportunité en direct dans Salesforce (via l'API déjà connectée côté
// backend) et écrase les champs Média/Format/Date/Secteur/Montant s'ils ont
// changé depuis le webhook initial. Utile car le webhook SF ne capture
// l'Opportunité qu'une seule fois, au moment du passage en Fermée Gagnée —
// toute modif ultérieure côté Salesforce n'était jusqu'ici jamais reprise ici.
async function resyncFromSalesforce(id){
  if(!confirm('Relire cette Opportunité dans Salesforce et écraser Média/Format/Date/Secteur/Montant avec les valeurs actuelles ?'))return;
  const r=await fetch(`${API}/emissions/${id}/resync-sf`,{method:'POST',headers:{'role':'edit'}});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur lors de la resynchronisation','warning');return;}
  showToast(d.changements&&d.changements.length?`Resynchronisé ✓ — modifié : ${d.changements.join(', ')}`:'Resynchronisé — aucun changement détecté','success');
  await openEmission(id);
  await loadData();renderCalendar();loadAProgrammer();
  if(document.getElementById('view-list').classList.contains('active'))renderList();
  fetchSemaineData();
}

async function hardDeleteEmission(id,entreprise){
  const saisie=prompt(`⚠️ Suppression DÉFINITIVE et IRRÉVERSIBLE — contrairement à "Annuler", cette diffusion sera effacée de la base et n'apparaîtra plus nulle part, y compris dans l'historique.\n\nPour confirmer, tape le nom de l'entreprise : "${entreprise}"`);
  if(saisie===null)return;
  if(saisie.trim()!==entreprise){showToast('Nom incorrect — suppression annulée','warning');return;}
  const r=await fetch(`${API}/emissions/${id}/hard`,{method:'DELETE',headers:{'role':'edit'}});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  closeModal();await loadData();renderCalendar();loadAProgrammer();
  if(document.getElementById('view-list').classList.contains('active'))renderList();
  if(role==='edit')fetchSemaineData();
  showToast('Diffusion supprimée définitivement','success');
}

// ── BDC — BLOCAGE DE CRÉNEAU (côté commercial) ────────────────────────────────
async function updateBdcCounter(){
  try{
    const d=await fetch(`${API}/emissions/bdc/mes-creneaux`,{headers:{'x-commercial-id':commercialId}}).then(r=>r.json());
    const btn=document.getElementById('btn-bdc-commercial');
    if(btn)btn.textContent=`📌 Bloquer un créneau BDC (${d.actifs}/${d.max})`;
  }catch(e){}
}
// Mapping media du planning -> cle de template BDC (backend/bdc/render.js).
// Complete cette table au fur et a mesure des ajouts de templates.
const BDC_TEMPLATE_MAP = {
  'BFM Business': 'bfm-business-vision',
  'Le Figaro HP + HP Eco': 'figaro-48h-hp',
  'Le Figaro HP Eco': 'figaro-48h-hp',
  'Capital': 'capital-emission',
};
let mesCreneauxCache = [];
// Ouvre l'onglet BDC (integre, aucune redirection) pre-rempli depuis un creneau
// deja bloque -- entreprise, date de diffusion et media/template.
function genererBdcDepuisCreneau(id){
  const e = mesCreneauxCache.find(x=>x.id===id);
  if(!e)return;
  switchView('bdc');
  bdcPrefill({
    entreprise: e.entreprise,
    dateDiffusion: e.date_diffusion,
    respEmission: commercialNom,
    templateKey: BDC_TEMPLATE_MAP[e.media],
  });
}
// Acces direct depuis l'onglet nav "BDC" -- formulaire vide, seul le commercial
// connecte est pre-rempli.
function genererBdcVierge(){
  switchView('bdc');
  bdcPrefill({ respEmission: commercialNom });
}

// ── BDC — GENERATEUR INTEGRE (onglet "BDC") ───────────────────────────────────
// Formulaire + apercu temps reel, fusionne depuis l'app standalone bdc-generator
// (meme logique cote client) mais appelle directement l'API du planning
// (/api/bdc/...) avec l'auth commerciale existante (header x-commercial-id) --
// aucune redirection vers un autre domaine.
let bdcInitialized = false;
// Valeur demandée par bdcPrefill en attendant que la liste complète des
// templates soit chargée (bdcLoadTemplates est asynchrone).
let bdcPendingTemplateKey = null;
function bdcInit(){
  if(bdcInitialized)return;
  bdcInitialized = true;
  bdcLoadTemplates();

  const dateLibreCheck = document.getElementById('bdc2-dateLibreCheck');
  const datePrecise = document.getElementById('bdc2-datePrecise');
  const dateLibre = document.getElementById('bdc2-dateLibre');

  function pad(n){return String(n).padStart(2,'0');}
  document.getElementById('bdc2-dateDuJour').value = (()=>{const d=new Date();return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear();})();

  window.bdcSyncDateHidden = function(){
    if(dateLibreCheck.checked)return dateLibre.value;
    if(datePrecise.value){const p=datePrecise.value.split('-');return p[2]+'/'+p[1]+'/'+p[0];}
    return '';
  };
  window.bdcToggleDateMode = function(){
    const libre = dateLibreCheck.checked;
    datePrecise.style.display = libre?'none':'block';
    dateLibre.style.display = libre?'block':'none';
    bdcSchedulePreview();
  };
  dateLibreCheck.addEventListener('change', bdcToggleDateMode);
  datePrecise.addEventListener('input', bdcSchedulePreview);
  dateLibre.addEventListener('input', bdcSchedulePreview);

  document.getElementById('bdc2-template').addEventListener('change', ()=>{bdcPendingTemplateKey=null;});
  document.getElementById('bdc2-template').addEventListener('change', bdcLoadDefaults);
  ['bdc2-entreprise','bdc2-contact','bdc2-adresse','bdc2-thematique','bdc2-respEmission',
   'bdc2-montantHT','bdc2-dateDuJour','bdc2-noTva','bdc2-delai1','bdc2-delai2','bdc2-delai3','bdc2-delai4']
    .forEach(id=>{
      const el=document.getElementById(id);
      el.addEventListener('input', bdcSchedulePreview);
      el.addEventListener('change', bdcSchedulePreview);
    });

  window.addEventListener('resize', bdcScalePreview);
  document.getElementById('bdc2-previewFrame').addEventListener('load', bdcScalePreview);
}

function bdcMakeDescRow(value){
  const row=document.createElement('div');
  row.className='desc-item-row';
  const input=document.createElement('input');
  input.className='form-input'; input.type='text'; input.value=value||'';
  input.addEventListener('input', bdcSchedulePreview);
  const btn=document.createElement('button');
  btn.type='button'; btn.innerHTML='&times;'; btn.title='Supprimer cette ligne';
  btn.addEventListener('click', ()=>{row.remove();bdcSchedulePreview();});
  row.appendChild(input); row.appendChild(btn);
  return row;
}
function bdcRenderDescItems(items){
  const list=document.getElementById('bdc2-descItemsList');
  list.innerHTML='';
  (items||[]).forEach(t=>list.appendChild(bdcMakeDescRow(t)));
}
function bdcAddDescItem(){
  document.getElementById('bdc2-descItemsList').appendChild(bdcMakeDescRow(''));
  bdcSchedulePreview();
}
async function bdcImporterSalesforce(){
  const input=document.getElementById('bdc2-sfInput');
  const status=document.getElementById('bdc2-sfStatus');
  const raw=input.value.trim();
  if(!raw){status.textContent='Colle un Id ou une URL de piste.';return;}
  status.textContent='Import en cours…';
  try{
    const r=await fetch(`${API}/bdc/salesforce/lead?idOrUrl=${encodeURIComponent(raw)}`,{headers:{'x-commercial-id':commercialId}});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Erreur inconnue');
    const f=d.fields||{};
    if(f.entreprise)document.getElementById('bdc2-entreprise').value=f.entreprise;
    if(f.contact)document.getElementById('bdc2-contact').value=f.contact;
    if(f.adresse)document.getElementById('bdc2-adresse').value=f.adresse;
    if(f.respEmission)document.getElementById('bdc2-respEmission').value=f.respEmission;
    if(f.email)document.getElementById('bdc2-signerEmail').value=f.email;
    status.textContent='Piste importée.';
    bdcSchedulePreview();
  }catch(e){
    status.textContent='Erreur : '+e.message;
  }
}
// Charge la liste complète des templates (les 3 historiques + les 47 générés
// depuis les PDF sources) et reconstruit le select avec un groupe par média.
// Les 3 options codées en dur dans le HTML servent de fallback si l'API échoue.
async function bdcLoadTemplates(){
  const sel=document.getElementById('bdc2-template');
  try{
    const list=await fetch(`${API}/bdc/templates`,{headers:{'x-commercial-id':commercialId}}).then(r=>r.json());
    if(!Array.isArray(list)||!list.length)return;
    const current=bdcPendingTemplateKey||sel.value||'figaro-48h-hp';
    sel.innerHTML='';
    const groups={};
    list.forEach(t=>{
      if(!groups[t.group]){groups[t.group]=document.createElement('optgroup');groups[t.group].label=t.group;sel.appendChild(groups[t.group]);}
      const o=document.createElement('option');
      o.value=t.key;
      o.textContent=t.label+(t.lang==='en'?' (EN)':'');
      groups[t.group].appendChild(o);
    });
    sel.value=current;
    if(sel.value!==current)sel.value='figaro-48h-hp';
    bdcPendingTemplateKey=null;
  }catch(e){/* fallback : les 3 options en dur restent */}
}

async function bdcLoadDefaults(){
  const templateKey=document.getElementById('bdc2-template').value;
  try{
    const d=await fetch(`${API}/bdc/template-defaults?templateKey=${encodeURIComponent(templateKey)}`,{headers:{'x-commercial-id':commercialId}}).then(r=>r.json());
    bdcRenderDescItems(d.descriptionItems);
  }catch(e){}
  bdcSchedulePreview();
}

function bdcCollectFields(){
  const descItems=[...document.querySelectorAll('#bdc2-descItemsList .form-input')].map(i=>i.value).filter(Boolean);
  return {
    templateKey: document.getElementById('bdc2-template').value,
    entreprise: document.getElementById('bdc2-entreprise').value,
    contact: document.getElementById('bdc2-contact').value,
    adresse: document.getElementById('bdc2-adresse').value,
    thematique: document.getElementById('bdc2-thematique').value,
    respEmission: document.getElementById('bdc2-respEmission').value,
    montantHT: document.getElementById('bdc2-montantHT').value,
    dateDuJour: document.getElementById('bdc2-dateDuJour').value,
    noTva: document.getElementById('bdc2-noTva').checked ? 'on' : '',
    dateDiffusion: bdcSyncDateHidden(),
    delaiReglementLigne1: document.getElementById('bdc2-delai1').value,
    delaiReglementLigne2: document.getElementById('bdc2-delai2').value,
    delaiReglementLigne3: document.getElementById('bdc2-delai3').value,
    delaiReglementLigne4: document.getElementById('bdc2-delai4').value,
    descriptionItems: descItems,
  };
}

let bdcPreviewTimer=null;
function bdcSchedulePreview(){
  clearTimeout(bdcPreviewTimer);
  bdcPreviewTimer=setTimeout(bdcUpdatePreview,350);
}
async function bdcUpdatePreview(){
  const fields=bdcCollectFields();
  const params=new URLSearchParams();
  Object.entries(fields).forEach(([k,v])=>{
    if(k==='descriptionItems'){v.forEach(item=>params.append('descriptionItems',item));}
    else if(v)params.set(k,v);
  });
  try{
    const html=await fetch(`${API}/bdc/preview?${params.toString()}`,{headers:{'x-commercial-id':commercialId}}).then(r=>r.text());
    document.getElementById('bdc2-previewFrame').srcdoc=html;
  }catch(e){}
}
function bdcScalePreview(){
  const wrap=document.getElementById('bdc2-previewWrap');
  const frame=document.getElementById('bdc2-previewFrame');
  const scale=wrap.clientWidth/794;
  frame.style.transform=`scale(${scale})`;
  wrap.style.height=Math.round(1123*scale)+'px';
}

async function bdcGenererPdf(){
  const fields=bdcCollectFields();
  if(!fields.entreprise||!fields.montantHT){
    document.getElementById('bdc2-genererStatus').textContent='Entreprise et montant HT sont requis.';
    return;
  }
  document.getElementById('bdc2-genererStatus').textContent='Génération en cours…';
  try{
    const r=await fetch(`${API}/bdc/generate`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-commercial-id':commercialId},
      body:JSON.stringify(fields),
    });
    if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'Erreur inconnue');}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=`BDC_${(fields.entreprise||'BDC').replace(/[^a-z0-9]+/gi,'_')}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    document.getElementById('bdc2-genererStatus').textContent='PDF généré ✓';
  }catch(e){
    document.getElementById('bdc2-genererStatus').textContent='Erreur : '+e.message;
  }
}

// ── Envoi pour signature via DocuSign ────────────────────────────────────────
// Le PDF envoyé est celui de « Générer le PDF » (même route moteur côté
// serveur). Le suivi vit dans le bloc « Suivi des envois DocuSign » sous
// l'éditeur ; les statuts sont rafraîchis à chaque affichage de la vue.
const DS_STATUT_LABEL={envoye:'✉️ Envoyé',signe:'✅ Signé',refuse:'❌ Refusé',annule:'🚫 Annulé'};

async function bdcEnvoyerDocusign(){
  const fields=bdcCollectFields();
  const status=document.getElementById('bdc2-genererStatus');
  const signerEmail=document.getElementById('bdc2-signerEmail').value.trim();
  const signerMessage=document.getElementById('bdc2-signerMessage').value.trim();
  if(!fields.entreprise||!fields.montantHT){status.textContent='Entreprise et montant HT sont requis.';return;}
  if(!signerEmail){status.textContent="Email du signataire requis pour l'envoi DocuSign.";return;}
  if(!confirm(`Envoyer le BDC de ${fields.entreprise} pour signature à ${signerEmail} ?`))return;
  status.textContent='Génération du PDF + envoi DocuSign en cours… (10-20 s)';
  try{
    const r=await fetch(`${API}/bdc/docusign/send`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-commercial-id':commercialId},
      body:JSON.stringify({...fields,signerEmail,signerMessage}),
    });
    const d=await r.json().catch(()=>({}));
    // Consentement DocuSign individuel manquant : le commercial autorise
    // l'application UNE FOIS (connecté à son propre DocuSign), puis relance.
    if(r.status===428&&d.consentUrl){
      status.innerHTML=`Première utilisation : <a href="${d.consentUrl}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:700">autorise DocuSign</a> (connecté à ton compte), puis relance l'envoi.`;
      window.open(d.consentUrl,'_blank','noopener');
      return;
    }
    if(!r.ok)throw new Error(d.error||'Erreur inconnue');
    // Le serveur pose aussi le créneau jaune "BDC en attente" sur le planning
    // de diffusion (ou le signale s'il existait déjà / s'il est sans date).
    let msg=`BDC envoyé pour signature à ${signerEmail} ✓`;
    if(d.emission&&d.emission.statut==='bdc_attente')msg+=d.emission.cree?' — créneau jaune « BDC en attente » ajouté au planning':' — créneau déjà présent sur le planning';
    else if(d.emission&&d.emission.statut==='a_programmer')msg+=' — ajouté dans « À programmer » (pas de date précise)';
    status.textContent=msg;
    bdcLoadEnvois();
  }catch(e){
    status.textContent='Erreur : '+e.message;
  }
}

async function bdcLoadEnvois(){
  const el=document.getElementById('bdc2-envois');
  try{
    const rows=await fetch(`${API}/bdc/docusign/envois`,{headers:{'x-commercial-id':commercialId}}).then(r=>r.json());
    if(!Array.isArray(rows)||!rows.length){el.innerHTML='<div style="padding:8px 4px;color:var(--text-muted)">Aucun envoi DocuSign pour le moment.</div>';return;}
    el.innerHTML=rows.map(r=>{
      const date=(r.created_at||'').slice(0,16).replace('T',' ');
      const montant=r.montant_ht?` · ${Number(r.montant_ht).toLocaleString('fr-FR')} € HT`:'';
      return `<div class="ds-row">
        <span class="ds-chip ${r.statut}">${DS_STATUT_LABEL[r.statut]||r.statut}</span>
        <span style="font-weight:700">${r.entreprise||''}</span>
        <span style="color:var(--text-dim)">${r.contact||''} &lt;${r.email||''}&gt;${montant}</span>
        <span style="margin-left:auto;color:var(--text-muted);font-size:11px">${date}${r.commercial?` · ${r.commercial}`:''}</span>
      </div>`;
    }).join('');
  }catch(e){
    el.innerHTML=`<div style="padding:8px 4px;color:var(--red)">Erreur de chargement : ${e.message}</div>`;
  }
}

// Pre-remplissage (depuis un creneau ou vide) + reset des champs non fournis,
// pour ne jamais laisser trainer les valeurs d'un precedent BDC genere.
function bdcPrefill(fields){
  bdcInit();
  bdcPendingTemplateKey = fields.templateKey || 'figaro-48h-hp';
  document.getElementById('bdc2-template').value = bdcPendingTemplateKey;
  document.getElementById('bdc2-entreprise').value = fields.entreprise || '';
  document.getElementById('bdc2-contact').value = fields.contact || '';
  document.getElementById('bdc2-adresse').value = fields.adresse || '';
  document.getElementById('bdc2-thematique').value = fields.thematique || '';
  document.getElementById('bdc2-respEmission').value = fields.respEmission || '';
  document.getElementById('bdc2-montantHT').value = fields.montantHT || '';
  const dateLibreCheck=document.getElementById('bdc2-dateLibreCheck');
  if(fields.dateDiffusion && /^\d{4}-\d{2}-\d{2}$/.test(fields.dateDiffusion)){
    dateLibreCheck.checked=false;
    document.getElementById('bdc2-datePrecise').value=fields.dateDiffusion;
  }else if(fields.dateDiffusion){
    dateLibreCheck.checked=true;
    document.getElementById('bdc2-dateLibre').value=fields.dateDiffusion;
  }else{
    dateLibreCheck.checked=false;
    document.getElementById('bdc2-datePrecise').value='';
    document.getElementById('bdc2-dateLibre').value='';
  }
  bdcToggleDateMode();
  document.getElementById('bdc2-genererStatus').textContent='';
  document.getElementById('bdc2-signerEmail').value = fields.signerEmail || '';
  document.getElementById('bdc2-signerMessage').value = '';
  bdcLoadDefaults();
}
function bdcOnShow(){
  bdcInit();
  bdcScalePreview();
  bdcSchedulePreview();
  bdcLoadEnvois();
}
async function openMesCreneauxModal(){
  document.getElementById('modal-title').textContent='Mes créneaux BDC';
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML='<div style="font-size:12px;color:var(--text-muted)">Chargement…</div>';
  document.getElementById('modal-footer').innerHTML='<button class="btn-secondary" onclick="closeModal()">Fermer</button>';
  const d=await fetch(`${API}/emissions/bdc/mes-creneaux`,{headers:{'x-commercial-id':commercialId}}).then(r=>r.json());
  mesCreneauxCache = d.emissions||[];
  if(!d.emissions.length){
    document.getElementById('modal-body').innerHTML='<div style="font-size:12px;color:var(--text-muted)">Aucun créneau BDC en attente pour le moment.</div>';
    return;
  }
  document.getElementById('modal-body').innerHTML=`
    <div class="param-table">
      ${d.emissions.map(e=>`
        <div class="param-row">
          <span class="pr-name">${e.entreprise}</span>
          <span class="pr-email">${e.media}${e.sous_media?' · '+e.sous_media:''} — ${formatDateFR(e.date_diffusion)}</span>
          <div class="pr-actions">
            <button class="btn-icon" title="Générer le BDC" onclick="genererBdcDepuisCreneau(${e.id})">📄</button>
            <button class="btn-icon" title="Annuler ce créneau" onclick="cancelMonCreneau(${e.id})">🗑️</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}
async function cancelMonCreneau(id){
  if(!confirm('Annuler ce créneau BDC ? Le créneau sera libéré.'))return;
  const r=await fetch(`${API}/emissions/bdc/${id}`,{method:'DELETE',headers:{'x-commercial-id':commercialId}});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  showToast('Créneau annulé ✓','success');
  await loadData();renderCalendar();updateBdcCounter();
  openMesCreneauxModal();
}
function openBdcModal(){
  document.getElementById('modal-title').textContent='Bloquer un créneau BDC';
  document.getElementById('modal-overlay').style.display='flex';
  const mediasOpts=meta.medias.map(m=>`<option value="${m}">${m}</option>`).join('');
  document.getElementById('modal-body').innerHTML=`
    <div class="info-banner neutral">📌 <span>Créneau réservé en <b>BDC en attente</b> — à finaliser sous 5 jours ouvrés.</span></div>
    <div class="form-group"><label class="form-label">Commercial</label><input class="form-input" value="${commercialNom}" disabled></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Entreprise *</label><input class="form-input" id="bdc-entreprise" placeholder="Nom de l'entreprise"></div>
      <div class="form-group"><label class="form-label">Média *</label><select class="form-select" id="bdc-media" onchange="onBdcMediaChange()">${mediasOpts}</select></div>
    </div>
    <div class="form-row">
      <div class="form-group" id="bdc-sousmedia-group" style="display:none"><label class="form-label">Média spécialisé</label><select class="form-select" id="bdc-sousmedia" onchange="updateBdcFormats()"></select></div>
      <div class="form-group"><label class="form-label">Format</label><select class="form-select" id="bdc-format"></select></div>
    </div>
    <div class="form-group"><label class="form-label">Date *</label><input class="form-input" type="date" id="bdc-date" onchange="onDateChange(this)"></div>
  `;
  onBdcMediaChange();
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="submitBdcModal()">Bloquer le créneau</button>
  `;
}
function onBdcMediaChange(){
  const media=document.getElementById('bdc-media').value;
  const isSpecialise=media==='Médias spécialisés';
  const grp=document.getElementById('bdc-sousmedia-group');
  grp.style.display=isSpecialise?'':'none';
  if(isSpecialise){
    const opts=(meta.sousMediasListe||[]).map(m=>`<option value="${m}">${m}</option>`).join('');
    document.getElementById('bdc-sousmedia').innerHTML=`<option value="">— Choisir —</option>${opts}`;
  }
  updateBdcFormats();
}
function updateBdcFormats(){
  const media=document.getElementById('bdc-media').value;
  const sousMedia=media==='Médias spécialisés'?document.getElementById('bdc-sousmedia').value:null;
  const formats=sousMedia&&meta.sousMediasSpecialises[sousMedia]?meta.sousMediasSpecialises[sousMedia]:(meta.formats[media]||[]);
  document.getElementById('bdc-format').innerHTML=formats.map(f=>`<option value="${f}">${f}</option>`).join('');
}
async function submitBdcModal(){
  const entreprise=document.getElementById('bdc-entreprise').value.trim();
  const media=document.getElementById('bdc-media').value;
  const date_diffusion=document.getElementById('bdc-date').value;
  const format=document.getElementById('bdc-format').value;
  const sous_media=media==='Médias spécialisés'?(document.getElementById('bdc-sousmedia').value||null):null;
  if(!entreprise||!date_diffusion){showToast('Entreprise et date obligatoires','warning');return;}
  const r=await fetch(`${API}/emissions/bdc`,{method:'POST',headers:{'Content-Type':'application/json','x-commercial-id':commercialId},body:JSON.stringify({entreprise,media,sous_media,date_diffusion,format})});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  closeModal();
  await loadData();renderCalendar();updateBdcCounter();
  showToast('Créneau bloqué ✓','success');
}

function openAddModal(date='',force=false){
  document.getElementById('modal-title').textContent='Ajouter une diffusion';
  document.getElementById('modal-overlay').style.display='flex';
  const mediasOpts=meta.medias.map(m=>`<option value="${m}" ${m===currentMedia?'selected':''}>${m}</option>`).join('');
  document.getElementById('modal-body').innerHTML=`
    ${force?'<div class="info-banner warning">⚠️ Mode forcé — contraintes de slots ignorées</div>':''}
    <div class="form-row">
      <div class="form-group"><label class="form-label">Entreprise *</label><input class="form-input" id="add-entreprise" placeholder="Nom de l'entreprise"></div>
      <div class="form-group"><label class="form-label">Commercial</label><input class="form-input" id="add-commercial" placeholder="Prénom"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Média *</label><select class="form-select" id="add-media" onchange="onAddMediaChange()">${mediasOpts}</select></div>
      <div class="form-group" id="add-sousmedia-group" style="display:none"><label class="form-label">Média spécialisé</label><select class="form-select" id="add-sousmedia" onchange="updateFormats()"></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date <span style="color:var(--text-muted);font-weight:400">(vide = à programmer)</span></label><input class="form-input" type="date" id="add-date" value="${date}" onchange="onDateChange(this)"></div>
      <div class="form-group"><label class="form-label">Format</label><select class="form-select" id="add-format"></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Secteur</label><input class="form-input" id="add-secteur" placeholder="Ex: Santé, Finance…"></div>
      ${canSeeBudget?'<div class="form-group"><label class="form-label">Montant (€)</label><input class="form-input" type="number" id="add-montant" placeholder="0"></div>':''}
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Statut</label>
        <select class="form-select" id="add-statut">
          <option value="a_assigner">À assigner</option>
          <option value="bdc_attente">BDC en attente</option>
          <option value="confirme">Confirmé</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Resp. édito</label>
        <select class="form-select" id="add-resp"><option value="">— À assigner —</option>${RESP_EDIT_LIST.map(r=>`<option value="${r}">${r}</option>`).join('')}</select>
      </div>
    </div>
    <div class="form-group" id="hp-group" style="display:none"><label class="form-label">Homepage (Figaro)</label>
      <div class="checkbox-group">
        <label class="checkbox-label"><input type="checkbox" id="add-hp"> Homepage</label>
        <label class="checkbox-label"><input type="checkbox" id="add-hpeco"> Homepage Éco</label>
      </div>
    </div>
  `;
  onAddMediaChange();
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="submitAdd()">Ajouter</button>
  `;
}

function onAddMediaChange(){
  const media=document.getElementById('add-media')?.value;if(!media)return;
  const isSpecialise=media==='Médias spécialisés';
  const grp=document.getElementById('add-sousmedia-group');
  grp.style.display=isSpecialise?'':'none';
  if(isSpecialise){
    const opts=(meta.sousMediasListe||[]).map(m=>`<option value="${m}">${m}</option>`).join('');
    document.getElementById('add-sousmedia').innerHTML=`<option value="">— Choisir —</option>${opts}`;
  }
  updateFormats();
}

function updateFormats(){
  const media=document.getElementById('add-media')?.value;if(!media)return;
  const sousMedia=media==='Médias spécialisés'?document.getElementById('add-sousmedia')?.value:null;
  const formats=sousMedia&&meta.sousMediasSpecialises[sousMedia]?meta.sousMediasSpecialises[sousMedia]:(meta.formats[media]||[]);
  document.getElementById('add-format').innerHTML=formats.map(f=>`<option value="${f}">${f}</option>`).join('');
  const hpg=document.getElementById('hp-group');if(hpg)hpg.style.display=media.includes('Figaro')?'block':'none';
}

async function submitAdd(){
  const entreprise=document.getElementById('add-entreprise').value.trim();
  const media=document.getElementById('add-media').value;
  const date=document.getElementById('add-date').value;
  const statut=document.getElementById('add-statut').value;
  if(!entreprise)return showToast('Entreprise obligatoire','warning');
  const payload={
    entreprise,media,date_diffusion:date,
    sous_media:media==='Médias spécialisés'?(document.getElementById('add-sousmedia').value||null):null,
    format:document.getElementById('add-format').value,
    secteur:document.getElementById('add-secteur').value,
    commercial:document.getElementById('add-commercial').value,
    resp_edit:document.getElementById('add-resp').value,
    montant:parseFloat(document.getElementById('add-montant')?.value)||0,
    homepage:document.getElementById('add-hp')?.checked||false,
    homepage_eco:document.getElementById('add-hpeco')?.checked||false,
  };
  const isBdc=statut==='bdc_attente';
  const r=await fetch(`${API}/webhook/salesforce`,{method:'POST',headers:{'Content-Type':'application/json','x-sf-secret':'manual-edit','x-sf-type':isBdc?'bdc':'normal'},body:JSON.stringify(payload)});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  // Sans date, le backend a forcé le statut à "a_programmer" — on ne l'écrase pas avec le
  // statut choisi dans le formulaire, qui ne s'applique que si une vraie date est fournie.
  if(date&&!isBdc&&statut!=='a_assigner'&&d.id){
    await fetch(`${API}/emissions/${d.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','role':'edit'},body:JSON.stringify({statut})});
  }
  closeModal();await loadData();renderCalendar();loadAProgrammer();
  if(document.getElementById('view-list').classList.contains('active'))renderList();
  fetchSemaineData();
  if(d.alertes&&d.alertes.length)showToast(d.alertes.join('\n'),'warning');
  else showToast(date?'Diffusion ajoutée ✓':'Ajoutée sans date → panneau "À programmer" ✓','success');
}

// ── UTILS ────────────────────────────────────────────────────────────────────
function closeModal(event){if(event&&event.target!==document.getElementById('modal-overlay'))return;document.getElementById('modal-overlay').style.display='none';}
function showToast(msg,type='success'){const el=document.createElement('div');el.className=`toast ${type}`;el.innerHTML=`<span>${type==='success'?'✅':'⚠️'}</span><span>${msg}</span>`;document.body.appendChild(el);setTimeout(()=>el.remove(),4000);}
function fmtDate(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function sameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}
function formatDateFR(str){if(!str)return '—';const[y,m,d]=str.split('-');return `${d}/${m}/${y}`;}
function mondayOfWeek(dateStr){
  const d=new Date(dateStr+'T00:00:00');
  const dow=d.getDay()||7;
  d.setDate(d.getDate()-(dow-1));
  return fmtDate(d);
}
function fmtCA(v){return new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);}
function statutBadge(s){
  const map={a_assigner:'À assigner',bdc_attente:'BDC en attente',confirme:'Confirmé',a_programmer:'À programmer',annule:'Annulé'};
  const col={a_assigner:'var(--gold)',bdc_attente:'var(--bdc-text)',confirme:'var(--green)',a_programmer:'var(--accent)',annule:'var(--text-muted)'};
  return `<span style="color:${col[s]};font-weight:600;font-size:12px">${map[s]||s}</span>`;
}
function isJourAutorise(str){if(!str)return true;return[1,3,5].includes(new Date(str).getDay());}
function onDateChange(el){if(!el.value)return;if(!isJourAutorise(el.value)){el.setCustomValidity('Seuls lundis, mercredis et vendredis.');el.reportValidity();el.value='';}else el.setCustomValidity('');}
function toggleTheme(){const dark=document.documentElement.getAttribute('data-theme')==='dark';if(dark){document.documentElement.removeAttribute('data-theme');document.getElementById('theme-btn').textContent='☀️';localStorage.setItem('theme','light');}else{document.documentElement.setAttribute('data-theme','dark');document.getElementById('theme-btn').textContent='🌙';localStorage.setItem('theme','dark');}}
// Déconnexion : oublie l'identité commerciale mémorisée et revient à l'écran de connexion.
// Rechargement complet (plutôt que de ré-basculer les vues à la main) pour repartir sur un
// état 100% propre, quel que soit le rôle actif (édito, com, C-level ou commercial).
function logout(){
  localStorage.removeItem('commercialId');
  localStorage.removeItem('commercialNom');
  window.location.href = window.location.pathname;
}
document.addEventListener('keydown',e=>{if(document.getElementById('pin-screen').style.display==='none')return;if(document.getElementById('pin-card-edito').style.display==='none')return;if(e.key>='0'&&e.key<='9')pinKey(e.key);else if(e.key==='Backspace')pinDel();else if(e.key==='Enter')pinSubmit();});

// ── PARAMÈTRES (édito uniquement) ─────────────────────────────────────────────
let equipesCache=[], commerciauxCache=[], salesTeamsCache=[];
// Statuts d'échéance personnalisables (Recouvrement, échéances 2/3/4) — table
// à part (finance_installment_statuses), gérée ici comme tout autre réglage
// admin centralisé dans Paramètres, même si elle sert l'outil /recouvrement.
let financeInstallmentStatusesCache=[];

// Rôles disponibles à la création/édition d'un compte — un seul système de
// comptes pour tout OpenMedias (dashboard + planning), fini les codes PIN.
// Labels courts dans le <select> lui-même : la liste déroulante native (mobile
// et desktop) dimensionne sa largeur sur l'option la plus longue, sans lien
// avec le CSS du champ fermé — avec les anciens libellés à rallonge, le menu
// déroulant débordait largement de l'écran sur mobile. Le détail passe en
// "title" (info-bulle au survol sur desktop), sans impact sur la largeur.
const ROLES_COMPTE=[
  {value:'commercial',label:'Commercial',hint:'Commercial — ses seuls chiffres'},
  {value:'manager',label:'Manager',hint:'Manager — chiffres de son équipe'},
  {value:'edito',label:'Édito',hint:'Édito — planning, pas de dashboard'},
  {value:'communication',label:'Communication',hint:'Communication — planning, pas de dashboard'},
  {value:'finance',label:'Finance',hint:'Finance — recouvrement Pennylane sur /recouvrement, pas de dashboard ni de planning'},
  {value:'admin',label:'Admin',hint:'Admin — tout voir'},
];

async function loadParametres(){
  const [settings,equipes,commerciaux,salesTeams,installmentStatuses]=await Promise.all([
    fetch(`${API}/admin/settings`,{headers:{role:'edit'}}).then(r=>r.json()),
    fetch(`${API}/admin/equipes`,{headers:{role:'edit'}}).then(r=>r.json()),
    fetch(`${API}/admin/commerciaux`,{headers:{role:'edit'}}).then(r=>r.json()),
    fetch(`${API}/admin/sales-teams`,{headers:{role:'edit'}}).then(r=>r.json()),
    // Requiert un compte admin (requireFinance accepte finance OU admin) —
    // cohérent avec l'onglet Paramètres lui-même, déjà réservé aux admins.
    fetch(`${API}/finance/installment-statuses`,{headers:dashAuthHeaders()}).then(r=>r.json()).catch(()=>[]),
  ]);
  document.getElementById('param-horizon').value=settings.horizonMois;
  equipesCache=equipes; commerciauxCache=commerciaux; salesTeamsCache=salesTeams;
  financeInstallmentStatusesCache=installmentStatuses;
  renderEquipesList(); renderCommerciauxList(); renderSalesTeamsList(); renderFinanceInstallmentStatusesList();
  if(isAccountAdmin)loadDashboardAdmin();
}

// ── OPENDASHBOARD — réglages reporting / connexions / groupements d'affichage
// (portés ici depuis la console cachée du dashboard, cf. Task "backend admin
// commun") : ces routes vivent à la racine du serveur (requireAdmin côté
// dashboard), pas sous /planning/api/ — d'où les chemins absolus et l'en-tête
// x-commercial-id plutôt que "role:edit".
const DASH_DAYS=[['L',1],['M',2],['M',3],['J',4],['V',5],['S',6],['D',0]];
let dashReportDays=[1,2,3,4,5], dashTeamsCache=[], dashRosterCache=[];
function dashAuthHeaders(extra={}){ return {'x-commercial-id':commercialId, ...extra}; }
async function loadDashboardAdmin(){
  try{
    const [settings,logins,teams,roster]=await Promise.all([
      fetch('/api/admin/settings',{headers:dashAuthHeaders()}).then(r=>r.json()),
      fetch('/api/admin/logins',{headers:dashAuthHeaders()}).then(r=>r.json()),
      fetch('/api/teams',{headers:dashAuthHeaders()}).then(r=>r.json()),
      fetch('/api/admin/roster',{headers:dashAuthHeaders()}).then(r=>r.json()),
    ]);
    document.getElementById('dash-report-theme').value=settings.reportTheme||'light';
    document.getElementById('dash-report-preset').value=settings.reportPreset||'today';
    document.getElementById('dash-report-time').value=settings.reportTime||'08:00';
    document.getElementById('dash-report-auto').checked=!!settings.reportAuto;
    document.getElementById('dash-report-to').value=settings.reportTo||'';
    dashReportDays=Array.isArray(settings.reportDays)?settings.reportDays:[1,2,3,4,5];
    renderDashReportDays();
    renderDashLogins(logins.events||[]);
    dashTeamsCache=teams.teams||[]; dashRosterCache=roster.names||[];
    renderDashTeamsList();
  }catch(e){ /* section masquée si erreur (compte non-admin, etc.) */ }
}
function renderDashReportDays(){
  const el=document.getElementById('dash-report-days');
  el.innerHTML=DASH_DAYS.map(([lbl,val])=>
    `<div class="param-chip" style="cursor:pointer;${dashReportDays.includes(val)?'background:var(--accent);color:#fff':''}" onclick="toggleDashReportDay(${val})">${lbl}</div>`
  ).join('');
}
function toggleDashReportDay(val){
  dashReportDays=dashReportDays.includes(val)?dashReportDays.filter(d=>d!==val):[...dashReportDays,val];
  renderDashReportDays();
}
function dashReportPayload(){
  return {
    reportTheme: document.getElementById('dash-report-theme').value,
    reportPreset: document.getElementById('dash-report-preset').value,
    reportTime: document.getElementById('dash-report-time').value,
    reportAuto: document.getElementById('dash-report-auto').checked,
    reportTo: document.getElementById('dash-report-to').value,
    reportDays: dashReportDays,
  };
}
async function saveDashReportSettings(){
  const statusEl=document.getElementById('dash-report-status');
  statusEl.textContent=''; statusEl.style.color='';
  try{
    const r=await fetch('/api/admin/settings',{method:'POST',headers:dashAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify(dashReportPayload())});
    if(!r.ok)throw new Error('Sauvegarde refusée');
    statusEl.textContent='Réglages sauvegardés ✓'; statusEl.style.color='var(--green)';
  }catch(e){ statusEl.textContent=String(e.message||e); statusEl.style.color='var(--danger,#d33)'; }
}
async function sendDashReportTest(){
  const statusEl=document.getElementById('dash-report-status');
  statusEl.textContent='Génération + envoi en cours… (10-30s)'; statusEl.style.color='';
  try{
    await fetch('/api/admin/settings',{method:'POST',headers:dashAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify(dashReportPayload())});
    const r=await fetch('/api/admin/send-test',{method:'POST',headers:dashAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({preset:document.getElementById('dash-report-preset').value})});
    const d=await r.json();
    if(!r.ok||!d.sent)throw new Error(d.error||"Échec de l'envoi");
    statusEl.textContent=`Reporting envoyé à ${(d.to||[]).join(', ')} ✓`; statusEl.style.color='var(--green)';
  }catch(e){ statusEl.textContent=String(e.message||e); statusEl.style.color='var(--danger,#d33)'; }
}
function dashUaShort(ua){
  const browser=/Edg\//.test(ua)?'Edge':/OPR\//.test(ua)?'Opera':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)&&/Version\//.test(ua)?'Safari':/Firefox\//.test(ua)?'Firefox':'Navigateur';
  const os=/Windows/.test(ua)?'Windows':/Mac OS X/.test(ua)?'macOS':/iPhone|iPad/.test(ua)?'iOS':/Android/.test(ua)?'Android':/Linux/.test(ua)?'Linux':'';
  return os?`${browser} · ${os}`:browser;
}
function renderDashLogins(events){
  const el=document.getElementById('dash-logins-list');
  if(!events.length){ el.innerHTML='<div style="font-size:12px;color:var(--text-muted)">Aucune connexion enregistrée.</div>'; return; }
  el.innerHTML=events.slice(0,25).map(l=>
    `<div style="display:flex;gap:10px;align-items:center;font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)">
      <span style="width:8px;height:8px;border-radius:50%;background:${l.ok?'var(--green)':'#d33'}" title="${l.ok?'Connexion réussie':'Échec'}"></span>
      <span>${new Date(l.at).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
      <span style="color:var(--text-muted)">${dashUaShort(l.ua)}</span>
      <span style="color:var(--text-muted)">${l.ip}</span>
    </div>`
  ).join('');
}
let dashOpenTeamId=null;
function renderDashTeamsList(){
  const el=document.getElementById('dash-teams-list');
  if(!dashTeamsCache.length){ el.innerHTML='<div style="font-size:12px;color:var(--text-muted)">Aucune équipe.</div>'; return; }
  el.innerHTML=dashTeamsCache.map(t=>`
    <div class="param-card" style="margin-bottom:8px;padding:10px 12px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:13px">${t.label}</strong>
        <button class="btn-secondary" style="font-size:11px;padding:4px 10px" onclick="dashOpenTeamId=dashOpenTeamId==='${t.id}'?null:'${t.id}';renderDashTeamsList()">
          ${t.members.length} membre${t.members.length>1?'s':''} ${dashOpenTeamId===t.id?'▲':'▾'}
        </button>
      </div>
      ${dashOpenTeamId===t.id?`
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
          ${dashRosterCache.map(name=>`
            <label style="display:flex;align-items:center;gap:5px;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:3px 8px;cursor:pointer">
              <input type="checkbox" ${t.members.includes(name)?'checked':''} onchange="toggleDashTeamMember('${t.id}','${name.replace(/'/g,"\\'")}')">${name}
            </label>
          `).join('')}
        </div>
      `:''}
    </div>
  `).join('');
}
async function toggleDashTeamMember(teamId,name){
  const t=dashTeamsCache.find(t=>t.id===teamId);
  const members=t.members.includes(name)?t.members.filter(m=>m!==name):[...t.members,name];
  try{
    const r=await fetch(`/api/admin/teams/${teamId}`,{method:'PATCH',headers:dashAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({members})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Erreur');
    await loadDashboardAdmin();
  }catch(e){ showToast(String(e.message||e),'warning'); }
}

// Manager affiché directement sur la fiche équipe (t.manager_nom, joint côté
// serveur) — avant, cette info ne se lisait qu'en allant chercher le rôle de
// chaque compte dans la liste "Comptes" plus bas, rien ne la montrait ici.
function renderSalesTeamsList(){
  const el=document.getElementById('sales-teams-list');
  el.innerHTML=salesTeamsCache.length?salesTeamsCache.map(t=>
    `<div class="param-chip" style="cursor:pointer" onclick="openEditSalesTeamModal('${t.id}')" title="Modifier">
      ${t.label}${t.manager_nom?` <span style="opacity:0.65;font-weight:400">— ${t.manager_nom}</span>`:''}
      <button onclick="event.stopPropagation();deleteSalesTeam('${t.id}','${t.label.replace(/'/g,"\\'")}')" title="Supprimer">✕</button>
    </div>`
  ).join(''):'<div style="font-size:12px;color:var(--text-muted)">Aucune équipe de vente créée pour l\'instant.</div>';
}

// Liste de cases à cocher pour choisir les commerciaux d'une équipe — ne
// propose que les comptes actifs, avec leur équipe actuelle en info (repris
// dans une nouvelle équipe = détaché de l'ancienne, comme le fait déjà
// updateCommercialTeam pour une réassignation individuelle).
function salesTeamMembersChecklist(selectedIds){
  const sel=new Set(selectedIds||[]);
  const actifs=commerciauxCache.filter(c=>c.actif);
  if(!actifs.length)return '<div style="font-size:12px;color:var(--text-muted)">Aucun compte actif.</div>';
  return actifs.map(c=>`
    <label style="display:flex;align-items:center;gap:8px;padding:6px 2px;font-size:13px">
      <input type="checkbox" value="${c.id}" class="sales-team-member-cb" ${sel.has(c.id)?'checked':''}>
      ${c.nom}${c.team_label?` <span style="color:var(--text-muted);font-size:11px">(${c.team_label})</span>`:''}
    </label>
  `).join('');
}
function readSalesTeamMemberIds(){
  return [...document.querySelectorAll('.sales-team-member-cb:checked')].map(cb=>Number(cb.value));
}
function managerOptionsHtml(selectedId){
  const actifs=commerciauxCache.filter(c=>c.actif);
  return `<option value="">— aucun manager —</option>`+actifs.map(c=>
    `<option value="${c.id}" ${selectedId===c.id?'selected':''}>${c.nom}</option>`
  ).join('');
}
function openCreateSalesTeamModal(){
  document.getElementById('modal-title').textContent='Créer une équipe de vente';
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Nom de l'équipe</label><input class="form-input" id="newteam-label" placeholder="Ex: Équipe Lisa"></div>
    <div class="form-group" style="margin-top:10px"><label class="form-label">Manager</label><select class="form-select" id="newteam-manager">${managerOptionsHtml(null)}</select></div>
    <div class="form-group" style="margin-top:10px">
      <label class="form-label">Commerciaux de l'équipe</label>
      <div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px">${salesTeamMembersChecklist([])}</div>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="confirmCreateSalesTeam()">Créer l'équipe</button>
  `;
}
async function confirmCreateSalesTeam(){
  const label=document.getElementById('newteam-label').value.trim();
  if(!label){showToast("Nom d'équipe requis",'warning');return;}
  const managerId=document.getElementById('newteam-manager').value||null;
  const memberIds=readSalesTeamMemberIds();
  const r=await fetch(`${API}/admin/sales-teams`,{method:'POST',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({label,managerId:managerId?Number(managerId):null,memberIds})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  closeModal();
  await loadParametres();
  showToast('Équipe de vente créée ✓','success');
}
function openEditSalesTeamModal(teamId){
  const t=salesTeamsCache.find(x=>x.id===teamId);
  if(!t)return;
  const currentMembers=commerciauxCache.filter(c=>c.actif && c.team_id===teamId).map(c=>c.id);
  document.getElementById('modal-title').textContent=`Modifier "${t.label}"`;
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Nom de l'équipe</label><input class="form-input" id="newteam-label" value="${t.label}"></div>
    <div class="form-group" style="margin-top:10px"><label class="form-label">Manager</label><select class="form-select" id="newteam-manager">${managerOptionsHtml(t.manager_id||null)}</select></div>
    <div class="form-group" style="margin-top:10px">
      <label class="form-label">Commerciaux de l'équipe</label>
      <div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px">${salesTeamMembersChecklist(currentMembers)}</div>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="confirmEditSalesTeam('${teamId}')">Enregistrer</button>
  `;
}
async function confirmEditSalesTeam(teamId){
  const label=document.getElementById('newteam-label').value.trim();
  if(!label){showToast("Nom d'équipe requis",'warning');return;}
  const managerId=document.getElementById('newteam-manager').value||null;
  const memberIds=readSalesTeamMemberIds();
  const r=await fetch(`${API}/admin/sales-teams/${teamId}`,{method:'PATCH',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({label,managerId:managerId?Number(managerId):null,memberIds})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  closeModal();
  await loadParametres();
  showToast('Équipe de vente mise à jour ✓','success');
}
async function deleteSalesTeam(id,label){
  if(!confirm(`Supprimer "${label}" ? Les comptes rattachés seront détachés (pas supprimés).`))return;
  await fetch(`${API}/admin/sales-teams/${id}`,{method:'DELETE',headers:{role:'edit'}});
  await loadParametres();
  showToast('Équipe de vente supprimée ✓','success');
}
function salesTeamOptionsHtml(selectedId){
  return `<option value="">— équipe de vente —</option>`+salesTeamsCache.map(t=>`<option value="${t.id}" ${selectedId===t.id?'selected':''}>${t.label}</option>`).join('');
}
function roleOptionsHtml(selectedRole){
  return ROLES_COMPTE.map(r=>`<option value="${r.value}" title="${r.hint}" ${selectedRole===r.value?'selected':''}>${r.label}</option>`).join('');
}

async function saveHorizon(){
  const v=parseInt(document.getElementById('param-horizon').value,10);
  if(!v||v<1){showToast('Valeur invalide','warning');return;}
  const r=await fetch(`${API}/admin/settings`,{method:'POST',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({horizonMois:v})});
  if(r.ok){showToast('Horizon mis à jour ✓','success');meta.horizonMois=v;}
  else showToast('Erreur','warning');
}

function renderEquipesList(){
  const el=document.getElementById('equipes-list');
  el.innerHTML=equipesCache.length?equipesCache.map(e=>
    `<div class="param-chip">${e.nom}<button onclick="deleteEquipe(${e.id})" title="Supprimer">✕</button></div>`
  ).join(''):'<div style="font-size:12px;color:var(--text-muted)">Aucune équipe créée pour l\'instant.</div>';
}
async function importSfOpportunity(){
  const input=document.getElementById('param-import-sf-id');
  const sf_id=input.value.trim();
  if(!sf_id){showToast('Colle un Id ou un lien Salesforce','warning');return;}
  const r=await fetch(`${API}/admin/import-sf-opportunity`,{method:'POST',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({sf_id})});
  const d=await r.json();
  if(!r.ok){
    showToast(d.error||'Erreur',d.error==='Déjà enregistré'?'warning':'warning');
    return;
  }
  input.value='';
  await loadData();renderCalendar();loadAProgrammer();
  if(document.getElementById('view-list').classList.contains('active'))renderList();
  showToast(d.reactivee?'Émission réactivée ✓':d.convertie?'Créneau BDC converti ✓':'Émission importée ✓','success');
}
async function addEquipe(){
  const input=document.getElementById('param-nouvelle-equipe');
  const nom=input.value.trim();
  if(!nom)return;
  const r=await fetch(`${API}/admin/equipes`,{method:'POST',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({nom})});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  input.value='';
  await loadParametres();
  showToast('Équipe créée ✓','success');
}
async function deleteEquipe(id){
  if(!confirm('Supprimer cette équipe ? Les commerciaux rattachés seront détachés (pas supprimés).'))return;
  await fetch(`${API}/admin/equipes/${id}`,{method:'DELETE',headers:{role:'edit'}});
  await loadParametres();
  showToast('Équipe supprimée ✓','success');
}

// ── RECOUVREMENT — statuts d'échéance personnalisables ──────────────────────
// Contrairement aux réglages ci-dessus (routes /admin/... avec l'en-tête
// "role:edit"), ces routes vivent sous /api/finance/... et exigent un compte
// authentifié (x-commercial-id) avec le rôle admin ou finance — cf.
// requireFinance côté serveur. dashAuthHeaders() (déjà utilisé pour
// OpenDashboard ci-dessous) porte exactement ce header, pas besoin d'un
// helper à part.
function renderFinanceInstallmentStatusesList(){
  const el=document.getElementById('finance-installment-statuses-list');
  if(!el)return;
  const list=financeInstallmentStatusesCache;
  el.innerHTML=list.length?list.map((s,i)=>`
    <div class="param-row">
      <input type="color" value="${s.color}" class="param-status-color" onchange="updateFinanceInstallmentStatus(${s.id},{color:this.value})" title="Couleur">
      <input class="form-input" style="flex:1;max-width:220px" value="${s.label}" onchange="updateFinanceInstallmentStatus(${s.id},{label:this.value})">
      <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text-dim);white-space:nowrap;cursor:pointer" title="Une échéance (ou l'échéance 1) sur ce statut compte comme réglée : la référence de retard glisse sur la suivante, et une fois toute la chaîne à un statut ainsi coché, la facture bascule automatiquement en « Soldée ».">
        <input type="checkbox" ${s.compte_regle?'checked':''} onchange="updateFinanceInstallmentStatus(${s.id},{compteRegle:this.checked})"> Compte comme réglée
      </label>
      <button class="btn-secondary" style="padding:2px 8px" ${i===0?'disabled':''} onclick="moveFinanceInstallmentStatus(${s.id},-1)" title="Monter">▲</button>
      <button class="btn-secondary" style="padding:2px 8px" ${i===list.length-1?'disabled':''} onclick="moveFinanceInstallmentStatus(${s.id},1)" title="Descendre">▼</button>
      <button class="btn-secondary" style="padding:2px 8px" onclick="deleteFinanceInstallmentStatus(${s.id})" title="Supprimer">✕</button>
    </div>`).join(''):'<div style="font-size:12px;color:var(--text-muted)">Aucun statut créé — les échéances afficheront "Sans statut".</div>';
}
async function addFinanceInstallmentStatus(){
  const input=document.getElementById('param-nouveau-statut-echeance');
  const label=input.value.trim();
  if(!label)return;
  const r=await fetch(`${API}/finance/installment-statuses`,{method:'POST',headers:dashAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({label,color:'#64748b'})});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  input.value='';
  await loadFinanceInstallmentStatusesOnly();
  showToast('Statut créé ✓','success');
}
async function updateFinanceInstallmentStatus(id,patch){
  const r=await fetch(`${API}/finance/installment-statuses/${id}`,{method:'PATCH',headers:dashAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify(patch)});
  if(!r.ok){showToast('Erreur','warning');return;}
  await loadFinanceInstallmentStatusesOnly();
}
async function moveFinanceInstallmentStatus(id,dir){
  const list=financeInstallmentStatusesCache;
  const idx=list.findIndex(s=>s.id===id);
  const swapIdx=idx+dir;
  if(idx===-1||swapIdx<0||swapIdx>=list.length)return;
  const a=list[idx],b=list[swapIdx];
  await Promise.all([
    fetch(`${API}/finance/installment-statuses/${a.id}`,{method:'PATCH',headers:dashAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({sortOrder:b.sort_order})}),
    fetch(`${API}/finance/installment-statuses/${b.id}`,{method:'PATCH',headers:dashAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({sortOrder:a.sort_order})}),
  ]);
  await loadFinanceInstallmentStatusesOnly();
}
async function deleteFinanceInstallmentStatus(id){
  if(!confirm('Supprimer ce statut ? Les échéances qui l\'utilisent repasseront à "Sans statut".'))return;
  await fetch(`${API}/finance/installment-statuses/${id}`,{method:'DELETE',headers:dashAuthHeaders()});
  await loadFinanceInstallmentStatusesOnly();
  showToast('Statut supprimé ✓','success');
}
// Recharge uniquement les statuts d'échéance (pas tout Paramètres) après une
// action sur cette liste — plus léger que loadParametres() au complet.
async function loadFinanceInstallmentStatusesOnly(){
  financeInstallmentStatusesCache=await fetch(`${API}/finance/installment-statuses`,{headers:dashAuthHeaders()}).then(r=>r.json()).catch(()=>[]);
  renderFinanceInstallmentStatusesList();
}

async function loadSalesforceCommerciaux(){
  const el=document.getElementById('sf-commerciaux-list');
  el.style.display='flex';el.style.flexDirection='column';
  el.innerHTML='<div style="font-size:12px;color:var(--text-muted)">Chargement depuis Salesforce…</div>';
  try{
    const r=await fetch(`${API}/admin/salesforce-commerciaux`,{headers:{role:'edit'}});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Erreur Salesforce');
    const existants=new Set(commerciauxCache.map(c=>c.email.toLowerCase()));
    el.innerHTML=d.length?d.map(u=>{
      const dejaCree=existants.has((u.email||'').toLowerCase());
      const uid='sf_'+u.sf_id;
      return `<div class="param-row">
        <span class="pr-name">${u.nom}</span><span class="pr-email">${u.email||'— pas d\'email SF —'}</span>
        <div class="pr-actions">
          ${dejaCree?'<span style="color:var(--green);font-size:11px;font-weight:600">✓ Compte créé</span>':`
            <select class="form-select" id="equipe-${uid}"><option value="">— équipe —</option>${equipesCache.map(e=>`<option value="${e.id}">${e.nom}</option>`).join('')}</select>
            <button class="btn-secondary" onclick="createCommercialFromSf('${u.sf_id}','${u.nom.replace(/'/g,"\\'")}','${u.email}','${uid}')">Créer un compte</button>
          `}
        </div>
      </div>`;
    }).join(''):'<div style="font-size:12px;color:var(--text-muted)">Aucun utilisateur actif trouvé dans Salesforce.</div>';
  }catch(e){
    el.innerHTML=`<div class="info-banner warning">⚠️ ${e.message}</div>`;
  }
}

function createCommercialFromSf(sfId,nom,sfEmail,uid){
  const equipeSel=document.getElementById(`equipe-${uid}`);
  const equipe_edito_id=equipeSel?equipeSel.value||null:null;
  document.getElementById('modal-title').textContent=`Créer le compte de ${nom}`;
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Nom</label><input class="form-input" id="newacc-nom" value="${nom}"></div>
    <div class="form-group" style="margin-top:10px"><label class="form-label">Email de connexion</label><input class="form-input" type="email" id="newacc-email" value="${sfEmail||''}"></div>
    <div class="form-group" style="margin-top:10px"><label class="form-label">Rôle</label><select class="form-select" id="newacc-role">${roleOptionsHtml('commercial')}</select></div>
    <div class="form-group" style="margin-top:10px"><label class="form-label">Équipe de vente (commercial/manager)</label><select class="form-select" id="newacc-team">${salesTeamOptionsHtml(null)}</select></div>
    <div class="info-banner neutral" style="margin-top:10px">${ICON_MAIL} Un email va être envoyé à cette adresse pour que ${nom.split(' ')[0]} définisse lui/elle-même son mot de passe.</div>
  `;
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="confirmCreateCommercial('${sfId}',${equipe_edito_id||'null'})">Créer le compte</button>
  `;
}
async function confirmCreateCommercial(sfId,equipe_edito_id){
  const nom=document.getElementById('newacc-nom').value.trim();
  const email=document.getElementById('newacc-email').value.trim();
  const role=document.getElementById('newacc-role').value;
  const team_id=document.getElementById('newacc-team').value||null;
  if(!nom||!email){showToast('Nom et email sont requis','warning');return;}
  const r=await fetch(`${API}/admin/commerciaux`,{method:'POST',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({nom,email,equipe_edito_id,sf_user_id:sfId,role,team_id})});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  closeModal();
  await loadParametres();
  showToast('Compte créé, email d\'invitation envoyé ✓','success');
}

// Création manuelle (édito, communication, admin, ou tout compte sans fiche
// Salesforce) — même flux d'invitation par email que la création depuis Salesforce.
function openManualAccountModal(){
  document.getElementById('modal-title').textContent='Créer un compte manuellement';
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Nom</label><input class="form-input" id="newacc-nom" placeholder="Ex: Eva Dupont"></div>
    <div class="form-group" style="margin-top:10px"><label class="form-label">Email de connexion</label><input class="form-input" type="email" id="newacc-email" placeholder="prenom.nom@openmedias.fr"></div>
    <div class="form-group" style="margin-top:10px"><label class="form-label">Rôle</label><select class="form-select" id="newacc-role">${roleOptionsHtml('edito')}</select></div>
    <div class="form-group" style="margin-top:10px"><label class="form-label">Équipe de vente (commercial/manager)</label><select class="form-select" id="newacc-team">${salesTeamOptionsHtml(null)}</select></div>
    <div class="info-banner neutral" style="margin-top:10px">${ICON_MAIL} Un email va être envoyé à cette adresse pour que la personne définisse elle-même son mot de passe.</div>
  `;
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="confirmCreateManualAccount()">Créer le compte</button>
  `;
}
async function confirmCreateManualAccount(){
  const nom=document.getElementById('newacc-nom').value.trim();
  const email=document.getElementById('newacc-email').value.trim();
  const role=document.getElementById('newacc-role').value;
  const team_id=document.getElementById('newacc-team').value||null;
  if(!nom||!email){showToast('Nom et email sont requis','warning');return;}
  const r=await fetch(`${API}/admin/commerciaux`,{method:'POST',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({nom,email,role,team_id})});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  closeModal();
  await loadParametres();
  showToast('Compte créé, email d\'invitation envoyé ✓','success');
}

// Profil "historique" : commercial parti de l'entreprise, dont le compte n'a
// jamais existé dans ce système (migré depuis l'ancienne liste codée en dur —
// cf. server/roster.js). Contrairement à openManualAccountModal ci-dessus, ne
// demande qu'un nom : pas d'email, pas d'invitation envoyée, actif=0 dès la
// création. Sert juste à garder sa trace sur le dashboard (visible/masquable
// comme n'importe qui via "Sales visibles"), sans lui donner un accès réel.
function openHistoriqueAccountModal(){
  document.getElementById('modal-title').textContent='Ajouter un profil historique';
  document.getElementById('modal-overlay').style.display='flex';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Nom</label><input class="form-input" id="newacc-hist-nom" placeholder="Ex: Clauvaine Battery"></div>
    <div class="info-banner neutral" style="margin-top:10px">🗂️ Aucun email ni mot de passe utilisable ne sera créé, aucune invitation envoyée. Cette personne apparaîtra juste dans les listes du dashboard (masquable via ⚙️ Sales visibles), marquée inactive d'emblée — à utiliser pour un commercial parti dont le compte n'a jamais existé ici.</div>
  `;
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn-secondary" onclick="closeModal()">Annuler</button>
    <button class="btn-primary" onclick="confirmCreateHistoriqueAccount()">Ajouter</button>
  `;
}
async function confirmCreateHistoriqueAccount(){
  const nom=document.getElementById('newacc-hist-nom').value.trim();
  if(!nom){showToast('Nom requis','warning');return;}
  const r=await fetch(`${API}/admin/commerciaux/historique`,{method:'POST',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({nom})});
  const d=await r.json();
  if(!r.ok){showToast(d.error||'Erreur','warning');return;}
  closeModal();
  await loadParametres();
  showToast('Profil historique ajouté (sans accès) ✓','success');
}

function renderCommerciauxList(){
  const el=document.getElementById('commerciaux-list');
  el.innerHTML=commerciauxCache.length?commerciauxCache.map(c=>`
    <div class="param-row">
      <span class="pr-name">${c.nom}</span><span class="pr-email">${c.email}</span>
      <div class="pr-actions">
        <div class="pr-field"><span class="pr-field-label">Rôle</span><select class="form-select" title="Rôle" onchange="updateCommercialRole(${c.id},this.value)">${roleOptionsHtml(c.role||'commercial')}</select></div>
        <div class="pr-field"><span class="pr-field-label">Équipe de vente</span><select class="form-select" title="Équipe de vente" onchange="updateCommercialTeam(${c.id},this.value)">${salesTeamOptionsHtml(c.team_id)}</select></div>
        <div class="pr-field"><span class="pr-field-label">Équipe édito</span><select class="form-select" title="Équipe édito" onchange="updateCommercialEquipe(${c.id},this.value)">
          <option value="">— équipe édito —</option>
          ${equipesCache.map(e=>`<option value="${e.id}" ${c.equipe_edito_id===e.id?'selected':''}>${e.nom}</option>`).join('')}
        </select></div>
        <button class="btn-icon" title="${c.actif?'Désactiver':'Réactiver'}" onclick="toggleCommercialActif(${c.id},${c.actif?0:1})">${c.actif?'🟢':'⚪'}</button>
        <button class="btn-icon" title="Renvoyer l'email d'invitation (définir mot de passe)" onclick="resendInvite(${c.id},'${c.nom.replace(/'/g,"\\'")}')">${ICON_MAIL}</button>
        <button class="btn-icon" title="Réinitialiser le mot de passe manuellement" onclick="resetCommercialPassword(${c.id})">🔑</button>
        <button class="btn-icon" title="Supprimer" onclick="deleteCommercial(${c.id},'${c.nom.replace(/'/g,"\\'")}')">🗑️</button>
      </div>
    </div>
  `).join(''):'<div style="font-size:12px;color:var(--text-muted)">Aucun compte créé pour l\'instant.</div>';
}
async function updateCommercialEquipe(id,equipe_edito_id){
  await fetch(`${API}/admin/commerciaux/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({equipe_edito_id:equipe_edito_id||null})});
  await loadParametres();
  showToast('Équipe édito mise à jour ✓','success');
}
async function updateCommercialTeam(id,team_id){
  await fetch(`${API}/admin/commerciaux/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({team_id:team_id||null})});
  await loadParametres();
  showToast('Équipe de vente mise à jour ✓','success');
}
async function updateCommercialRole(id,role){
  const r=await fetch(`${API}/admin/commerciaux/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({role})});
  if(!r.ok){showToast('Erreur','warning');await loadParametres();return;}
  await loadParametres();
  showToast('Rôle mis à jour ✓','success');
}
async function toggleCommercialActif(id,actif){
  await fetch(`${API}/admin/commerciaux/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({actif})});
  await loadParametres();
}
async function resetCommercialPassword(id){
  const pw=prompt('Nouveau mot de passe (6 caractères minimum) :');
  if(!pw)return;
  const r=await fetch(`${API}/admin/commerciaux/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json',role:'edit'},body:JSON.stringify({password:pw})});
  if(r.ok)showToast('Mot de passe réinitialisé ✓','success');else showToast('Erreur','warning');
}
async function resendInvite(id,nom){
  const r=await fetch(`${API}/admin/commerciaux/${id}/resend-invite`,{method:'POST',headers:{role:'edit'}});
  if(r.ok)showToast(`Invitation renvoyée à ${nom} ✓`,'success');else showToast('Erreur','warning');
}
async function deleteCommercial(id,nom){
  if(!confirm(`Supprimer le compte de ${nom} ? Cette action est irréversible.`))return;
  await fetch(`${API}/admin/commerciaux/${id}`,{method:'DELETE',headers:{role:'edit'}});
  await loadParametres();
  showToast('Compte supprimé ✓','success');
}
