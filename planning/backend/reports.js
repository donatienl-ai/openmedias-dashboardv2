const cron = require('node-cron');

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

  async function sendMailRaw(subject, html, recipients) {
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
    const body = {
      Messages: [{
        From: { Email: REPORT_FROM_EMAIL, Name: 'Planning Diffusion OpenMedias' },
        To: dest.map(email => ({ Email: email })),
        Subject: subject,
        HTMLPart: html
      }]
    };
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
  async function sendMailOnly(subject, html, recipients) {
    return sendMailRaw(subject, html, recipients);
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
  function reportMensuel() {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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
      ${buildTable(rows)}`;
    sendMail(`Reporting mensuel — ${moisNom}`, html);
  }

  // ── RAPPORT HEBDO — tous les vendredis 11h, semaine écoulée (lundi→vendredi) ──
  function reportHebdo() {
    const today = new Date();
    const dow = today.getDay() || 7;
    const lundi = new Date(today); lundi.setDate(today.getDate() - (dow - 1));
    const fmt = d => d.toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT media, COUNT(*) as nb_emissions, SUM(montant) as ca_diffusion, SUM(IFNULL(upsell,0)) as ca_upsell
      FROM emissions
      WHERE statut NOT IN ('annule','bdc_attente','a_programmer')
        AND date_diffusion >= ? AND date_diffusion <= ?
      GROUP BY media ORDER BY (SUM(montant) + SUM(IFNULL(upsell,0))) DESC
    `).all(fmt(lundi), fmt(today));
    const html = `<h2>📅 Reporting hebdomadaire — semaine du ${fmt(lundi)} au ${fmt(today)}</h2>
      <p>Diffusions réalisées et CA généré cette semaine, par média.</p>
      ${buildTable(rows)}`;
    sendMail(`Reporting hebdomadaire — semaine du ${fmt(lundi)}`, html);
  }

  // ── APERÇU MOIS SUIVANT — dernier mercredi du mois, 11h ──
  function reportApercuMoisSuivant() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const period = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;
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
    html += `<tr style="font-weight:bold;background:#f5f5f5"><td style="padding:8px">TOTAL</td><td style="padding:8px;text-align:right">${total}</td></tr></table>`;
    sendMail(`Aperçu du mois à venir — ${moisNom}`, html);
  }

  // ── KICK-OFF LUNDI — diffusions à venir cette semaine (lundi→vendredi) ──
  function reportKickoffLundi() {
    const today = new Date();
    const vendredi = new Date(today); vendredi.setDate(today.getDate() + 4);
    const fmt = d => d.toISOString().slice(0, 10);
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
    sendMail(`Kick-off semaine du ${fmt(today)}`, html);
  }

  // ── NOTIF INDIVIDUELLE "À PROGRAMMER" — tous les lundis 14h, Eva et Flavie séparément ──
  // Deux colonnes : à gauche ce qui lui est assigné personnellement (resp_edit), à droite
  // ce qui n'est assigné à personne — pour que rien ne traîne oublié dans le panneau.
  function reportAProgrammerLundi() {
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
        </tr></table>`;

      sendMailOnly(`📌 À programmer — ${assignees.length} pour toi, ${nonAssignees.length} non assignées`, html, [email]);
    }
  }

  // ── NOTIF "C-LEVEL" — tous les lundis 14h, une vue 3 colonnes Flavie / Eva / Lola ──
  function reportAProgrammerClevel() {
    if (!EMAIL_CLEVEL) { console.warn(`⚠️ Pas d'email configuré pour EMAIL_CLEVEL, notif "à programmer" C-level non envoyée`); return; }
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
      </tr></table>`;

    const total = noms.reduce((s, n) => s + parNom[n].length, 0);
    sendMailOnly(`📌 À programmer — vue C-level (${total} au total)`, html, [EMAIL_CLEVEL]);
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

  console.log('📧 Reporting automatique configuré (mensuel, hebdo, aperçu N+1, kick-off lundi, à programmer lundi 14h, C-level lundi 14h)');

  return { reportMensuel, reportHebdo, reportApercuMoisSuivant, reportKickoffLundi, reportAProgrammerLundi, reportAProgrammerClevel, sendMail, sendMailOnly };
}

module.exports = { setupReports };
