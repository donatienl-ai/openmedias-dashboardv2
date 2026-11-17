// ==========================================
//  CONNECTEUR SALESFORCE
//  Auth via OAuth Client Credentials Flow
// ==========================================
import fetch from 'node-fetch';
import { matchSale, matchSaleStrict, buildFullList } from './roster.js';
import { toSoqlDate, toSoqlDateTime } from './dateRange.js';
import { createWideningCache } from './rawDataCache.js';

let cachedAuth = null;
let cachedAuthExpiry = 0;

async function getAuth(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedAuth && now < cachedAuthExpiry) return cachedAuth;

  // Client Credentials Flow : exige le My Domain (PAS login.salesforce.com).
  const domain = process.env.SALESFORCE_DOMAIN_URL || 'https://openmedias.my.salesforce.com';
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SALESFORCE_CLIENT_ID,
    client_secret: process.env.SALESFORCE_CLIENT_SECRET,
  });

  const res = await fetch(`${domain}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce auth failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  cachedAuth = { accessToken: data.access_token, instanceUrl: data.instance_url };
  cachedAuthExpiry = now + 60 * 60 * 1000;
  return cachedAuth;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exécute une requête SOQL avec pagination complète (nextRecordsUrl - une
 * requête peut renvoyer plus de 2000 lignes sur une grande plage, l'ancien
 * code s'arrêtait silencieusement à la 1ère page) et retry :
 *  - 401 (session/token expiré) → ré-authentifie une fois puis retente.
 *  - 5xx / erreur réseau → backoff exponentiel (jusqu'à 3 tentatives).
 * Les 403 REQUEST_LIMIT_EXCEEDED (quota API JOURNALIER, pas un débit court
 * terme) ne sont volontairement PAS retentés en boucle : l'erreur remonte
 * telle quelle, réessayer immédiatement n'y changerait rien.
 */
async function queryAll(soql) {
  let { accessToken, instanceUrl } = await getAuth();
  let path = `/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  const all = [];
  let attempt = 0;

  while (path) {
    const res = await fetch(`${instanceUrl}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 401 && attempt === 0) {
      attempt += 1;
      ({ accessToken, instanceUrl } = await getAuth(true));
      continue; // retente la même page avec un token frais
    }
    if (res.status >= 500 && attempt < 3) {
      attempt += 1;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Salesforce query failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    all.push(...(data.records || []));
    path = data.nextRecordsUrl || null;
    attempt = 0; // budget de retry réinitialisé pour la page suivante
  }
  return all;
}

function groupByOwner(records, withAmount) {
  const map = new Map();
  for (const r of records) {
    const owner = matchSaleStrict(r.owner) || 'Inconnu';
    const entry = map.get(owner) || { count: 0, amount: 0 };
    entry.count += 1;
    if (withAmount) entry.amount += r.amount || 0;
    map.set(owner, entry);
  }
  return map;
}

function onlyActive(map, withAmount) {
  return Array.from(map.entries())
    .map(([name, e]) => (withAmount ? { name, count: e.count, amount: e.amount } : { name, count: e.count }))
    .sort((a, b) => (withAmount ? b.amount - a.amount : b.count - a.count));
}

// ==========================================
//  CACHES BRUTS (fenêtre élargissable, voir server/rawDataCache.js)
//  Corrige le point relevé : contrairement à Aircall, Salesforce n'avait
//  aucun cache — chaque plage "custom" retapait le SOQL en direct.
//
//  IMPORTANT sur le choix des TTL :
//  - Opportunity IsWon=true (Closed Won) : fait IMMUABLE une fois écrit
//    (un deal gagné ne redevient pas "non gagné" sur cette période) → TTL
//    long (30 min), comme le cache Aircall.
//  - Lead.Status='Working' / Account "Proposition envoyée" : reflète un
//    STATUT COURANT mutable (un lead peut sortir de "Working" entre deux
//    chargements) → TTL court (5 min, aligné sur le cache dashboard global)
//    pour ne jamais afficher un statut visiblement périmé.
// ==========================================

const wonOppsCache = createWideningCache({
  ttlMs: 30 * 60 * 1000,
  fetchWindow: async (fromMs, toMs) => {
    const s = toSoqlDate(new Date(fromMs));
    const e = toSoqlDate(new Date(toMs));
    return queryAll(
      `SELECT Id, Name, Amount, CloseDate, Owner.Name FROM Opportunity WHERE IsWon = true AND CloseDate >= ${s} AND CloseDate <= ${e}`
    );
  },
  mapRecord: (r) => ({ at: new Date(r.CloseDate).getTime(), amount: r.Amount || 0, owner: r.Owner?.Name || null }),
});

const workingLeadsCache = createWideningCache({
  ttlMs: parseInt(process.env.SF_STATUS_CACHE_TTL_MS || '300000', 10), // 5 min par défaut
  // Calcul "ancien" des propals pistes (voir PROPALS_MODE plus bas).
  fetchWindow: async (fromMs, toMs) => {
    const s = toSoqlDateTime(new Date(fromMs));
    const e = toSoqlDateTime(new Date(toMs));
    return queryAll(
      `SELECT Id, Name, Owner.Name, LastModifiedDate, Montant_estim__c FROM Lead WHERE Status = 'Working' AND LastModifiedDate >= ${s} AND LastModifiedDate <= ${e}`
    );
  },
  mapRecord: (r) => ({ at: new Date(r.LastModifiedDate).getTime(), owner: r.Owner?.Name || null, amount: r.Montant_estim__c || 0 }),
});

// --- Signatures sur la période (Opportunity Closed Won, CloseDate dans la plage) ---
export async function getSignatures({ start, end }) {
  const records = await wonOppsCache.get(start.getTime(), end.getTime());
  const detail = onlyActive(groupByOwner(records, true), true);
  const total = records.length;
  const totalAmount = records.reduce((sum, r) => sum + (r.amount || 0), 0);
  return { total, totalAmount, detail };
}

// --- CA sur la période (Opportunity Closed Won, CloseDate dans la plage) ---
export async function getRevenue({ start, end }) {
  const records = await wonOppsCache.get(start.getTime(), end.getTime());
  const detail = buildFullList(groupByOwner(records, true), true);
  const totalAmount = records.reduce((sum, r) => sum + (r.amount || 0), 0);
  return { totalAmount, detail };
}

// --- CA mensuel sur N mois glissants (graphique d'évolution) ---
// Réutilise le MÊME cache que getSignatures/getRevenue (wonOppsCache) : un seul
// appel qui élargit la fenêtre à N mois, puis un simple regroupement en mémoire
// par mois — pas de nouvel appel Salesforce dédié.
// `scopeNames` (optionnel) : restreint aux Opportunities dont le owner (matché
// via roster.js matchSale, même logique que groupByOwner) est dans cette liste —
// même principe que scopeByCommercial.js pour /api/dashboard, pour qu'un
// commercial/manager scopé n'y voie pas le CA de toute l'entreprise.
export async function getRevenueByMonth({ months = 12, scopeNames = null } = {}) {
  const n = Math.max(1, Math.min(24, parseInt(months, 10) || 12));
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);
  let records = await wonOppsCache.get(start.getTime(), now.getTime());
  if (Array.isArray(scopeNames) && scopeNames.length) {
    const allowed = new Set(scopeNames);
    records = records.filter((r) => allowed.has(matchSale(r.owner)));
  }

  const buckets = new Map(); // 'YYYY-MM' -> { amount, count }
  for (let i = 0; i < n; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1) + i, 1);
    buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, { amount: 0, count: 0 });
  }
  for (const r of records) {
    const d = new Date(r.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const b = buckets.get(key);
    if (b) { b.amount += r.amount || 0; b.count += 1; }
  }
  return Array.from(buckets.entries()).map(([month, b]) => ({ month, totalAmount: b.amount, total: b.count }));
}

// ==========================================
//  PROPOSITIONS : DEUX MODES DE CALCUL (interrupteur PROPALS_MODE)
//
//  - "ancien" (défaut) : fiches AU STATUT proposition AUJOURD'HUI, datées par
//    leur DERNIÈRE MODIFICATION (LastModifiedDate). Défaut connu : une fiche
//    retouchée après coup réapparaît à la date de la retouche, et une fiche
//    convertie/perdue disparaît du compteur.
//  - "historique" : fiches datées par le jour où elles sont PASSÉES au statut
//    proposition, lu dans l'historique de champ Salesforce (LeadHistory /
//    AccountHistory). Cette date ne bouge plus : ni une retouche, ni une
//    conversion, ni un refus ne la déplace ou ne la fait disparaître.
//    Décisions validées par Donatien (17/11/2026) :
//      * une fiche est comptée UNE SEULE FOIS, à la PREMIÈRE date de passage ;
//      * attribution au PROPRIÉTAIRE ACTUEL de la fiche (comme avant) ;
//      * fiche créée directement au statut proposition → datée à sa création.
//
//  Sécurité : en mode "historique", si l'historique du champ n'est pas suivi
//  dans Salesforce ou si la lecture échoue, on retombe sur le calcul "ancien"
//  (avec un message dans les logs) au lieu d'afficher 0.
//  Contrôle avant activation : GET /api/admin/propals-diagnostic (admin).
// ==========================================

const PROPOSITION_VALUE = 'Proposition envoyée';
const LEAD_PROPOSITION_VALUE = 'Working';
const HISTORY_TRACKING_TTL_MS = 30 * 60 * 1000;

export function getPropalsMode() {
  return String(process.env.PROPALS_MODE || '').trim().toLowerCase() === 'historique' ? 'historique' : 'ancien';
}

function normalizeValue(v) {
  return String(v == null ? '' : v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase();
}

// L'historique Salesforce peut contenir la valeur technique (ex. "Working") OU
// le libellé affiché (ex. "Proposition faite") selon l'org : on accepte les deux.
// Valeurs supplémentaires possibles via SF_LEAD_PROPOSITION_VALUES /
// SF_ACCOUNT_PROPOSITION_VALUES (séparées par des virgules).
function buildPropositionMatcher(values, envVar) {
  const extra = String(process.env[envVar] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const set = new Set([...values, ...extra].map(normalizeValue));
  return (v) => set.has(normalizeValue(v));
}
const isLeadProposition = buildPropositionMatcher([LEAD_PROPOSITION_VALUE, 'Proposition faite'], 'SF_LEAD_PROPOSITION_VALUES');
const isAccountProposition = buildPropositionMatcher([PROPOSITION_VALUE], 'SF_ACCOUNT_PROPOSITION_VALUES');

function soqlString(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- Le champ statut a-t-il son historique suivi dans Salesforce ? ----------
const historyTrackingCache = new Map(); // 'Lead.Status' -> { tracked, at, error }

async function isFieldHistoryTracked(objectName, fieldName) {
  const key = `${objectName}.${fieldName}`;
  const hit = historyTrackingCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TRACKING_TTL_MS) return hit;
  let entry;
  try {
    const rows = await queryAll(
      `SELECT QualifiedApiName, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${soqlString(objectName)}' AND QualifiedApiName = '${soqlString(fieldName)}'`
    );
    entry = { tracked: rows.length ? rows[0].IsFieldHistoryTracked === true : false, at: Date.now(), error: rows.length ? null : 'champ introuvable dans FieldDefinition' };
  } catch (e) {
    entry = { tracked: false, at: Date.now(), error: String(e?.message || e) };
  }
  historyTrackingCache.set(key, entry);
  return entry;
}

/**
 * Cœur du mode "historique" : fiches (Lead ou Account) dont la PREMIÈRE entrée
 * au statut proposition tombe dans [fromMs, toMs].
 *
 * 1. Candidats :
 *    a) changements de statut VERS proposition dans la plage ;
 *    b) changements de statut DEPUIS proposition entre le début de la plage et
 *       maintenant (rattrape une fiche créée directement en proposition puis
 *       sortie du statut) ;
 *    c) fiches créées dans la plage et encore au statut proposition.
 * 2. Pour chaque candidat : tout l'historique du statut + propriétaire et
 *    montant ACTUELS → calcul de la première date de passage.
 * 3. On ne garde que les fiches dont cette première date est dans la plage.
 */
async function fetchFirstPropositions({ objectName, statusField, currentValue, isProposition, fromMs, toMs }) {
  const historyObject = `${objectName}History`;
  const idField = `${objectName}Id`;
  const s = toSoqlDateTime(new Date(fromMs));
  const e = toSoqlDateTime(new Date(toMs));
  const field = soqlString(statusField);

  const changes = await queryAll(
    `SELECT ${idField}, CreatedDate, OldValue, NewValue FROM ${historyObject} WHERE Field = '${field}' AND CreatedDate >= ${s}`
  );
  const candidates = new Set();
  for (const h of changes) {
    const at = new Date(h.CreatedDate).getTime();
    if (isProposition(h.NewValue) && at <= toMs) candidates.add(h[idField]);
    if (isProposition(h.OldValue)) candidates.add(h[idField]);
  }
  const createdInProposition = await queryAll(
    `SELECT Id FROM ${objectName} WHERE ${statusField} = '${soqlString(currentValue)}' AND CreatedDate >= ${s} AND CreatedDate <= ${e}`
  );
  for (const r of createdInProposition) candidates.add(r.Id);
  if (!candidates.size) return [];

  const records = [];
  for (const ids of chunk([...candidates], 150)) {
    const inList = ids.map((id) => `'${soqlString(id)}'`).join(',');
    const rows = await queryAll(
      `SELECT Id, Name, CreatedDate, ${statusField}, Owner.Name, Montant_estim__c, ` +
      `(SELECT CreatedDate, OldValue, NewValue FROM Histories WHERE Field = '${field}' ORDER BY CreatedDate ASC) ` +
      `FROM ${objectName} WHERE Id IN (${inList})`
    );
    for (const r of rows) {
      const history = (r.Histories && r.Histories.records) || [];
      const initialStatus = history.length ? history[0].OldValue : r[statusField];
      let firstAt = null;
      if (isProposition(initialStatus)) {
        firstAt = new Date(r.CreatedDate).getTime();
      } else {
        const firstIn = history.find((h) => isProposition(h.NewValue));
        if (firstIn) firstAt = new Date(firstIn.CreatedDate).getTime();
      }
      if (firstAt == null || firstAt < fromMs || firstAt > toMs) continue;
      records.push({
        id: r.Id,
        name: r.Name || null,
        at: firstAt,
        owner: r.Owner?.Name || null,
        amount: r.Montant_estim__c || 0,
        currentStatus: r[statusField] ?? null,
      });
    }
  }
  return records;
}

// --- Caches du mode "historique" (même TTL court que l'ancien calcul) ------
const STATUS_TTL_MS = parseInt(process.env.SF_STATUS_CACHE_TTL_MS || '300000', 10);

const leadPropositionsHistoryCache = createWideningCache({
  ttlMs: STATUS_TTL_MS,
  fetchWindow: (fromMs, toMs) => fetchFirstPropositions({
    objectName: 'Lead', statusField: 'Status', currentValue: LEAD_PROPOSITION_VALUE,
    isProposition: isLeadProposition, fromMs, toMs,
  }),
  mapRecord: (r) => ({ at: r.at, owner: r.owner, amount: r.amount }),
});

let accountsPropositionsHistoryCache = null;
function getAccountsPropositionsHistoryCache(fieldName) {
  if (accountsPropositionsHistoryCache) return accountsPropositionsHistoryCache;
  accountsPropositionsHistoryCache = createWideningCache({
    ttlMs: STATUS_TTL_MS,
    fetchWindow: (fromMs, toMs) => fetchFirstPropositions({
      objectName: 'Account', statusField: fieldName, currentValue: PROPOSITION_VALUE,
      isProposition: isAccountProposition, fromMs, toMs,
    }),
    mapRecord: (r) => ({ at: r.at, owner: r.owner, amount: r.amount }),
  });
  return accountsPropositionsHistoryCache;
}

function summarize(records, mode, extra = {}) {
  const detail = buildFullList(groupByOwner(records, true), true);
  const totalAmount = records.reduce((sum, r) => sum + (r.amount || 0), 0);
  return { total: records.length, totalAmount, detail, mode, ...extra };
}

// Un seul message par raison de repli (évite d'inonder les logs Render toutes les 5 min).
const fallbackLogged = new Set();
function logFallbackOnce(scope, reason) {
  const key = `${scope}:${reason}`;
  if (fallbackLogged.has(key)) return;
  fallbackLogged.add(key);
  console.warn(`[PROPALS] ${scope} : mode "historique" indisponible → calcul "ancien" utilisé. Raison : ${reason}`);
}

// --- Propals pistes (Lead) ---------------------------------------------------
export async function getPropals({ start, end }) {
  if (getPropalsMode() === 'historique') {
    const tracking = await isFieldHistoryTracked('Lead', 'Status');
    if (tracking.tracked) {
      try {
        const records = await leadPropositionsHistoryCache.get(start.getTime(), end.getTime());
        return summarize(records, 'historique');
      } catch (e) {
        logFallbackOnce('Propals pistes', String(e?.message || e));
      }
    } else {
      logFallbackOnce('Propals pistes', tracking.error || "historique du champ Lead.Status non suivi dans Salesforce");
    }
    const records = await workingLeadsCache.get(start.getTime(), end.getTime());
    return summarize(records, 'ancien', { fallback: true });
  }
  const records = await workingLeadsCache.get(start.getTime(), end.getTime());
  return summarize(records, 'ancien');
}

// ==========================================
//  PROPOSITIONS SUR COMPTES
//  Statut "Proposition envoyée" sur l'objet Account.
//  Le nom API du champ statut est auto-découvert
//  (ou forcé via SF_ACCOUNT_STATUS_FIELD).
// ==========================================

let cachedStatusField = null;

/** Trouve le champ picklist de Account qui contient la valeur "Proposition envoyée". */
async function getAccountStatusField() {
  if (process.env.SF_ACCOUNT_STATUS_FIELD) return process.env.SF_ACCOUNT_STATUS_FIELD;
  if (cachedStatusField) return cachedStatusField;

  const { accessToken, instanceUrl } = await getAuth();
  const res = await fetch(`${instanceUrl}/services/data/v59.0/sobjects/Account/describe`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce describe Account failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const field = (data.fields || []).find(
    (f) => f.type === 'picklist' &&
      (f.picklistValues || []).some((v) => (v.label === PROPOSITION_VALUE || v.value === PROPOSITION_VALUE))
  );
  if (!field) {
    throw new Error(
      `champ statut introuvable sur Account (aucune picklist avec la valeur "${PROPOSITION_VALUE}"). Forcer via SF_ACCOUNT_STATUS_FIELD si besoin.`
    );
  }
  cachedStatusField = field.name;
  console.log(`Salesforce: champ statut Account découvert → ${field.name}`);
  return cachedStatusField;
}

// Créé après coup (dépend du nom de champ auto-découvert), une seule fois.
let accountsPropalCache = null;
function getAccountsPropalCache(fieldName) {
  if (accountsPropalCache) return accountsPropalCache;
  accountsPropalCache = createWideningCache({
    ttlMs: STATUS_TTL_MS, // 5 min par défaut
    fetchWindow: async (fromMs, toMs) => {
      const s = toSoqlDateTime(new Date(fromMs));
      const e = toSoqlDateTime(new Date(toMs));
      return queryAll(
        `SELECT Id, Name, Owner.Name, LastModifiedDate, Montant_estim__c FROM Account WHERE ${fieldName} = '${soqlString(PROPOSITION_VALUE)}' AND LastModifiedDate >= ${s} AND LastModifiedDate <= ${e}`
      );
    },
    mapRecord: (r) => ({ at: new Date(r.LastModifiedDate).getTime(), owner: r.Owner?.Name || null, amount: r.Montant_estim__c || 0 }),
  });
  return accountsPropalCache;
}

/**
 * Comptes passés en "Proposition envoyée" sur la plage (mode "historique"), ou
 * comptes à ce statut modifiés dans la plage (mode "ancien"), groupés par
 * propriétaire (même convention que les propals pistes).
 */
export async function getPropalsComptes({ start, end }) {
  const fieldName = await getAccountStatusField();
  if (getPropalsMode() === 'historique') {
    const tracking = await isFieldHistoryTracked('Account', fieldName);
    if (tracking.tracked) {
      try {
        const records = await getAccountsPropositionsHistoryCache(fieldName).get(start.getTime(), end.getTime());
        return summarize(records, 'historique');
      } catch (e) {
        logFallbackOnce('Propals comptes', String(e?.message || e));
      }
    } else {
      logFallbackOnce('Propals comptes', tracking.error || `historique du champ Account.${fieldName} non suivi dans Salesforce`);
    }
    const records = await getAccountsPropalCache(fieldName).get(start.getTime(), end.getTime());
    return summarize(records, 'ancien', { fallback: true });
  }
  const records = await getAccountsPropalCache(fieldName).get(start.getTime(), end.getTime());
  return summarize(records, 'ancien');
}

// ==========================================
//  DIAGNOSTIC (route /api/admin/propals-diagnostic, lecture seule)
//  Compare, sur une plage, l'ancien et le nouveau calcul fiche par fiche,
//  SANS passer par les caches et SANS dépendre de PROPALS_MODE. Sert à
//  vérifier les chiffres avant d'activer PROPALS_MODE=historique.
// ==========================================

const DIAG_LIST_MAX = 300;

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

async function diagnoseObject({ label, objectName, statusField, currentValue, isProposition, fromMs, toMs }) {
  const s = toSoqlDateTime(new Date(fromMs));
  const e = toSoqlDateTime(new Date(toMs));
  const out = { label, objet: objectName, champStatut: statusField };

  const tracking = await isFieldHistoryTracked(objectName, statusField);
  out.historiqueSuivi = tracking.tracked;
  if (tracking.error) out.historiqueErreur = tracking.error;

  const oldRows = await queryAll(
    `SELECT Id, Name, Owner.Name, LastModifiedDate FROM ${objectName} WHERE ${statusField} = '${soqlString(currentValue)}' AND LastModifiedDate >= ${s} AND LastModifiedDate <= ${e}`
  );
  const oldMap = new Map(oldRows.map((r) => [r.Id, { id: r.Id, nom: r.Name, proprietaire: r.Owner?.Name || null, dateAncienCalcul: r.LastModifiedDate }]));

  let newMap = new Map();
  if (tracking.tracked) {
    try {
      // Valeurs réellement écrites dans l'historique sur la plage : permet de
      // vérifier que la valeur "proposition" est bien reconnue.
      const changes = await queryAll(
        `SELECT NewValue FROM ${objectName}History WHERE Field = '${soqlString(statusField)}' AND CreatedDate >= ${s} AND CreatedDate <= ${e}`
      );
      const seen = {};
      for (const c of changes) {
        const k = String(c.NewValue);
        seen[k] = (seen[k] || 0) + 1;
      }
      out.valeursVuesDansHistorique = Object.entries(seen)
        .sort((a, b) => b[1] - a[1])
        .map(([valeur, nb]) => ({ valeur, nb, reconnueCommeProposition: isProposition(valeur) }));

      const recs = await fetchFirstPropositions({ objectName, statusField, currentValue, isProposition, fromMs, toMs });
      newMap = new Map(recs.map((r) => [r.id, { id: r.id, nom: r.name, proprietaire: r.owner, dateNouveauCalcul: iso(r.at), statutActuel: r.currentStatus }]));
    } catch (err) {
      out.historiqueErreur = String(err?.message || err);
    }
  }

  const both = [];
  const onlyOld = [];
  const onlyNew = [];
  for (const [id, o] of oldMap) {
    if (newMap.has(id)) both.push({ ...o, ...newMap.get(id) });
    else onlyOld.push(o);
  }
  for (const [id, n] of newMap) if (!oldMap.has(id)) onlyNew.push(n);

  out.totaux = {
    ancienCalcul: oldMap.size,
    nouveauCalcul: tracking.tracked && !out.historiqueErreur ? newMap.size : null,
    dansLesDeux: both.length,
    seulementAncien_fauxPositifs: onlyOld.length,
    seulementNouveau_propositionsManquees: onlyNew.length,
  };
  out.seulementAncien_fauxPositifs = onlyOld.slice(0, DIAG_LIST_MAX);
  out.seulementNouveau_propositionsManquees = onlyNew.slice(0, DIAG_LIST_MAX);
  out.dansLesDeux = both.slice(0, DIAG_LIST_MAX);
  if (Math.max(both.length, onlyOld.length, onlyNew.length) > DIAG_LIST_MAX) {
    out.listesTronquees = `listes limitées à ${DIAG_LIST_MAX} lignes chacune (les totaux sont complets)`;
  }
  return out;
}

export async function diagnosePropals({ start, end }) {
  const fromMs = start.getTime();
  const toMs = end.getTime();
  const result = {
    modeActif: getPropalsMode(),
    plage: { debut: iso(fromMs), fin: iso(toMs) },
    lecture: 'Comparaison en lecture seule. "seulementAncien" = fiches comptées aujourd\'hui à tort sur la période (date de dernière modification). "seulementNouveau" = propositions faites sur la période mais absentes aujourd\'hui (fiche retouchée plus tard, convertie ou perdue).',
  };
  try {
    result.pistes = await diagnoseObject({
      label: 'Propals pistes (Lead)', objectName: 'Lead', statusField: 'Status',
      currentValue: LEAD_PROPOSITION_VALUE, isProposition: isLeadProposition, fromMs, toMs,
    });
  } catch (e) {
    result.pistes = { erreur: String(e?.message || e) };
  }
  try {
    const fieldName = await getAccountStatusField();
    result.comptes = await diagnoseObject({
      label: 'Propals comptes (Account)', objectName: 'Account', statusField: fieldName,
      currentValue: PROPOSITION_VALUE, isProposition: isAccountProposition, fromMs, toMs,
    });
  } catch (e) {
    result.comptes = { erreur: String(e?.message || e) };
  }
  return result;
}

/** Diagnostic (route /api/admin/cache) : état des caches bruts Salesforce. */
export function getCacheStats() {
  return {
    wonOpportunities: wonOppsCache.stats(),
    workingLeads: workingLeadsCache.stats(),
    accountsPropal: accountsPropalCache ? accountsPropalCache.stats() : null,
    leadPropositionsHistory: leadPropositionsHistoryCache.stats(),
    accountsPropositionsHistory: accountsPropositionsHistoryCache ? accountsPropositionsHistoryCache.stats() : null,
  };
}
