// ==========================================
//  DOCUSIGN — ENVOI D'ENVELOPPES (BDC)
// ==========================================
// Complément en ÉCRITURE du connecteur lecture du dashboard (server/docusign.js,
// ESM, non réutilisable tel quel depuis ce backend CommonJS). Même auth JWT
// Grant, mêmes variables d'env, même compte : le consentement déjà accordé pour
// le reporting couvre aussi l'envoi (scope "signature impersonation").
//
// Le placement de la signature repose sur un ANCHOR : tous les templates BDC
// (backend/bdc/templates/*.html) contiennent la phrase « Signature du client
// précédée de la mention … ». Si un jour un template la retire ou la reformule,
// le champ de signature tombera en haut à gauche du PDF — vérifier le rendu
// DocuSign après toute modif de template.

const OAUTH_HOST = () => process.env.DOCUSIGN_OAUTH_HOST || 'account.docusign.com';

// Texte d'ancrage présent dans les 3 templates BDC (1re ligne du bloc .signature)
const ANCHOR_SIGNATURE = 'Signature du client';

let cached = null;
let cachedExpiry = 0;

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function assertConfigured() {
  const missing = ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_USER_ID', 'DOCUSIGN_PRIVATE_KEY']
    .filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`DocuSign non configuré (${missing.join(', ')} manquant(s))`);
}

/** Construit et signe le JWT (RS256) avec la clé privée RSA de l'app. */
function makeJwt() {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.DOCUSIGN_INTEGRATION_KEY,
    sub: process.env.DOCUSIGN_USER_ID,
    aud: OAUTH_HOST(),
    iat: now,
    exp: now + 3500,
    scope: 'signature impersonation',
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  // La clé peut être collée avec des \n littéraux dans Render → on les restaure
  const key = (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const signer = require('crypto').createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${unsigned}.${signature}`;
}

/** JWT Grant + découverte du compte (base_uri + account_id). Cache 50 min. */
async function getAuth(forceRefresh = false) {
  assertConfigured();
  const now = Date.now();
  if (!forceRefresh && cached && now < cachedExpiry) return cached;

  const res = await fetch(`https://${OAUTH_HOST()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: makeJwt(),
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    if (data.error === 'consent_required') {
      throw new Error("DocuSign: consentement requis — ouvrir l'URL de consentement une fois en tant qu'admin (voir README).");
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

  cached = { token: data.access_token, baseUri: acct.base_uri, accountId: acct.account_id };
  cachedExpiry = now + 50 * 60 * 1000;
  return cached;
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
 * Envoie un PDF de BDC pour signature électronique.
 * @param {object} p
 * @param {Buffer} p.pdfBuffer   PDF généré par renderBdcPdf()
 * @param {string} p.entreprise  Nom de l'annonceur (nom de fichier + objet email)
 * @param {string} p.signerName  Nom du signataire côté client
 * @param {string} p.signerEmail Email du signataire
 * @param {string} [p.message]   Message personnalisé dans l'email DocuSign
 * @returns {{envelopeId: string, status: string}}
 */
async function sendBdcEnvelope({ pdfBuffer, entreprise, signerName, signerEmail, message }) {
  const { token, baseUri, accountId } = await getAuth();
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
          // Ancrage sur « Signature du client … » (voir note en tête de fichier)
          signHereTabs: [{
            anchorString: ANCHOR_SIGNATURE,
            anchorUnits: 'pixels',
            anchorXOffset: '0',
            anchorYOffset: '28',
          }],
          dateSignedTabs: [{
            anchorString: ANCHOR_SIGNATURE,
            anchorUnits: 'pixels',
            anchorXOffset: '240',
            anchorYOffset: '34',
          }],
          fullNameTabs: [{
            anchorString: ANCHOR_SIGNATURE,
            anchorUnits: 'pixels',
            anchorXOffset: '0',
            anchorYOffset: '60',
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

/** Statut courant d'une enveloppe ('sent', 'completed', 'declined', 'voided'…). */
async function getEnvelopeStatus(envelopeId) {
  const { token, baseUri, accountId } = await getAuth();
  const res = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(mapDocuSignError(res.status, text));
  const data = JSON.parse(text);
  return { status: data.status, statusChangedDateTime: data.statusChangedDateTime || null };
}

module.exports = { sendBdcEnvelope, getEnvelopeStatus };
