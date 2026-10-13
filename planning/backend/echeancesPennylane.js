// ── ÉCHÉANCES / ACOMPTES LUS DANS PENNYLANE (13/10/2026, demande Lina) ────────
// Pennylane n'expose pas les acomptes dans un champ structuré (`installments`
// est vide) : ils sont écrits dans la « mention spéciale » de la facture, ex.
//   « 1ᵉʳ acompte de 1 644.00€ TTC avant le 15/02/2025. »
//   « 2ᵉ acompte de 50% soit 3 588.00€ TTC avant le 15/05/2025. »
// Ce module lit ces lignes et calcule l'état de chaque acompte à partir du
// montant déjà couvert (montant TTC − restant dû), affecté dans l'ordre (le 1er
// acompte d'abord). Règle Lina : les calculs doivent être justes ; une erreur de
// saisie dans Pennylane est signalée (« illisible »), jamais devinée.

const RANG = '(\\d{1,2})\\s*(?:er|ère|re|ᵉʳ|ᵉ|e|eme|ème|ieme|ième|°)?';
const TYPES = '(acompte|échéance|echeance|versement|paiement|règlement|reglement)';
const LIGNE_RE = new RegExp(`${RANG}\\s+${TYPES}\\b([^\\n]*)`, 'i');
const SOLDE_RE = /\b(solde)\b([^\n]*)/i;
const DATE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
const PCT_RE = /(\d{1,3}(?:[.,]\d+)?)\s*%/;
const MONTANT_RE = /([\d][\d\s  .,]*)\s*(?:€|eur\b|euros?\b)/i;

function lireMontant(txt) {
  const m = MONTANT_RE.exec(txt);
  if (!m) return { montant: null, brut: null };
  const brut = m[1].trim();
  const compact = brut.replace(/[\s  ]/g, '');
  // Formats acceptés : 1644 · 1644.00 · 1644,5 · 1.644,00 (milliers à point + décimales à virgule)
  let n = null;
  if (/^\d+([.,]\d{1,2})?$/.test(compact)) n = Number(compact.replace(',', '.'));
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(compact)) n = Number(compact.replace(/\./g, '').replace(',', '.'));
  return { montant: Number.isFinite(n) ? n : null, brut };
}

function lireDate(txt) {
  const m = DATE_RE.exec(txt);
  if (!m) return null;
  const [, j, mo, a] = m;
  const iso = `${a}-${String(mo).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(j) ? null : iso;
}

/** Lit les acomptes écrits dans la mention spéciale. Renvoie [] si aucun. */
function lireAcomptes(mention, montantTtc) {
  if (!mention) return [];
  const lignes = String(mention).split(/\r?\n|(?<=\.)\s+(?=\d{1,2}\s*(?:er|ère|re|ᵉʳ|ᵉ|e|eme|ème)?\s+(?:acompte|échéance|echeance|versement))|(?<=\.)\s+(?=solde\b)/i);
  const out = [];
  for (const ligne of lignes) {
    let rang = null; let reste = null; let type = null;
    const m = LIGNE_RE.exec(ligne);
    if (m) { rang = Number(m[1]); type = m[2].toLowerCase(); reste = m[3]; }
    else {
      const s = SOLDE_RE.exec(ligne);
      if (!s || !/€|eur/i.test(ligne) || !DATE_RE.test(ligne)) continue;
      type = 'solde'; reste = s[2];
    }
    const pct = PCT_RE.exec(reste);
    const { montant, brut } = lireMontant(reste);
    const date = lireDate(reste);
    let valeur = montant;
    let source = 'montant';
    let alerte = null;
    if (valeur == null && pct && Number.isFinite(Number(montantTtc))) {
      valeur = Math.round(Number(montantTtc) * Number(pct[1].replace(',', '.'))) / 100;
      source = 'pourcentage';
      alerte = brut ? `Montant illisible « ${brut} €» : calculé à partir de ${pct[1]} % du TTC` : null;
    }
    if (valeur == null) alerte = `Montant illisible${brut ? ` « ${brut} €»` : ''}`;
    if (!date) alerte = (alerte ? alerte + ' ; ' : '') + 'date illisible';
    out.push({ rang, type, montant: valeur, source, date, alerte, texte: ligne.trim().slice(0, 200) });
  }
  // Rangs : numéro lu ; « solde » ou rang absent → à la suite.
  let next = Math.max(0, ...out.map((a) => a.rang || 0));
  for (const a of out) if (!a.rang) a.rang = ++next;
  out.sort((a, b) => a.rang - b.rang);
  return out;
}

/**
 * Restant dû retenu : 0 si la facture est payée (Pennylane laisse parfois le
 * restant égal au total sur des factures payées), sinon le restant Pennylane.
 */
function restantRetenu(status, remaining) {
  if (status === 'paid') return 0;
  const n = Number(remaining);
  return remaining == null || remaining === '' || !Number.isFinite(n) ? null : n;
}

/** Calcule l'état de chaque acompte. `aujourdhui` = 'AAAA-MM-JJ'. */
function calculerEcheances({ mention, montantTtc, restant, status, aujourdhui }) {
  const acomptes = lireAcomptes(mention, montantTtc);
  if (!acomptes.length) return { acomptes: [], alertes: [] };
  const total = Number(montantTtc);
  const rest = restantRetenu(status, restant);
  const alertes = [];
  let couvert = rest == null || !Number.isFinite(total) ? null : Math.max(0, Math.round((total - rest) * 100) / 100);
  if (couvert == null) alertes.push('Restant dû inconnu : état des acomptes non calculé');
  const somme = acomptes.reduce((s, a) => s + (a.montant || 0), 0);
  if (acomptes.every((a) => a.montant != null) && Number.isFinite(total) && Math.abs(somme - total) > 1) {
    alertes.push(`La somme des acomptes (${somme.toFixed(2)} €) ne correspond pas au montant TTC (${total.toFixed(2)} €)`);
  }
  if (status === 'partially_cancelled') alertes.push('Facture partiellement annulée par un avoir : le montant couvert inclut l\'avoir');
  let dispo = couvert;
  const res = acomptes.map((a) => {
    let regle = null; let etat = 'inconnu';
    if (dispo != null && a.montant != null) {
      regle = Math.min(a.montant, dispo);
      dispo = Math.round((dispo - regle) * 100) / 100;
      if (regle >= a.montant - 0.01) etat = 'soldee';
      else if (a.date && a.date < aujourdhui) etat = 'en_retard';
      else if (regle > 0) etat = 'partielle';
      else etat = 'a_venir';
    }
    return { ...a, regle, resteAPayer: regle == null || a.montant == null ? null : Math.round((a.montant - regle) * 100) / 100, etat };
  });
  return { acomptes: res, alertes };
}

module.exports = { lireAcomptes, calculerEcheances, restantRetenu };
