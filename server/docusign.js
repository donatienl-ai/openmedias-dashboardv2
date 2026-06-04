// ==========================================
//  CONNECTEUR DOCUSIGN
//  Auth via JWT Grant (RSA), impersonation
//  → BDC envoyés / signés par commercial
// ==========================================
import fetch from 'node-fetch';
import crypto from 'crypto';
import { matchSale, buildFullList } from './roster.js';

// Hôte OAuth : account.docusign.com (prod) / account-d.docusign.com (demo)
const OAUTH_HOST = () => process.env.DOCUSIGN_OAUTH_HOST || 'account.docusign.com';

let cached = null;
let cachedExpiry = 0;

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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
  let key = process.env.DOCUSIGN_PRIVATE_KEY || '';
  key = key.replace(/\\n/g, '\n');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer
    .sign(key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${unsigned}.${signature}`;
}

/**
 * Authentifie via JWT Grant, puis découvre le compte (base_uri + account_id)
 * via /oauth/userinfo. Cache 50 min.
 */
async function getAuth() {
  const now = Date.now();
  if (cached && now < cachedExpiry) return cached;

  const jwt = makeJwt();
  const res = await fetch(`https://${OAUTH_HOST()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    if (data.error === 'consent_required') {
      throw new Error(
        "DocuSign: consentement requis. Ouvre l'URL de consentement (voir README) une fois en tant qu'admin."
      );
    }
    throw new Error(`DocuSign auth failed: ${JSON.stringify(data)}`);
  }

  // Découverte du compte : base_uri + account_id
  const uiRes = await fetch(`https://${OAUTH_HOST()}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!uiRes.ok) {
    throw new Error(`DocuSign userinfo failed (${uiRes.status})`);
  }
  const ui = await uiRes.json();
  const wanted = process.env.DOCUSIGN_ACCOUNT_ID;
  const acct =
    (ui.accounts || []).find((a) => (wanted ? a.account_id === wanted : a.is_default)) ||
    (ui.accounts || [])[0];
  if (!acct) throw new Error('DocuSign: aucun compte trouvé pour cet utilisateur');

  cached = {
    token: data.access_token,
    baseUri: acct.base_uri,
    accountId: acct.account_id,
  };
  cachedExpiry = now + 50 * 60 * 1000; // 50 min
  return cached;
}

/**
 * Liste les enveloppes dont le statut est passé à `fromToStatus`
 * (sent | completed) dans la plage. Pagine via nextUri.
 */
async function listEnvelopes({ start, end }, fromToStatus) {
  const { token, baseUri, accountId } = await getAuth();
  let url =
    `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes` +
    `?from_date=${encodeURIComponent(start.toISOString())}` +
    `&to_date=${encodeURIComponent(end.toISOString())}` +
    `&from_to_status=${fromToStatus}&count=100`;

  let all = [];
  let safety = 0;
  while (url && safety < 30) {
    safety += 1;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DocuSign envelopes failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    all = all.concat(data.envelopes || []);
    url = data.nextUri ? `${baseUri}/restapi${data.nextUri}` : null;
  }
  return all;
}

/** Groupe des enveloppes par expéditeur (matché au roster) → liste complète. */
function groupBySender(envelopes) {
  const map = new Map();
  for (const e of envelopes) {
    const name = matchSale(e.sender?.userName) || 'Inconnu';
    const entry = map.get(name) || { count: 0 };
    entry.count += 1;
    map.set(name, entry);
  }
  return buildFullList(map);
}

/**
 * BDC envoyés + signés sur la période.
 * - envoyés : enveloppes passées au statut "sent" dans la plage
 * - signés  : enveloppes passées au statut "completed" dans la plage
 */
export async function getBdc({ start, end }) {
  const [sentEnvs, signedEnvs] = await Promise.all([
    listEnvelopes({ start, end }, 'sent'),
    listEnvelopes({ start, end }, 'completed'),
  ]);
  return {
    sent: { total: sentEnvs.length, detail: groupBySender(sentEnvs) },
    signed: { total: signedEnvs.length, detail: groupBySender(signedEnvs) },
  };
}
