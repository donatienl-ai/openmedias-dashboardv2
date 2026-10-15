// ── CONNECTEUR SALESFORCE ──────────────────────────────────────────────────
// Auth via OAuth Client Credentials Flow (réutilise les identifiants déjà
// configurés pour l'OpenMedias Dashboard — même org SF).
// Variables attendues : SALESFORCE_DOMAIN_URL, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET

let cachedAuth = null;
let cachedExpiry = 0;

async function getAuth() {
  const now = Date.now();
  if (cachedAuth && now < cachedExpiry) return cachedAuth;

  const domain = process.env.SALESFORCE_DOMAIN_URL;
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) {
    throw new Error('Salesforce non configuré (SALESFORCE_DOMAIN_URL / SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET manquants)');
  }

  const res = await fetch(`${domain}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Auth Salesforce échouée: ${JSON.stringify(json)}`);

  cachedAuth = { accessToken: json.access_token, instanceUrl: json.instance_url };
  cachedExpiry = now + 50 * 60 * 1000; // 50 min
  return cachedAuth;
}

// Liste des utilisateurs SF actifs (commerciaux potentiels).
// Filtre volontairement large (IsActive=true) — le tri/filtrage fin se fait
// côté app quand l'édito choisit qui rattacher à quelle équipe.
async function getCommerciaux() {
  const { accessToken, instanceUrl } = await getAuth();
  const soql = encodeURIComponent("SELECT Id, Name, Email FROM User WHERE IsActive = true ORDER BY Name");
  const res = await fetch(`${instanceUrl}/services/data/v59.0/query?q=${soql}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Requête Salesforce échouée: ${JSON.stringify(json)}`);
  return (json.records || []).map(r => ({ sf_id: r.Id, nom: r.Name, email: r.Email || '' }));
}

// Relit l'état ACTUEL d'une Opportunité côté Salesforce (par Id), pour permettre
// à l'app de se resynchroniser à la demande — au lieu de rester bloquée sur
// l'unique snapshot capté par le webhook au moment du passage en Fermée Gagnée
// (le Flow SF ne se redéclenche jamais sur une modif ultérieure de l'Opportunité).
async function getOpportunity(sfId) {
  const { accessToken, instanceUrl } = await getAuth();
  const soql = encodeURIComponent(
    "SELECT Id, Account.Name, Secteur_diffusion__c, Format__c, M_dia__c, " +
    "Date_de_diffusion__c, Pas_de_date_de_diffusion_connue__c, Owner.FirstName, " +
    "Homepage_Figaro__c, Homepage_Economie_Figaro__c, Amount, StageName, IsWon, IsClosed " +
    "FROM Opportunity WHERE Id = '" + sfId + "'"
  );
  const res = await fetch(`${instanceUrl}/services/data/v59.0/query?q=${soql}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Requête Salesforce échouée: ${JSON.stringify(json)}`);
  const opp = (json.records || [])[0];
  if (!opp) return null;
  return {
    sf_opportunity_id: opp.Id,
    entreprise: opp.Account ? opp.Account.Name : null,
    secteur: opp.Secteur_diffusion__c || null,
    format: opp.Format__c || null,
    media: opp.M_dia__c || null,
    date_diffusion: opp.Date_de_diffusion__c || null,
    sans_date: !!opp.Pas_de_date_de_diffusion_connue__c,
    commercial: opp.Owner ? opp.Owner.FirstName : null,
    homepage: !!opp.Homepage_Figaro__c,
    homepage_eco: !!opp.Homepage_Economie_Figaro__c,
    montant: opp.Amount || 0,
    // Étape Salesforce (15/10/2026, demande Lina) : une diffusion n'entre dans le
    // planning qu'une fois l'opportunité clôturée gagnée (IsWon).
    sf_stage: opp.StageName || null,
    sf_is_won: opp.IsWon === true,
    sf_is_closed: opp.IsClosed === true
  };
}

// Extrait un Id Salesforce (15 ou 18 caractères) d'une chaîne quelconque --
// permet de coller soit l'Id nu, soit l'URL complète de la fiche Piste
// (Lightning ou Classic). Utilisé par l'import "Piste Salesforce" du BDC.
function extractSalesforceId(raw) {
  const match = String(raw || '').match(/[a-zA-Z0-9]{15,18}/);
  return match ? match[0] : null;
}

// Récupère les champs nécessaires au formulaire BDC à partir d'une Piste (Lead).
// L'org OpenMedias n'a pas de champs personnalisés dédiés au BDC sur la Piste
// (confirmé) -- seuls les champs standard sont importés : entreprise (Company),
// contact (Name), adresse (Street/PostalCode/City) et responsable d'émission
// (Owner.Name). Thématique, date de diffusion, montant HT et média restent en
// saisie manuelle.
async function getLeadForBdc(rawIdOrUrl) {
  const leadId = extractSalesforceId(rawIdOrUrl);
  if (!leadId) throw new Error('Id ou URL de piste Salesforce invalide');

  const { accessToken, instanceUrl } = await getAuth();
  const soql = encodeURIComponent(
    "SELECT Id, Company, FirstName, LastName, Name, Email, Street, PostalCode, City, Owner.Name " +
    "FROM Lead WHERE Id = '" + leadId + "'"
  );
  const res = await fetch(`${instanceUrl}/services/data/v59.0/query?q=${soql}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Requête Salesforce échouée: ${JSON.stringify(json)}`);
  const lead = (json.records || [])[0];
  if (!lead) throw new Error(`Piste introuvable: ${leadId}`);

  const adresse = [lead.Street, lead.PostalCode, lead.City].filter(Boolean).join(', ');
  return {
    fields: {
      entreprise: lead.Company || '',
      contact: lead.Name || [lead.FirstName, lead.LastName].filter(Boolean).join(' '),
      adresse,
      respEmission: (lead.Owner && lead.Owner.Name) || '',
      email: lead.Email || '',
    },
  };
}

// Étape de plusieurs opportunités en UNE requête (vérification des BDC en attente
// toutes les 20 s, 15/10/2026) : { [Id]: { stage, won, closed } }.
async function getOpportunitiesEtape(ids) {
  const propres = [...new Set((ids || []).filter((x) => /^[a-zA-Z0-9]{15,18}$/.test(String(x))))];
  if (!propres.length) return {};
  const { accessToken, instanceUrl } = await getAuth();
  const out = {};
  for (let i = 0; i < propres.length; i += 100) {
    const lot = propres.slice(i, i + 100).map((x) => "'" + x + "'").join(',');
    const soql = encodeURIComponent('SELECT Id, StageName, IsWon, IsClosed FROM Opportunity WHERE Id IN (' + lot + ')');
    const res = await fetch(`${instanceUrl}/services/data/v59.0/query?q=${soql}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`Requête Salesforce échouée: ${JSON.stringify(json)}`);
    for (const o of json.records || []) {
      const e = { stage: o.StageName || null, won: o.IsWon === true, closed: o.IsClosed === true };
      out[o.Id] = e; out[String(o.Id).slice(0, 15)] = e;
    }
  }
  return out;
}

module.exports = { getCommerciaux, getOpportunity, getOpportunitiesEtape, getLeadForBdc, extractSalesforceId };
