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

  function reportRelancesQuotidien({ force = false } = {}) {
    const fmt = (d) => d.toISOString().slice(0, 10);
    const today = fmt(new Date());
    if (!force && !claimReportOnce(`relances_${today}`)) {
      console.log(`[RELANCES] ${today} déjà envoyé — doublon ignoré`);
      return;
    }
    const rows = db.prepare(`
      SELECT i.*, c.name AS customer_name, c.contact_name AS contact_name,
             c.contact_email AS contact_email, c.contact_phone AS contact_phone
      FROM pennylane_invoices i
      LEFT JOIN pennylane_customers c ON c.id = i.customer_id
      WHERE i.remaining_amount > 0
        AND i.internal_status NOT IN ('litige', 'promesse_paiement', 'solde')
    `).all();
    const enRetard = rows
      .map((r) => ({ ...r, daysLate: joursDeRetardRelance(r.deadline) }))
      .filter((r) => (r.daysLate || 0) > 0)
      .sort((a, b) => b.daysLate - a.daysLate);

    const dest = db.prepare(
      "SELECT email FROM commercial_users WHERE role IN ('finance','admin') AND actif=1"
    ).all().map((r) => r.email).filter(Boolean).filter((email) => email !== 'paul@openmedias.fr');

    if (!enRetard.length) {
      console.log('[RELANCES] aucune facture en retard à relancer aujourd\'hui — pas d\'envoi');
      return;
    }

    const totalDu = enRetard.reduce((s, r) => s + (r.remaining_amount || 0), 0);
    let html = `<h2>💶 Relances du jour — ${enRetard.length} facture(s) en retard</h2>
      <p>${enRetard.length} facture(s) encore dues et en retard, pour un total de ${fmtMoney(totalDu)}. Statuts déjà classés "litige", "promesse de paiement" ou "soldée" sont exclus de cette liste.</p>
      <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px">
        <tr style="background:#1a1a2e;color:#fff">
          <th style="padding:8px;text-align:left">Facture</th>
          <th style="padding:8px;text-align:left">Client</th>
          <th style="padding:8px;text-align:left">Contact</th>
          <th style="padding:8px;text-align:right">Retard</th>
          <th style="padding:8px;text-align:right">Montant dû</th>
        </tr>`;
    for (const r of enRetard) {
      const contact = r.contact_name || r.customer_name || '';
      const contactDetail = [r.contact_email, r.contact_phone].filter(Boolean).join(' · ');
      html += `<tr style="border-bottom:1px solid #eee">
        <td style="padding:6px 8px">${r.invoice_number || r.id}</td>
        <td style="padding:6px 8px">${r.customer_name || ''}</td>
        <td style="padding:6px 8px">${contact}${contactDetail ? `<br><span style="color:#888;font-size:11px">${contactDetail}</span>` : ''}</td>
        <td style="padding:6px 8px;text-align:right">${r.daysLate} j</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(r.remaining_amount)}</td>
      </tr>`;
    }
    html += `</table>${empreinteHtml(enRetard.length + ' facture(s)')}`;
    sendMailOnly(`💶 Relances du jour — ${enRetard.length} facture(s) en retard (${fmtMoney(totalDu)})`, html, dest);
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

  // Du lundi au vendredi à 8h : digest des relances de recouvrement du jour
  cron.schedule('0 8 * * 1-5', () => reportRelancesQuotidien(), { timezone: 'Europe/Paris' });

  console.log('📧 Reporting automatique configuré (mensuel, hebdo, aperçu N+1, kick-off lundi, à programmer lundi 14h, C-level lundi 14h, relances lun-ven 8h)');

  return { reportMensuel, reportHebdo, reportApercuMoisSuivant, reportKickoffLundi, reportAProgrammerLundi, reportAProgrammerClevel, reportRelancesQuotidien, sendMail, sendMailOnly };
}

module.exports = { setupReports };
