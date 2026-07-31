// ==========================================
//  DOCUSIGN — ENVOI D'ENVELOPPES (BDC)
// ==========================================
// Complément en ÉCRITURE du connecteur lecture du dashboard (server/docusign.js,
// ESM, non réutilisable tel quel depuis ce backend CommonJS). Même app DocuSign
// (même integration key + clé privée), même hôte OAuth.
//
// ENVOI DEPUIS LE COMPTE DE CHAQUE COMMERCIAL : le JWT Grant impersonne
// l'utilisateur DocuSign du commercial (sub = son userId DocuSign, résolu depuis
// l'email de son compte planning via l'API Users). DocuSign exige alors un
// CONSENTEMENT INDIVIDUEL, accordé une seule fois par utilisateur via l'URL
// d'autorisation (buildConsentUrl) — sauf si un admin DocuSign a accordé le
// consentement au niveau de l'organisation (DocuSign Admin), auquel cas aucun
// lien n'est jamais demandé.
//
// Le placement de la signature repose sur un ANCHOR : tous les templates BDC
// (backend/bdc/templates/*.html) contiennent la phrase « Signature du client
// précédée de la mention … ». Si un jour un template la retire ou la reformule,
// le champ de signature tombera en haut à gauche du PDF — vérifier le rendu
// DocuSign après toute modif de template.

const crypto = require('crypto');

const OAUTH_HOST = () => process.env.DOCUSIGN_OAUTH_HOST || 'account.docusign.com';

// Texte d'ancrage présent dans les 3 templates BDC (1re ligne du bloc .signature)
const ANCHOR_SIGNATURE = 'Signature du client';

// Cache des tokens par utilisateur impersonné (sub -> {token, baseUri, accountId, expiry})
const authCache = new Map();

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function assertConfigured() {
  const missing = ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_USER_ID', 'DOCUSIGN_PRIVATE_KEY']
    .filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`DocuSign non configuré (${missing.join(', ')} manquant(s))`);
}

/** URL d'autorisation à faire ouvrir UNE FOIS par chaque commercial (consentement JWT). */
function buildConsentUrl() {
  // Doit correspondre EXACTEMENT à une Redirect URI enregistrée dans l'app
  // DocuSign (Settings > Apps and Keys > [app] > Redirect URIs) — le défaut
  // ci-dessous est celle qui y est enregistrée pour OpenMedias.
  const redirect = process.env.DOCUSIGN_REDIRECT_URI || 'https://openmedias-sales-dashboard.onrender.com';
  const params = new URLSearchParams({
    response_type: 'code',
    scope: 'signature impersonation',
    client_id: process.env.DOCUSIGN_INTEGRATION_KEY || '',
    redirect_uri: redirect,
  });
  return `https://${OAUTH_HOST()}/oauth/auth?${params.toString()}`;
}

/** Construit et signe le JWT (RS256) pour impersonner `sub` (userId DocuSign). */
function makeJwt(sub) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.DOCUSIGN_INTEGRATION_KEY,
    sub,
    aud: OAUTH_HOST(),
    iat: now,
    exp: now + 3500,
    scope: 'signature impersonation',
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  // La clé peut être collée avec des \n littéraux dans Render → on les restaure
  const key = (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${unsigned}.${signature}`;
}

/**
 * JWT Grant + découverte du compte (base_uri + account_id) pour l'utilisateur
 * `sub` (par défaut : DOCUSIGN_USER_ID, le compte central du reporting).
 * Cache 50 min par utilisateur. Lève une erreur code=CONSENT_REQUIRED (avec
 * consentUrl) tant que l'utilisateur n'a pas accordé son consentement.
 */
async function getAuth(sub, forceRefresh = false) {
  assertConfigured();
  const userId = sub || process.env.DOCUSIGN_USER_ID;
  const now = Date.now();
  const hit = authCache.get(userId);
  if (!forceRefresh && hit && now < hit.expiry) return hit;

  const res = await fetch(`https://${OAUTH_HOST()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: makeJwt(userId),
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    if (data.error === 'consent_required') {
      const err = new Error('DocuSign: consentement individuel requis (une seule fois)');
      err.code = 'CONSENT_REQUIRED';
      err.consentUrl = buildConsentUrl();
      throw err;
    }
    throw new Error(`DocuSign auth failed: ${JSON.stringify(data)}`);
  }

  const uiRes = await fetch(`https://${OAUTH_HOST()}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!uiRes.ok) throw new Error(`DocuSign userinfo failed (${uiRes.status})`);
  const ui = await uiRes.json();
  const wanted = process.env.DOCUSIGN_ACCOUNT_ID;
  const acct = (ui.accounts || []).find((a) => (wanted ? a.account_id === wanted : a.is_default)) || (ui.accounts || [])[0];
  if (!acct) throw new Error('DocuSign: aucun compte trouvé pour cet utilisateur');

  const auth = { token: data.access_token, baseUri: acct.base_uri, accountId: acct.account_id, expiry: now + 50 * 60 * 1000 };
  authCache.set(userId, auth);
  return auth;
}

function mapDocuSignError(status, text) {
  if (status === 401) return 'DocuSign: authentification refusée (clés / consentement à revérifier)';
  try {
    const j = JSON.parse(text);
    return `DocuSign (${status}): ${j.message || text.slice(0, 300)}`;
  } catch {
    return `DocuSign (${status}): ${text.slice(0, 300)}`;
  }
}

/**
 * Résout l'email d'un commercial vers son userId DocuSign, via l'API Users
 * appelée avec le compte central (doit avoir la permission "Users: read",
 * typiquement admin). Renvoie null si aucun utilisateur actif ne correspond.
 */
async function resolveDocuSignUserId(email) {
  const { token, baseUri, accountId } = await getAuth(); // compte central
  const res = await fetch(
    `${baseUri}/restapi/v2.1/accounts/${accountId}/users?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(mapDocuSignError(res.status, text));
  const data = JSON.parse(text);
  const wanted = String(email || '').toLowerCase();
  const user = (data.users || []).find(
    (u) => String(u.email || '').toLowerCase() === wanted && u.userStatus !== 'Closed'
  );
  return user ? user.userId : null;
}

/**
 * Envoie un PDF de BDC pour signature électronique, DEPUIS LE COMPTE DOCUSIGN
 * DU COMMERCIAL (senderUserId). L'enveloppe apparaît dans son dossier
 * « Envoyés » et l'email part en son nom.
 */
async function sendBdcEnvelope({ pdfBuffer, entreprise, signerName, signerEmail, message, senderUserId }) {
  const { token, baseUri, accountId } = await getAuth(senderUserId);
  const safeName = (entreprise || 'BDC').replace(/[^a-z0-9]+/gi, '_');

  const body = {
    emailSubject: `Bon de commande OpenMedias — ${entreprise || ''}`.trim(),
    emailBlurb: message || `Bonjour,\n\nVeuillez trouver ci-joint le bon de commande pour ${entreprise || 'votre campagne'}, à signer électroniquement.\n\nOpenMedias`,
    status: 'sent',
    documents: [{
      documentId: '1',
      name: `BDC_${safeName}.pdf`,
      fileExtension: 'pdf',
      documentBase64: pdfBuffer.toString('base64'),
    }],
    recipients: {
      signers: [{
        email: signerEmail,
        name: signerName,
        recipientId: '1',
        routingOrder: '1',
        tabs: {
          // Ancrage sur « Signature du client … » (voir note en tête de fichier).
          // ATTENTION aux unités : les "pixels" DocuSign ne valent PAS 1 px du
          // PDF (rendu ~2-3x plus espacé en pratique) et le bloc est centré, ce
          // qui a déjà causé deux erreurs en prod : XOffset 240 -> 400 "exceeds
          // page boundaries" ; YOffsets 28/98/128 -> bouton sur la mention et
          // nom/date dans les articles. Valeurs calibrées sur un envoi réel :
          // signature dans le blanc sous la mention, nom + date sur la même
          // ligne en dessous (XOffset 120 passe, 240 non).
          signHereTabs: [{
            anchorString: ANCHOR_SIGNATURE,
            anchorUnits: 'pixels',
            anchorXOffset: '0',
            anchorYOffset: '58',
          }],
          fullNameTabs: [{
            anchorString: ANCHOR_SIGNATURE,
            anchorUnits: 'pixels',
            anchorXOffset: '0',
            anchorYOffset: '92',
          }],
          dateSignedTabs: [{
            anchorString: ANCHOR_SIGNATURE,
            anchorUnits: 'pixels',
            anchorXOffset: '120',
            anchorYOffset: '92',
          }],
        },
      }],
    },
  };

  const res = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(mapDocuSignError(res.status, text));
  const data = JSON.parse(text);
  return { envelopeId: data.envelopeId, status: data.status };
}

/**
 * Statut courant d'une enveloppe ('sent', 'completed', 'declined', 'voided'…).
 * Lu avec le token de l'expéditeur (senderUserId) — c'est son enveloppe ;
 * à défaut, avec le compte central (qui ne la verra que s'il a des droits
 * étendus sur les enveloppes des autres utilisateurs).
 */
async function getEnvelopeStatus(envelopeId, senderUserId) {
  const { token, baseUri, accountId } = await getAuth(senderUserId);
  const res = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(mapDocuSignError(res.status, text));
  const data = JSON.parse(text);
  return { status: data.status, statusChangedDateTime: data.statusChangedDateTime || null };
}

module.exports = { sendBdcEnvelope, getEnvelopeStatus, resolveDocuSignUserId, buildConsentUrl };
