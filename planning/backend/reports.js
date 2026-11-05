const cron = require('node-cron');
const os = require('os');

function setupReports(db) {
  const MAILJET_API_KEY = process.env.MAILJET_API_KEY;
  const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY;
  const REPORT_FROM_EMAIL = process.env.REPORT_FROM_EMAIL || 'planning@openmedias.fr';
  const REPORT_EMAIL_EDITO = (process.env.REPORT_EMAIL_EDITO || '').split(',').map(s => s.trim()).filter(Boolean);
  const REPORT_EMAIL_GROWTH = (process.env.REPORT_EMAIL_GROWTH || '').split(',').map(s => s.trim()).filter(Boolean);
  const RECIPIENTS = [...REPORT_EMAIL_EDITO, ...REPORT_EMAIL_GROWTH];
  // Emails individuels (pour les notifications personnelles, hors distribution générale)
  const EMAIL_EVA = process.env.EMAIL_EVA || '';
  const EMAIL_FLAVIE = process.env.EMAIL_FLAVIE || '';
  const EMAIL_CLEVEL = process.env.EMAIL_CLEVEL || '';

  async function sendMailRaw(subject, html, recipients, attachments) {
    if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
      console.error('❌ Mailjet non configuré (MAILJET_API_KEY / MAILJET_SECRET_KEY manquants)');
      return;
    }
    const dest = [...new Set(recipients.filter(Boolean))];
    if (dest.length === 0) {
      console.error('❌ Aucun destinataire configuré pour cet envoi');
      return;
    }
    const auth = Buffer.from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`).toString('base64');
    const message = {
      From: { Email: REPORT_FROM_EMAIL, Name: 'Planning Diffusion OpenMedias' },
      To: dest.map(email => ({ Email: email })),
      Subject: subject,
      HTMLPart: html
    };
    // Pièces jointes Mailjet v3.1 : [{ ContentType, Filename, Base64Content }]
    if (attachments && attachments.length) message.Attachments = attachments;
    const body = { Messages: [message] };
    try {
      const res = await fetch('https://api.mailjet.com/v3.1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (res.ok) console.log(`✅ Email envoyé: ${subject}`);
      else console.error(`❌ Erreur envoi email: ${JSON.stringify(json)}`);
    } catch (e) {
      console.error('❌ Erreur envoi email:', e.message);
    }
  }

  // Diffusion générale (REPORT_EMAIL_EDITO + REPORT_EMAIL_GROWTH), + destinataires additionnels
  async function sendMail(subject, html, extraRecipients = []) {
    return sendMailRaw(subject, html, [...RECIPIENTS, ...extraRecipients]);
  }

  // Envoi ciblé, sans la liste de diffusion générale (pour les notifications personnelles)
  async function sendMailOnly(subject, html, recipients, attachments) {
    return sendMailRaw(subject, html, recipients, attachments);
  }

  // Empreinte de diagnostic en pied de chaque mail automatique : si un doublon
  // réapparaît, comparer cette ligne entre les deux mails — un hostname/pid
  // différent = un second service tourne encore quelque part avec sa base.
  function empreinteHtml(extra = '') {
    const svc = process.env.RENDER_SERVICE_NAME || 'local';
    const rev = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev';
    return `<p style="color:#aaa;font-size:10px;margin-top:16px">instance ${os.hostname()} · service ${svc} · pid ${process.pid} · rev ${rev}${extra ? ' · ' + extra : ''}</p>`;
  }

  // Anti-doublon : une seule exécution d'un rapport donné, même si deux
  // process partagent la MÊME base (chevauchement old/new instance au deploy).
  // L'UPDATE conditionnel est atomique en SQLite : seul le premier process
  // voit changes=1. (Ne protège PAS contre un second service avec sa PROPRE
  // base — c'est pour ça que l'empreinte ci-dessus existe.)
  function claimReportOnce(key) {
    db.prepare("INSERT OR IGNORE INTO config (key,value) VALUES (?, '')").run(key);
    return db.prepare("UPDATE config SET value='1' WHERE key=? AND value<>'1'").run(key).changes === 1;
  }

  function fmtMoney(n) {
    return (n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €';
  }

  function buildTable(rows, { withPanier = true } = {}) {
    let html = `<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px">
      <tr style="background:#1a1a2e;color:#fff">
        <th style="padding:8px;text-align:left">Média</th>
        <th style="padding:8px;text-align:right">Diffusions</th>
        <th style="padding:8px;text-align:right">CA diffusion</th>
        <th style="padding:8px;text-align:right">CA upsell</th>
        ${withPanier ? '<th style="padding:8px;text-align:right">Panier moyen</th>' : ''}
      </tr>`;
    let totalNb = 0, totalCaDiff = 0, totalCaUpsell = 0;
    for (const r of rows) {
      const nb = r.nb_emissions || 0;
      const caDiff = r.ca_diffusion || 0;
      const caUpsell = r.ca_upsell || 0;
      totalNb += nb; totalCaDiff += caDiff; totalCaUpsell += caUpsell;
      const panier = nb > 0 ? (caDiff + caUpsell) / nb : 0;
      html += `<tr style="border-bottom:1px solid #eee">
        <td style="padding:6px 8px">${r.media}</td>
        <td style="padding:6px 8px;text-align:right">${nb}</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(caDiff)}</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(caUpsell)}</td>
        ${withPanier ? `<td style="padding:6px 8px;text-align:right">${fmtMoney(panier)}</td>` : ''}
      </tr>`;
    }
    const panierGlobal = totalNb > 0 ? (totalCaDiff + totalCaUpsell) / totalNb : 0;
    html += `<tr style="font-weight:bold;background:#f5f5f5">
      <td style="padding:8px">TOTAL</td>
      <td style="padding:8px;text-align:right">${totalNb}</td>
      <td style="padding:8px;text-align:right">${fmtMoney(totalCaDiff)}</td>
      <td style="padding:8px;text-align:right">${fmtMoney(totalCaUpsell)}</td>
      ${withPanier ? `<td style="padding:8px;text-align:right">${fmtMoney(panierGlobal)}</td>` : ''}
    </tr></table>`;
    return html;
  }

  // ── RAPPORT MENSUEL — dernier vendredi du mois, données du mois en cours ──
  function reportMensuel({ force = false } = {}) {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (!force && !claimReportOnce(`mensuel_${period}`)) {
      console.log(`[MENSUEL] ${period} déjà envoyé — doublon ignoré`);
      return;
    }
    const rows = db.prepare(`
      SELECT media, COUNT(*) as nb_emissions, SUM(montant) as ca_diffusion, SUM(IFNULL(upsell,0)) as ca_upsell
      FROM emissions
      WHERE statut NOT IN ('annule','bdc_attente','a_programmer')
        AND strftime('%Y-%m', date_diffusion) = ?
      GROUP BY media ORDER BY (SUM(montant) + SUM(IFNULL(upsell,0))) DESC
    `).all(period);
    const moisNom = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const html = `<h2>📊 Reporting mensuel — ${moisNom}</h2>
      <p>Diffusions et CA généré ce mois-ci, par média.</p>
      ${buildTable(rows)}${empreinteHtml()}`;
    sendMail(`Reporting mensuel — ${moisNom}`, html);
  }

  // ── RAPPORT HEBDO — tous les vendredis 11h, semaine écoulée (lundi→vendredi) ──
  // Ancrage sur la DERNIÈRE SEMAINE COMPLÈTE (lun→ven), pas sur "aujourd'hui" :
  // le cron tire le vendredi (lundi = vendredi - 4), mais un déclenchement
  // manuel un lundi donnait "semaine du X au X" (un seul jour, 0 diffusion) —
  // vu en prod le 31/08/2026. Désormais : si on est vendredi, semaine en cours ;
  // sinon, on remonte au vendredi précédent et on prend sa semaine.
  function reportHebdo({ force = false } = {}) {
    const today = new Date();
    const dow = today.getDay(); // 0=dim … 5=ven
    const vendredi = new Date(today);
    vendredi.setDate(today.getDate() - ((dow + 2) % 7)); // vendredi de la semaine écoulée (ou aujourd'hui si vendredi)
    const lundi = new Date(vendredi); lundi.setDate(vendredi.getDate() - 4);
    const fmt = d => d.toISOString().slice(0, 10);
    if (!force && !claimReportOnce(`hebdo_${fmt(lundi)}`)) {
      console.log(`[HEBDO] semaine du ${fmt(lundi)} déjà envoyée — doublon ignoré`);
      return;
    }
    const rows = db.prepare(`
      SELECT media, COUNT(*) as nb_emissions, SUM(montant) as ca_diffusion, SUM(IFNULL(upsell,0)) as ca_upsell
      FROM emissions
      WHERE statut NOT IN ('annule','bdc_attente','a_programmer')
        AND date_diffusion >= ? AND date_diffusion <= ?
      GROUP BY media ORDER BY (SUM(montant) + SUM(IFNULL(upsell,0))) DESC
    `).all(fmt(lundi), fmt(vendredi));
    const total = rows.reduce((a, r) => a + r.nb_emissions, 0);
    const html = `<h2>📅 Reporting hebdomadaire — semaine du ${fmt(lundi)} au ${fmt(vendredi)}</h2>
      <p>Diffusions réalisées et CA généré cette semaine, par média.</p>
      ${rows.length ? buildTable(rows) : '<p>Aucune diffusion cette semaine-là.</p>'}${empreinteHtml(total + ' diffusions')}`;
    sendMail(`Reporting hebdomadaire — semaine du ${fmt(lundi)}`, html);
  }

  // ── APERÇU MOIS SUIVANT — dernier mercredi du mois, 11h ──
  function reportApercuMoisSuivant({ force = false } = {}) {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const period = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;
    if (!force && !claimReportOnce(`apercu_${period}`)) {
      console.log(`[APERCU] ${period} déjà envoyé — doublon ignoré`);
      return;
    }
    const rows = db.prepare(`
      SELECT media, COUNT(*) as nb_emissions
      FROM emissions
      WHERE statut NOT IN ('annule','a_programmer')
        AND strftime('%Y-%m', date_diffusion) = ?
      GROUP BY media ORDER BY nb_emissions DESC
    `).all(period);
    const total = rows.reduce((a, r) => a + r.nb_emissions, 0);
    const moisNom = nextMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    let html = `<h2>🔭 Aperçu du mois à venir — ${moisNom}</h2>
      <p>Nombre de diffusions déjà planifiées pour ${moisNom}, par média.</p>
      <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px">
      <tr style="background:#1a1a2e;color:#fff"><th style="padding:8px;text-align:left">Média</th><th style="padding:8px;text-align:right">Diffusions</th></tr>`;
    for (const r of rows) {
      html += `<tr style="border-bottom:1px solid #eee"><td style="padding:6px 8px">${r.media}</td><td style="padding:6px 8px;text-align:right">${r.nb_emissions}</td></tr>`;
    }
    html += `<tr style="font-weight:bold;background:#f5f5f5"><td style="padding:8px">TOTAL</td><td style="padding:8px;text-align:right">${total}</td></tr></table>${empreinteHtml(total + ' diffusions')}`;
    sendMail(`Aperçu du mois à venir — ${moisNom}`, html);
  }

  // ── KICK-OFF LUNDI — diffusions à venir cette semaine (lundi→vendredi) ──
  // Idempotence : un seul mail par semaine, même si deux process tournent en
  // parallèle sur la MÊME base (chevauchement old/new instance pendant un
  // deploy Render — cause probable des doublons constatés le 24/08/2026).
  // L'UPDATE conditionnel est atomique en SQLite (verrou d'écriture) : seul le
  // premier process voit changes=1 et envoie. Si le doublon venait d'une AUTRE
  // base (vieux service encore actif avec son propre disque), l'empreinte en
  // pied de mail (hostname/pid/compteur) permet de le repérer.
  // { force: true } (endpoint de test admin) bypasse la déduplication.
  function reportKickoffLundi({ force = false } = {}) {
    const today = new Date();
    const vendredi = new Date(today); vendredi.setDate(today.getDate() + 4);
    const fmt = d => d.toISOString().slice(0, 10);
    const semaine = fmt(today);

    if (!force && !claimReportOnce(`kickoff_${semaine}`)) {
      console.log(`[KICKOFF] semaine du ${semaine} déjà envoyée — doublon ignoré`);
      return;
    }

    const emissions = db.prepare(`
      SELECT * FROM emissions
      WHERE statut NOT IN ('annule','a_programmer')
        AND date_diffusion >= ? AND date_diffusion <= ?
      ORDER BY date_diffusion ASC, media ASC
    `).all(fmt(today), fmt(vendredi));

    let html = `<h2>🚀 Kick-off — diffusions de la semaine (${fmt(today)} au ${fmt(vendredi)})</h2>`;
    if (emissions.length === 0) {
      html += '<p>Aucune diffusion prévue cette semaine.</p>';
    } else {
      const byDate = {};
      for (const e of emissions) {
        (byDate[e.date_diffusion] = byDate[e.date_diffusion] || []).push(e);
      }
      for (const [date, list] of Object.entries(byDate)) {
        html += `<h3>${date}</h3><ul>`;
        for (const e of list) {
          html += `<li><b>${e.media}</b> — ${e.entreprise}${e.statut === 'bdc_attente' ? ' <i>(BDC en attente)</i>' : ''}</li>`;
        }
        html += '</ul>';
      }
    }
    // Empreinte de diagnostic : si un doublon réapparaît, comparer ces lignes
    // entre les deux mails — hostname/pid différents = un second service tourne.
    html += empreinteHtml(emissions.length + ' diffusion(s)');
    console.log(`[KICKOFF] semaine du ${semaine} — ${emissions.length} diffusion(s) — envoi (instance ${os.hostname()} pid ${process.pid})`);
    sendMail(`Kick-off semaine du ${fmt(today)}`, html);
  }

  // ── NOTIF INDIVIDUELLE "À PROGRAMMER" — tous les lundis 14h, Eva et Flavie séparément ──
  // Deux colonnes : à gauche ce qui lui est assigné personnellement (resp_edit), à droite
  // ce qui n'est assigné à personne — pour que rien ne traîne oublié dans le panneau.
  function reportAProgrammerLundi({ force = false } = {}) {
    const dateCle = new Date().toISOString().slice(0, 10);
    if (!force && !claimReportOnce(`aprogrammer_${dateCle}`)) {
      console.log(`[A-PROGRAMMER] ${dateCle} déjà envoyé — doublon ignoré`);
      return;
    }
    const destinataires = [
      { nom: 'Eva', email: EMAIL_EVA },
      { nom: 'Flavie', email: EMAIL_FLAVIE }
    ];
    const nonAssignees = db.prepare(`
      SELECT * FROM emissions WHERE statut='a_programmer' AND (resp_edit IS NULL OR resp_edit='')
      ORDER BY entreprise ASC
    `).all();

    const renderColonne = (titre, couleur, rows) => `
      <td style="width:50%;vertical-align:top;padding:0 12px">
        <h3 style="color:${couleur};margin-bottom:8px">${titre} (${rows.length})</h3>
        ${rows.length ? '<ul style="padding-left:18px;margin:0">' + rows.map(e =>
          `<li style="margin-bottom:6px"><b>${e.entreprise}</b><br><span style="color:#666;font-size:12px">${e.media}${e.format ? ' · ' + e.format : ''}</span></li>`
        ).join('') + '</ul>' : '<p style="color:#888;font-size:13px">Aucune 🎉</p>'}
      </td>`;

    for (const { nom, email } of destinataires) {
      if (!email) { console.warn(`⚠️ Pas d'email configuré pour ${nom} (EMAIL_${nom.toUpperCase()}), notif "à programmer" non envoyée`); continue; }
      const assignees = db.prepare(`
        SELECT * FROM emissions WHERE statut='a_programmer' AND resp_edit=?
        ORDER BY entreprise ASC
      `).all(nom);

      const html = `
        <h2>📌 À programmer — ${nom}</h2>
        <p>Diffusions signées mais encore sans date ou média confirmé côté planning.</p>
        <table style="width:100%;border-collapse:collapse"><tr>
          ${renderColonne(`Assignées à ${nom}`, '#2563eb', assignees)}
          <td style="width:0;border-left:1px solid #eee"></td>
          ${renderColonne('Non assignées', '#d97706', nonAssignees)}
        </tr></table>
        ${empreinteHtml()}`;

      sendMailOnly(`📌 À programmer — ${assignees.length} pour toi, ${nonAssignees.length} non assignées`, html, [email]);
    }
  }

  // ── NOTIF "C-LEVEL" — tous les lundis 14h, une vue 3 colonnes Flavie / Eva / Lola ──
  function reportAProgrammerClevel({ force = false } = {}) {
    if (!EMAIL_CLEVEL) { console.warn(`⚠️ Pas d'email configuré pour EMAIL_CLEVEL, notif "à programmer" C-level non envoyée`); return; }
    const dateCle = new Date().toISOString().slice(0, 10);
    if (!force && !claimReportOnce(`clevel_${dateCle}`)) {
      console.log(`[C-LEVEL] ${dateCle} déjà envoyé — doublon ignoré`);
      return;
    }
    const noms = ['Flavie', 'Eva', 'Lola'];
    const parNom = {};
    for (const nom of noms) {
      parNom[nom] = db.prepare(`SELECT * FROM emissions WHERE statut='a_programmer' AND resp_edit=? ORDER BY entreprise ASC`).all(nom);
    }

    const renderColonne = (titre, couleur, rows) => `
      <td style="width:33%;vertical-align:top;padding:0 10px">
        <h3 style="color:${couleur};margin-bottom:8px">${titre} (${rows.length})</h3>
        ${rows.length ? '<ul style="padding-left:18px;margin:0">' + rows.map(e =>
          `<li style="margin-bottom:6px"><b>${e.entreprise}</b><br><span style="color:#666;font-size:12px">${e.media}${e.format ? ' · ' + e.format : ''}</span></li>`
        ).join('') + '</ul>' : '<p style="color:#888;font-size:13px">Aucune 🎉</p>'}
      </td>`;

    const couleurs = { Flavie: '#2563eb', Eva: '#7c3aed', Lola: '#059669' };
    const html = `
      <h2>📌 À programmer — vue C-level</h2>
      <p>Répartition des diffusions signées encore sans date ou média confirmé, par responsable édito.</p>
      <table style="width:100%;border-collapse:collapse"><tr>
        ${noms.map(nom => renderColonne(nom, couleurs[nom], parNom[nom])).join('<td style="width:0;border-left:1px solid #eee"></td>')}
      </tr></table>
      ${empreinteHtml()}`;

    const total = noms.reduce((s, n) => s + parNom[n].length, 0);
    sendMailOnly(`📌 À programmer — vue C-level (${total} au total)`, html, [EMAIL_CLEVEL]);
  }

  // ── RELANCES QUOTIDIENNES — recouvrement Pennylane, tous les matins ouvrés ──
  // Digest des factures encore dues, en retard, et pas déjà classées dans un
  // statut "réglé/en discussion" (litige, promesse de paiement, soldée) —
  // celles-là n'ont plus besoin d'une relance du jour. Envoyé aux comptes
  // rôle 'finance' + 'admin' actifs (mêmes destinataires que l'accès à
  // l'onglet Recouvrement). Choix d'horaire : lundi-vendredi 8h Paris — à
  // ajuster si "tous les matins" doit en fait couvrir aussi le week-end.
  function joursDeRetardRelance(deadline) {
    if (!deadline) return null;
    const d = new Date(`${deadline}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((today - d) / 86400000);
  }

  // Statuts Pennylane NATIFS hors recouvrement (mêmes valeurs que
  // PENNYLANE_HORS_RECOUVREMENT dans financeRoutes.js) : un brouillon, un
  // avoir, une annulation, ou une facture déjà "paid" (qui peut garder un
  // remaining_amount non nul par bug Pennylane, cf. financeRoutes.js) ne
  // doivent pas déclencher de relance. Dupliqué ici plutôt qu'importé car
  // reports.js et financeRoutes.js sont deux modules séparés sans export
  // commun pour cette constante — à garder synchronisée si la liste change.
  const REPORTS_PENNYLANE_HORS_RECOUVREMENT = ['draft', 'credit_note', 'cancelled', 'partially_cancelled', 'archived', 'incomplete', 'paid'];

  function reportRelancesQuotidien({ force = false, tentative = 0, seulementA = null, photoSeulement = false } = {}) {
    // 05/11/2026 (Lina) : mail recouvrement à 9 h, du mardi au vendredi (à partir du
    // 10/11/2026), pour Thomas, Lola, Fatima, Arianne et Lina. Épuré : à relancer,
    // en retard déjà relancées, à échoir dans les 15 jours depuis le lundi, et
    // évolution de « à recouvrer » par rapport à la semaine d'avant.
    const fmt = (d) => d.toISOString().slice(0, 10);
    const today = fmt(new Date());
    // On attend que Trello soit chargé, comme le dashboard. Nouvel essai toutes
    // les 5 min (6 fois) ; ensuite le mail part avec une mention.
    let rapportTrello = null;
    try {
      const trello = require('./trelloRecouvrement');
      if (trello._etat && trello._etat.board) rapportTrello = trello._construireRapport(db);
    } catch (e) { console.warn('[RELANCES] Trello :', e.message); }
    if (!rapportTrello && tentative < 6) {
      console.log('[RELANCES] Trello pas encore chargé — nouvel essai dans 5 min');
      setTimeout(() => reportRelancesQuotidien({ force, tentative: tentative + 1, seulementA, photoSeulement }), 5 * 60 * 1000).unref();
      return;
    }
    const sansTrello = !rapportTrello;
    if (!rapportTrello) rapportTrello = {};
    let facturesDashboard = [];
    try { facturesDashboard = require('./financeRoutes').listeFacturesDashboard() || []; } catch (e) { console.warn('[RELANCES] factures :', e.message); }
    if (!photoSeulement && !force && !claimReportOnce(`relances_${today}`)) {
      console.log(`[RELANCES] ${today} déjà envoyé — doublon ignoré`);
      return;
    }
    // Même calcul que le dashboard Recouvrement (05/11/2026) : mêmes décisions
    // Trello (Trello prime), mêmes exclusions (SCP, F5885, avant 2025, statuts
    // Pennylane hors recouvrement), statut choisi à la main prioritaire.
    const decisionsMail = new Map((rapportTrello.decisionsTrello || []).map((d) => [String(d.id), d]));
    const scpMail = new Set((rapportTrello.scp || []).map((x) => String(x.facture)));
    const relancesEquipe = new Map();
    const promessesEnCours = new Set(); const aujourdhuiTxt = today;
    for (const x of (rapportTrello.commentairesFatima || [])) {
      const r = (x.c || []).filter((c) => (c.relance || c.promesse) && c.date).map((c) => c.date).sort().pop(); if (r) relancesEquipe.set(String(x.id), r);
      if ((x.c || []).some((c) => c.promesse && c.dp && c.dp >= aujourdhuiTxt)) promessesEnCours.add(String(x.id));
    }
    const debutJour = new Date(); debutJour.setHours(0, 0, 0, 0);
    // Fenêtre « à échoir » : 15 jours à partir du lundi de la semaine en cours,
    // pour que la liste reste la même toute la semaine.
    const lundi = new Date(debutJour); lundi.setDate(lundi.getDate() - ((lundi.getDay() + 6) % 7));
    const finFenetre = new Date(lundi); finFenetre.setDate(finFenetre.getDate() + 14);
    const finFenetreTxt = `${finFenetre.getFullYear()}-${String(finFenetre.getMonth() + 1).padStart(2, '0')}-${String(finFenetre.getDate()).padStart(2, '0')}`;
    const dateFr = (iso) => { const s = String(iso || '').slice(0, 10); return s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : ''; };

    const aRelancer = []; const relancees = []; const aEchoir = []; const litiges = [];
    let totalAVenir = 0, nbAVenir = 0, totalReport = 0, nbReport = 0;
    for (const f of facturesDashboard) {
      const numero = String(f.invoiceNumber || '');
      if (numero === 'F5885' || scpMail.has(numero) || /groupe\s*scp/i.test(f.customerName || '')) continue;
      if ((f.dateEmission || '') < '2025-01-01') continue;
      if (f.status && REPORTS_PENNYLANE_HORS_RECOUVREMENT.includes(f.status)) continue;
      let statut = f.internalStatus || null;
      let reste = Number(f.remainingAmountTtc != null ? f.remainingAmountTtc : (f.remainingAmount || 0));
      const d = decisionsMail.get(String(f.id));
      if (d) {
        if (!f.statutManuelLe && (d.statut === 'solde' || d.statut === 'report_projet' || d.statut === 'litige')) statut = d.statut;
        if (d.resteReel != null) reste = Number(d.resteReel);
      }
      if (statut === 'solde' || !(reste > 0.5)) continue;
      const ligne = { id: f.id, invoice_number: numero, customer_name: f.customerName || '', contact_name: f.contactName || '', contact_email: f.contactEmail || '', contact_phone: f.contactPhone || '', remaining_amount: reste, daysLate: f.daysLate };
      if (statut === 'litige') { litiges.push(ligne); continue; }
      if (statut === 'report_projet') { totalReport += reste; nbReport++; continue; }
      if (statut && statut !== 'a_relancer' && statut !== 'en_cours' && statut !== 'promesse_paiement') continue;
      // Acompte échu non payé = retard, comme le dashboard. Pas quand Trello a
      // déjà recalculé les parts payées (le dashboard s'appuie alors sur Trello).
      let jours = f.daysLate || 0;
      const ech = (!(d && d.resteReel != null) && !(f.installments || []).length && f.echeancesPennylane && f.echeancesPennylane.acomptes) || [];
      let prochaine = null;
      for (const a of ech) { if (a.etat === 'soldee' || !a.date) continue; prochaine = String(a.date).slice(0, 10); const j = Math.floor((debutJour.getTime() - new Date(prochaine + 'T00:00:00').getTime()) / 86400000); if (j > jours) jours = j; break; }
      if (!(jours > 0)) {
        totalAVenir += reste; nbAVenir++;
        const echeance = prochaine || String(f.deadline || '').slice(0, 10);
        if (echeance && echeance <= finFenetreTxt) aEchoir.push({ ...ligne, echeance });
        continue;
      }
      ligne.daysLate = jours;
      // Relancée il y a moins de 7 jours (Trello ou relance saisie), ou promesse
      // en cours : « Relancé » ; sans paiement, elle revient après 7 jours.
      const derniere = [relancesEquipe.get(String(f.id)), f.lastRelanceAt].filter(Boolean).map(String).sort().pop();
      ligne.derniere = derniere || null; ligne.promesse = promessesEnCours.has(String(f.id)) || statut === 'promesse_paiement';
      if (promessesEnCours.has(String(f.id)) || (derniere && Date.now() - new Date(derniere).getTime() < 7 * 86400000)) { relancees.push(ligne); continue; }
      aRelancer.push(ligne);
    }
    aRelancer.sort((a, b) => b.daysLate - a.daysLate);
    relancees.sort((a, b) => b.remaining_amount - a.remaining_amount);
    aEchoir.sort((a, b) => (a.echeance < b.echeance ? -1 : a.echeance > b.echeance ? 1 : b.remaining_amount - a.remaining_amount));
    const somme = (l) => l.reduce((s, r) => s + (r.remaining_amount || 0), 0);
    const totalRelancer = somme(aRelancer), totalRelancees = somme(relancees);
    const nbRetard = aRelancer.length + relancees.length, totalRetard = totalRelancer + totalRelancees;
    const nbRecouvrer = nbRetard + nbAVenir + nbReport, totalRecouvrer = totalRetard + totalAVenir + totalReport;

    // Photo du jour (comparaison avec la semaine d'avant).
    try {
      db.prepare('CREATE TABLE IF NOT EXISTS recouvrement_photos (jour TEXT PRIMARY KEY, a_recouvrer REAL, nb INTEGER, en_retard REAL, nb_retard INTEGER, a_relancer REAL, nb_relancer INTEGER)').run();
      if (!sansTrello) db.prepare('INSERT OR REPLACE INTO recouvrement_photos (jour,a_recouvrer,nb,en_retard,nb_retard,a_relancer,nb_relancer) VALUES (?,?,?,?,?,?,?)').run(today, totalRecouvrer, nbRecouvrer, totalRetard, nbRetard, totalRelancer, aRelancer.length);
    } catch (e) { console.warn('[RELANCES] photo :', e.message); }
    if (photoSeulement) { console.log(`[RELANCES] photo ${today} : à recouvrer ${Math.round(totalRecouvrer)} €`); return; }

    let avant = null;
    try {
      const il7 = new Date(debutJour); il7.setDate(il7.getDate() - 7);
      const j7 = `${il7.getFullYear()}-${String(il7.getMonth() + 1).padStart(2, '0')}-${String(il7.getDate()).padStart(2, '0')}`;
      const il10 = new Date(il7); il10.setDate(il10.getDate() - 3);
      const j10 = `${il10.getFullYear()}-${String(il10.getMonth() + 1).padStart(2, '0')}-${String(il10.getDate()).padStart(2, '0')}`;
      avant = db.prepare('SELECT * FROM recouvrement_photos WHERE jour <= ? AND jour >= ? ORDER BY jour DESC LIMIT 1').get(j7, j10) || null;
    } catch (e) { avant = null; }
    const evol = (maintenant, alors) => {
      const diff = maintenant - alors; const pct = alors ? (diff / alors) * 100 : 0;
      const couleur = diff > 0.5 ? '#b91c1c' : (diff < -0.5 ? '#15803d' : '#555');
      const signe = diff > 0.5 ? '▲ +' : (diff < -0.5 ? '▼ −' : '= ');
      return `<span style="color:${couleur}">${signe}${fmtMoney(Math.abs(diff))} (${diff >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1).replace('.', ',')} %)</span>`;
    };

    const td = 'padding:6px 8px;border-bottom:1px solid #eee';
    const th = 'padding:7px 8px;text-align:left;background:#f3f4f6;color:#374151;font-weight:600';
    const tableau = (entetes, lignes) => `<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;margin-bottom:6px"><tr>${entetes.map(([t, droite]) => `<th style="${th}${droite ? ';text-align:right' : ''}">${t}</th>`).join('')}</tr>${lignes.join('')}</table>`;
    const contactDe = (r) => { const c = r.contact_name || ''; const det = [r.contact_email, r.contact_phone].filter(Boolean).join(' · '); return `${c}${det ? `${c ? '<br>' : ''}<span style="color:#888;font-size:11px">${det}</span>` : ''}`; };

    let html = `<div style="font-family:Arial,sans-serif;color:#111;max-width:760px">`;
    html += `<h2 style="margin:0 0 12px">💶 Recouvrement du ${dateFr(today)}</h2>`;
    html += `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;margin-bottom:18px">`;
    html += `<tr><td style="padding:3px 16px 3px 0">À recouvrer</td><td style="padding:3px 16px 3px 0;text-align:right"><strong>${fmtMoney(totalRecouvrer)}</strong></td><td style="padding:3px 0;color:#555">${nbRecouvrer} factures${avant ? ' · ' + evol(totalRecouvrer, avant.a_recouvrer) + ` vs ${dateFr(avant.jour)}` : ''}</td></tr>`;
    html += `<tr><td style="padding:3px 16px 3px 0">En retard</td><td style="padding:3px 16px 3px 0;text-align:right"><strong>${fmtMoney(totalRetard)}</strong></td><td style="padding:3px 0;color:#555">${nbRetard} factures${avant ? ' · ' + evol(totalRetard, avant.en_retard) + ` vs ${dateFr(avant.jour)}` : ''}</td></tr>`;
    html += `<tr><td style="padding:3px 16px 3px 0">À relancer aujourd’hui</td><td style="padding:3px 16px 3px 0;text-align:right"><strong>${fmtMoney(totalRelancer)}</strong></td><td style="padding:3px 0;color:#555">${aRelancer.length} factures</td></tr>`;
    html += `</table>`;
    if (!avant) html += `<p style="color:#888;font-size:12px;margin:-10px 0 16px">Comparaison avec la semaine d’avant : disponible dès qu’une photo d’il y a 7 jours existe (photos enregistrées depuis le 05/11/2026).</p>`;

    html += `<h3 style="margin:18px 0 6px">1. À relancer aujourd’hui — ${aRelancer.length} (${fmtMoney(totalRelancer)})</h3>`;
    html += aRelancer.length ? tableau([['Facture'], ['Client'], ['Contact'], ['Retard', 1], ['Dû', 1]], aRelancer.map((r) => `<tr><td style="${td}">${r.invoice_number}</td><td style="${td}">${r.customer_name}</td><td style="${td}">${contactDe(r)}</td><td style="${td};text-align:right">${r.daysLate} j</td><td style="${td};text-align:right">${fmtMoney(r.remaining_amount)}</td></tr>`)) : '<p style="color:#555">Rien à relancer aujourd’hui.</p>';

    html += `<h3 style="margin:18px 0 6px">2. En retard, déjà relancées ou promesse — ${relancees.length} (${fmtMoney(totalRelancees)})</h3>`;
    html += relancees.length ? tableau([['Facture'], ['Client'], ['Retard', 1], ['Dû', 1], ['Suivi']], relancees.map((r) => `<tr><td style="${td}">${r.invoice_number}</td><td style="${td}">${r.customer_name}</td><td style="${td};text-align:right">${r.daysLate} j</td><td style="${td};text-align:right">${fmtMoney(r.remaining_amount)}</td><td style="${td};color:#555">${r.promesse ? 'Promesse' : 'Relancée'}${r.derniere ? ' le ' + dateFr(r.derniere) : ''}</td></tr>`)) : '<p style="color:#555">Aucune.</p>';

    html += `<h3 style="margin:18px 0 6px">3. À échoir d’ici le ${dateFr(finFenetreTxt)} — ${aEchoir.length} (${fmtMoney(somme(aEchoir))})</h3>`;
    html += aEchoir.length ? tableau([['Facture'], ['Client'], ['Échéance'], ['Dû', 1]], aEchoir.map((r) => `<tr><td style="${td}">${r.invoice_number}</td><td style="${td}">${r.customer_name}</td><td style="${td}">${dateFr(r.echeance)}</td><td style="${td};text-align:right">${fmtMoney(r.remaining_amount)}</td></tr>`)) : '<p style="color:#555">Aucune échéance d’ici là.</p>';

    if (litiges.length) html += `<p style="color:#555;font-size:12px;margin-top:16px">Hors relance : ${litiges.length} litige(s) (${fmtMoney(somme(litiges))}) et ${nbReport} report(s) projet (${fmtMoney(totalReport)}), suivis à part dans le dashboard.</p>`;
    if (sansTrello) html += '<p style="color:#b45309;font-size:13px">⚠️ Trello n’était pas chargé à l’envoi : les statuts venus de Trello ne sont pas appliqués dans ce mail.</p>';

    const dest = destinatairesRecouvrement();
    if (seulementA) html += `<p style="color:#888;font-size:11px;margin-top:16px">[TEST] Destinataires prévus à partir du mardi 10/11 : ${dest.length ? dest.join(', ') : 'aucun trouvé'}.</p>`;
    html += empreinteHtml(aRelancer.length + ' à relancer · ' + relancees.length + ' relancées · ' + aEchoir.length + ' à échoir') + '</div>';
    if (!seulementA && !aRelancer.length && !relancees.length && !aEchoir.length) { console.log('[RELANCES] rien à signaler aujourd’hui — pas d’envoi'); return; }
    sendMailOnly(`${seulementA ? '[TEST] ' : ''}💶 Recouvrement — ${aRelancer.length} à relancer · ${nbRetard} en retard (${fmtMoney(totalRetard)})`, html, seulementA ? [seulementA] : dest);
  }

  // Destinataires du mail recouvrement (05/11/2026, Lina) : Thomas, Lola, Fatima,
  // Arianne, Lina. Surchargeable par REPORT_EMAIL_RECOUVREMENT (liste séparée par des virgules).
  function destinatairesRecouvrement() {
    const env = (process.env.REPORT_EMAIL_RECOUVREMENT || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (env.length) return env;
    const prenoms = ['thomas', 'lola', 'fatima', 'arianne', 'ariane', 'lina'];
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    try {
      return db.prepare('SELECT email, nom FROM commercial_users WHERE actif=1').all().filter((r) => {
        const p = norm(r.nom).split(/[\s.\-_]+/)[0];
        const e = norm(r.email).split(/[@.\-_]/)[0];
        return prenoms.includes(p) || prenoms.includes(e);
      }).map((r) => r.email).filter(Boolean);
    } catch (e) { console.warn('[RELANCES] destinataires :', e.message); return []; }
  }

  // ── Helpers dates ──
  function isLastWeekdayOfMonth(date, weekday) {
    if (date.getDay() !== weekday) return false;
    const next = new Date(date); next.setDate(date.getDate() + 7);
    return next.getMonth() !== date.getMonth();
  }

  // ── Scheduling (Europe/Paris) ──
  // Tous les jours à 11h : vérifie si c'est le dernier vendredi (mensuel) ou dernier mercredi (aperçu mois suivant)
  cron.schedule('0 11 * * *', () => {
    const now = new Date();
    if (now.getDay() === 5 && isLastWeekdayOfMonth(now, 5)) reportMensuel();
    if (now.getDay() === 3 && isLastWeekdayOfMonth(now, 3)) reportApercuMoisSuivant();
  }, { timezone: 'Europe/Paris' });

  // Tous les vendredis à 11h : rapport hebdomadaire
  cron.schedule('0 11 * * 5', () => reportHebdo(), { timezone: 'Europe/Paris' });

  // Tous les lundis à 9h : kick-off de la semaine
  cron.schedule('0 9 * * 1', () => reportKickoffLundi(), { timezone: 'Europe/Paris' });

  // Tous les lundis à 14h : notif individuelle "à programmer" (Eva, Flavie) + vue C-level
  cron.schedule('0 14 * * 1', () => { reportAProgrammerLundi(); reportAProgrammerClevel(); }, { timezone: 'Europe/Paris' });

  // Recouvrement (05/11/2026, Lina) : mail à 9 h du mardi au vendredi, à partir du 10/11/2026.
  // Photo de « à recouvrer » tous les jours à 9 h (lundi et week-end compris) pour la comparaison avec la semaine d'avant.
  cron.schedule('0 9 * * *', () => {
    const jour = new Date().getDay();
    const debut = new Date().toISOString().slice(0, 10) >= '2026-11-10';
    if (debut && jour >= 2 && jour <= 5) reportRelancesQuotidien();
    else reportRelancesQuotidien({ photoSeulement: true });
  }, { timezone: 'Europe/Paris' });
  // Test unique demandé par Lina le 05/11/2026 : envoyé à elle seule, une seule fois.
  setTimeout(() => { try { if (claimReportOnce('test_recouvrement_9h_20261105')) reportRelancesQuotidien({ force: true, seulementA: 'lina.e@openmedias.fr' }); } catch (e) { console.warn('[RELANCES] test :', e.message); } }, 60 * 1000).unref();


  console.log('📧 Reporting automatique configuré (mensuel, hebdo, aperçu N+1, kick-off lundi, à programmer lundi 14h, C-level lundi 14h, recouvrement mar-ven 9h)');

  return { reportMensuel, reportHebdo, reportApercuMoisSuivant, reportKickoffLundi, reportAProgrammerLundi, reportAProgrammerClevel, reportRelancesQuotidien, sendMail, sendMailOnly };
}

module.exports = { setupReports };
