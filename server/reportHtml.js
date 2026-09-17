// ==========================================
//  GÉNÉRATEUR DU REPORTING EMAIL (design navy)
//  Tables + styles inline uniquement (email-safe).
// ==========================================

// Palette navy du dashboard (mode clair pour le corps, hero sombre)
const C = {
  bg: '#F1F4F9',
  navy: '#050A14',
  panel: '#0B1322',
  panelBorder: '#1B2A45',
  white: '#FFFFFF',
  cardBorder: '#DEE6F0',
  text: '#101A2E',
  soft: '#50628A',
  muted: '#8C9CB8',
  softDark: '#8295B5',
  mutedDark: '#54678A',
  blue: '#2563EB',
  blueLight: '#3B82F6',
  green: '#16A34A',
  cyan: '#0891B2',
  orange: '#F97316',
  amber: '#D97706',
};

// Masqués par défaut dans le reporting (aligné sur le défaut du dashboard)
const HIDDEN = new Set(); // Vue globale : aucun masquage historique implicite.

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmt = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));

// Filtre les masqués + recalcule le total (count) / totalAmount
function filt(block, isAmount = false) {
  const detail = (block?.detail || []).filter((r) => !HIDDEN.has(r.name));
  const total = detail.reduce((s, r) => s + (r.count || 0), 0);
  const totalAmount = detail.reduce((s, r) => s + (r.amount || 0), 0);
  return { detail, total, totalAmount, truncated: block?.truncated };
}

const active = (rows, isAmount = false) =>
  (rows || []).filter((r) => (isAmount ? r.amount : r.count) > 0);

// ---------- briques visuelles ----------

function kpiChipP(P, label, value, sub, accent) {
  return `<td width="20%" style="padding:3px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background-color:${P.chipBg};border:1px solid ${P.chipBorder};border-radius:10px;padding:10px 6px;text-align:center;">
        <div style="font-size:8px;letter-spacing:1.5px;font-weight:700;color:${accent};text-transform:uppercase;font-family:${FONT};">${label}</div>
        <div style="font-size:22px;font-weight:800;color:${P.chipVal};font-family:${FONT};padding:2px 0;">${value}</div>
        <div style="font-size:8px;letter-spacing:0.5px;color:${P.chipSub};text-transform:uppercase;font-family:${FONT};">${sub}</div>
      </td>
    </tr></table>
  </td>`;
}

function sectionLabel(emoji, text, color, bg) {
  return `<p style="margin:0 0 12px;"><span style="display:inline-block;background-color:${bg};border-radius:6px;padding:4px 10px;font-size:10px;letter-spacing:2px;font-weight:700;color:${color};text-transform:uppercase;font-family:${FONT};">${emoji} ${text}</span></p>`;
}

function tableHead(left, right) {
  return `<tr style="border-bottom:1px solid #EDF1F7;">
    <td style="padding:6px 0;font-size:9px;font-weight:700;color:${C.muted};letter-spacing:1px;text-transform:uppercase;font-family:${FONT};">${left}</td>
    <td style="padding:6px 0;font-size:9px;font-weight:700;color:${C.muted};letter-spacing:1px;text-transform:uppercase;text-align:right;font-family:${FONT};">${right}</td>
  </tr>`;
}

function dataRow(name, value, color) {
  return `<tr style="border-bottom:1px solid #F4F7FB;">
    <td style="padding:7px 0;font-size:13px;color:${C.text};font-family:${FONT};">${esc(name)}</td>
    <td style="padding:7px 0;font-size:13px;font-weight:800;color:${color};text-align:right;font-family:${FONT};">${value}</td>
  </tr>`;
}

function totalRow(label, value, color) {
  return `<tr>
    <td style="padding:10px 0 2px;font-size:10px;font-weight:800;color:${C.text};letter-spacing:1px;text-transform:uppercase;border-top:2px solid ${C.text};font-family:${FONT};">${label}</td>
    <td style="padding:10px 0 2px;font-size:15px;font-weight:800;color:${color};text-align:right;border-top:2px solid ${C.text};font-family:${FONT};">${value}</td>
  </tr>`;
}

function emptyBox(text) {
  return `<div style="padding:16px 20px;text-align:center;font-size:12px;color:${C.muted};font-style:italic;background-color:${C.bg};border-radius:10px;border:1px dashed ${C.cardBorder};font-family:${FONT};">${text}</div>`;
}

function card(inner) {
  return `<tr><td style="padding:0 0 14px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background-color:${C.white};border:1px solid ${C.cardBorder};border-radius:14px;padding:20px 24px;">${inner}</td>
    </tr></table>
  </td></tr>`;
}

function listSection({ emoji, title, color, bg, rows, valueFn, totalLabel, totalValue, emptyText, head = ['Commercial', 'Total'] }) {
  let inner = sectionLabel(emoji, title, color, bg);
  if (rows.length === 0) {
    inner += emptyBox(emptyText);
  } else {
    inner += `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">`;
    inner += tableHead(head[0], head[1]);
    inner += rows.map((r) => dataRow(r.name, valueFn(r), color)).join('');
    if (totalLabel) inner += totalRow(totalLabel, totalValue, color);
    inner += `</table>`;
  }
  return card(inner);
}

// Deux listes côte à côte (50/50)
function twoColSection(leftHtml, rightHtml) {
  return `<tr><td style="padding:0 0 14px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="49%" valign="top" style="background-color:${C.white};border:1px solid ${C.cardBorder};border-radius:14px;padding:18px 20px;">${leftHtml}</td>
      <td width="2%"></td>
      <td width="49%" valign="top" style="background-color:${C.white};border:1px solid ${C.cardBorder};border-radius:14px;padding:18px 20px;">${rightHtml}</td>
    </tr></table>
  </td></tr>`;
}

function miniList({ emoji, title, color, bg, rows, valueFn, emptyText }) {
  let html = sectionLabel(emoji, title, color, bg);
  if (rows.length === 0) return html + emptyBox(emptyText);
  html += `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">`;
  html += rows.map((r) => dataRow(r.name, valueFn(r), color)).join('');
  html += `</table>`;
  return html;
}

// ---------- le template ----------

// ---- ANOMALIES / TEMPS FORTS (vs période de comparaison équivalente) ----
// `compare` est optionnel (déjà calculé côté index.js via collectCompareData,
// désactivé sur les très longues périodes >70j pour préserver les quotas API) —
// pas de section si absent. Seuils volontairement larges (±30/50%) et une
// base minimale (`min`) par métrique pour ne pas alerter sur du bruit
// statistique (ex: 1 call devenu 2 calls = +100% mais ça ne veut rien dire).
function pctDelta(cur, prev) {
  return prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
}
function buildAnomalies(data, compare) {
  if (!compare || data.errors || compare.errors) return ''; // Pas de variations calculées sur une source indisponible.
  const rdvPrisCur = (data.rdvBooked?.r1?.total || 0) + (data.rdvBooked?.r2?.total || 0);
  const rdvPrisPrev = (compare.rdvBooked?.r1?.total || 0) + (compare.rdvBooked?.r2?.total || 0);
  const propalsCur = (data.propals?.total || 0) + (data.propalsComptes?.total || 0);
  const propalsPrev = (compare.propals?.total || 0) + (compare.propalsComptes?.total || 0);

  const metrics = [
    { label: 'Calls', cur: data.calls?.total || 0, prev: compare.calls?.total || 0, min: 5 },
    { label: 'RDV pris', cur: rdvPrisCur, prev: rdvPrisPrev, min: 3 },
    { label: 'Propositions suivies', cur: propalsCur, prev: propalsPrev, min: 3 },
    { label: 'Ventes gagnées', cur: data.signatures?.total || 0, prev: compare.signatures?.total || 0, min: 1 },
    { label: 'CA', cur: data.revenue?.totalAmount || 0, prev: compare.revenue?.totalAmount || 0, min: 500, isAmount: true },
  ];

  const lines = [];
  for (const m of metrics) {
    if (m.prev < m.min) continue; // base trop faible pour un % fiable
    const delta = pctDelta(m.cur, m.prev);
    if (delta === null) continue;
    const curTxt = m.isAmount ? `${fmt(m.cur)} €` : fmt(m.cur);
    const prevTxt = m.isAmount ? `${fmt(m.prev)} €` : fmt(m.prev);
    if (delta <= -30) {
      lines.push({ emoji: '⚠️', text: `${m.label} en baisse de ${Math.abs(delta)}% (${curTxt} vs ${prevTxt} sur la période comparable précédente)` });
    } else if (delta >= 50) {
      lines.push({ emoji: '🔥', text: `${m.label} en hausse de ${delta}% (${curTxt} vs ${prevTxt} sur la période comparable précédente)` });
    }
  }
  if (lines.length === 0) return '';

  let inner = sectionLabel('🔎', 'Points notables', C.blue, '#EFF6FF');
  inner += `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">`;
  inner += lines.map((l) => `<tr>
    <td style="padding:8px 0;font-size:13px;color:${C.text};font-family:${FONT};border-bottom:1px solid #F4F7FB;">
      <span style="margin-right:6px;">${l.emoji}</span>${esc(l.text)}
    </td>
  </tr>`).join('');
  inner += `</table>`;
  return card(inner);
}

export function buildReportHtml({ data, monthRevenue, monthLabel, theme = 'light', preset = 'today', range = null, compare = null }) {
  const unavailable = (...keys) => keys.some(key => data.errors?.[key]);
  const dark = theme === 'dark';
  const isToday = preset === 'today';
  // Texte de période pour les libellés ("du jour" / "hier" / label de plage)
  const periodTxt = isToday ? 'du jour' : (range?.label || 'période').toLowerCase();
  // Palette du hero/des cartes sombres selon le thème
  const P = dark
    ? {
        heroBg: C.navy, heroBorder: 'none',
        eyebrow: C.blueLight, title: C.white, dateTxt: C.softDark, zoneLbl: C.mutedDark,
        chipBg: C.panel, chipBorder: C.panelBorder, chipVal: C.white, chipSub: C.mutedDark,
        accGreen: '#22C55E', accCyan: '#22D3EE', accAmber: '#FBBF24', accBlue: C.blueLight, accOrange: C.orange,
        sigBg: C.navy, sigTxt: C.white, sigAmount: '#4ADE80', sigBorder: C.panelBorder,
        footBg: C.navy, footTitle: C.white, footSub: C.mutedDark,
      }
    : {
        heroBg: C.white, heroBorder: `1px solid ${C.cardBorder}`,
        eyebrow: C.blue, title: C.text, dateTxt: C.soft, zoneLbl: C.muted,
        chipBg: '#F6F9FD', chipBorder: C.cardBorder, chipVal: C.text, chipSub: C.muted,
        accGreen: C.green, accCyan: C.cyan, accAmber: C.amber, accBlue: C.blue, accOrange: C.orange,
        sigBg: '#EFF6FF', sigTxt: C.text, sigAmount: C.green, sigBorder: '#DBEAFE',
        footBg: C.white, footTitle: C.text, footSub: C.muted,
      };

  // Date affichée : si la plage couvre un seul jour, on affiche CE jour ;
  // sinon le label de la plage (ex: "25/05/2026 → 04/06/2026").
  let dateLabel;
  if (range?.start && range?.end) {
    const endIncl = new Date(new Date(range.end).getTime() - 1);
    const sameDay = new Date(range.start).toDateString() === endIncl.toDateString();
    dateLabel = sameDay
      ? new Date(range.start).toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
      : range.label;
  } else {
    dateLabel = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  }

  const calls = filt(data.calls);
  const callsIn = calls.detail.reduce((s, r) => s + (r.inbound || 0), 0);
  const callsOut = calls.detail.reduce((s, r) => s + (r.outbound || 0), 0);
  const r1 = filt(data.rdvToday?.r1);
  const r2 = filt(data.rdvToday?.r2);
  const r1p = filt(data.rdvBooked?.r1);
  const r2p = filt(data.rdvBooked?.r2);
  const propals = filt(data.propals);
  const propalsComptes = filt(data.propalsComptes);
  const propalsTotal = propals.total + propalsComptes.total;
  const sig = filt(data.signatures, true);
  const sf = filt(data.salesforge);
  const bdcSent = filt(data.bdc?.sent);
  const bdcSigned = filt(data.bdc?.signed);
  const bdcPending = filt(data.bdc?.pending);
  const caMonth = filt(monthRevenue, true);

  // ---- HERO (thémé clair/sombre) ----
  const hero = `<tr><td style="padding:0 0 14px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background-color:${P.heroBg};border:${P.heroBorder};border-radius:16px;padding:26px 26px 20px;">
        <div style="font-size:9px;letter-spacing:3px;font-weight:700;color:${P.eyebrow};text-transform:uppercase;font-family:${FONT};">OpenMedias · Daily Sales Report</div>
        <div style="font-size:26px;font-weight:800;color:${P.title};font-family:${FONT};padding:4px 0 2px;">Performance Commerciale</div>
        <div style="font-size:12px;color:${P.dateTxt};font-family:${FONT};text-transform:capitalize;">${dateLabel}</div>

        <div style="font-size:9px;letter-spacing:2px;font-weight:700;color:${P.zoneLbl};text-transform:uppercase;font-family:${FONT};padding:18px 0 6px;">Activité ${periodTxt}</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          ${kpiChipP(P, 'Calls', unavailable('calls') ? '—' : calls.truncated ? `${fmt(calls.total)}+` : calls.total, `${callsOut} out · ${callsIn} in`, P.accBlue)}
          ${kpiChipP(P, 'R1', unavailable('rdvToday') ? '—' : r1.total, 'programmés', P.accGreen)}
          ${kpiChipP(P, 'R2', unavailable('rdvToday') ? '—' : r2.total, 'programmés', P.accCyan)}
          ${kpiChipP(P, 'R1 pris', unavailable('rdvBooked') ? '—' : r1p.total, 'bookés', P.accAmber)}
          ${kpiChipP(P, 'R2 pris', unavailable('rdvBooked') ? '—' : r2p.total, 'bookés', P.accAmber)}
        </tr></table>

        <div style="font-size:9px;letter-spacing:2px;font-weight:700;color:${P.zoneLbl};text-transform:uppercase;font-family:${FONT};padding:14px 0 6px;">Résultats ${periodTxt}</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="50%" style="padding:3px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="background-color:${P.chipBg};border:1px solid ${P.chipBorder};border-radius:10px;padding:14px 12px;text-align:center;">
                <div style="font-size:9px;letter-spacing:2px;font-weight:700;color:${P.accOrange};text-transform:uppercase;font-family:${FONT};">Propositions suivies</div>
                <div style="font-size:26px;font-weight:800;color:${P.chipVal};font-family:${FONT};padding:2px 0;">${unavailable('propals','propalsComptes') ? '—' : propalsTotal}</div>
                <div style="font-size:9px;color:${P.chipSub};font-family:${FONT};">${propals.total} pistes · ${propalsComptes.total} comptes</div>
              </td>
            </tr></table>
          </td>
          <td width="50%" style="padding:3px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="background-color:${P.chipBg};border:1px solid ${C.blue};border-radius:10px;padding:14px 12px;text-align:center;">
                <div style="font-size:9px;letter-spacing:2px;font-weight:700;color:${P.accBlue};text-transform:uppercase;font-family:${FONT};">Ventes gagnées</div>
                <div style="font-size:26px;font-weight:800;color:${P.chipVal};font-family:${FONT};padding:2px 0;">${unavailable('signatures') ? '—' : sig.total}</div>
                <div style="font-size:9px;color:${P.chipSub};font-family:${FONT};">${isToday ? 'du jour' : periodTxt}</div>
              </td>
            </tr></table>
          </td>
        </tr></table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;"><tr>
          <td style="background-color:${C.blue};background:linear-gradient(135deg,${C.blue},${C.blueLight});border-radius:12px;padding:16px 20px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td>
                <div style="font-size:9px;letter-spacing:2px;font-weight:700;color:#DBEAFE;text-transform:uppercase;font-family:${FONT};">💰 CA gagné · ${esc(monthLabel)}</div>
                <div style="font-size:10px;color:#BFDBFE;font-family:${FONT};padding-top:2px;">Cumul des deals signés depuis le 1er du mois</div>
              </td>
              <td style="font-size:26px;font-weight:800;color:${C.white};text-align:right;font-family:${FONT};white-space:nowrap;">${unavailable('monthRevenue') ? '—' : fmt(caMonth.totalAmount)} €</td>
            </tr></table>
          </td>
        </tr></table>
      </td>
    </tr></table>
  </td></tr>`;

  // ---- ANOMALIES / TEMPS FORTS ----
  const anomalyCard = buildAnomalies(data, compare);

  // ---- SECTIONS ----
  const callsSection = listSection({
    emoji: '📞', title: `Calls passés ${isToday ? '' : '· ' + (range?.label || '')}`.trim(), color: C.blue, bg: '#EFF6FF',
    rows: active(calls.detail),
    valueFn: (r) => `<span style="color:${C.muted};font-weight:500;">${r.outbound || 0} out · ${r.inbound || 0} in&nbsp;&nbsp;</span>${r.count}`,
    totalLabel: 'Total équipe', totalValue: calls.total,
    emptyText: 'Aucun call sur la période', head: ['Commercial', 'Calls'],
  });

  const rdvSection = twoColSection(
    miniList({ emoji: '🟢', title: 'R1 — échanges', color: C.green, bg: '#F0FDF4', rows: active(r1.detail), valueFn: (r) => r.count, emptyText: 'Aucun R1' }),
    miniList({ emoji: '🔵', title: 'R2 — retours', color: C.cyan, bg: '#ECFEFF', rows: active(r2.detail), valueFn: (r) => r.count, emptyText: 'Aucun R2' })
  );

  const rdvPrisSection = twoColSection(
    miniList({ emoji: '🗓', title: 'R1 pris', color: C.amber, bg: '#FFFBEB', rows: active(r1p.detail), valueFn: (r) => r.count, emptyText: 'Aucun R1 pris' }),
    miniList({ emoji: '🗓', title: 'R2 pris', color: C.amber, bg: '#FFFBEB', rows: active(r2p.detail), valueFn: (r) => r.count, emptyText: 'Aucun R2 pris' })
  );

  const propalsSection = twoColSection(
    miniList({ emoji: '📄', title: `Propositions suivies — pistes · ${propals.total}`, color: C.orange, bg: '#FFF7ED', rows: active(propals.detail), valueFn: (r) => r.count, emptyText: 'Aucune propal piste' }),
    miniList({ emoji: '🏢', title: `Propositions Comptes · ${propalsComptes.total}`, color: C.amber, bg: '#FFFBEB', rows: active(propalsComptes.detail), valueFn: (r) => r.count, emptyText: 'Aucune proposition compte' })
  );

  // Signatures : carte navy, lignes blanches
  let sigInner = sectionLabel('✍️', `Ventes gagnées ${periodTxt}`, C.blue, '#EFF6FF');
  const sigRows = active(sig.detail, true);
  if (sigRows.length === 0) {
    sigInner += emptyBox('Aucune signature sur la période');
  } else {
    sigInner += `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background-color:${P.sigBg};border-radius:12px;padding:6px 18px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          ${sigRows.map((r) => `<tr>
            <td style="padding:9px 0;font-size:14px;font-weight:700;color:${P.sigTxt};font-family:${FONT};border-bottom:1px solid ${P.sigBorder};">${esc(r.name)}</td>
            <td style="padding:9px 0;font-size:14px;font-weight:800;color:${P.sigAmount};text-align:right;font-family:${FONT};border-bottom:1px solid ${P.sigBorder};">${r.count} Signature(s) · ${fmt(r.amount)} €</td>
          </tr>`).join('')}
        </table>
      </td>
    </tr></table>`;
  }
  const sigSection = card(sigInner);

  // BDC : 3 chips + liste en attente
  let bdcInner = sectionLabel('📝', 'BDC · DocuSign', C.blue, '#EFF6FF');
  bdcInner += `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${[['Envoyés', bdcSent.total, C.orange], ['En attente', bdcPending.total, C.amber], ['Signés', bdcSigned.total, C.green]].map(([l, v, col]) => `
    <td width="33%" style="padding:3px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background-color:${C.bg};border:1px solid ${C.cardBorder};border-radius:10px;padding:12px 8px;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:${col};font-family:${FONT};">${v}</div>
          <div style="font-size:8px;letter-spacing:1.5px;font-weight:700;color:${C.muted};text-transform:uppercase;font-family:${FONT};">${l}</div>
        </td>
      </tr></table>
    </td>`).join('')}
  </tr></table>`;
  const pendRows = active(bdcPending.detail);
  if (pendRows.length > 0) {
    bdcInner += `<div style="font-size:9px;letter-spacing:1.5px;font-weight:700;color:${C.muted};text-transform:uppercase;font-family:${FONT};padding:12px 0 4px;">À relancer</div>`;
    bdcInner += `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">`;
    bdcInner += pendRows.map((r) => dataRow(r.name, r.count, C.amber)).join('');
    bdcInner += `</table>`;
  }
  const bdcSection = card(bdcInner);

  const caSection = listSection({
    emoji: '💰', title: `CA gagné ${esc(monthLabel)} — détail par sales`, color: C.blue, bg: '#EFF6FF',
    rows: active(caMonth.detail, true),
    valueFn: (r) => `${fmt(r.amount)} €`,
    totalLabel: 'Total équipe', totalValue: `${unavailable('monthRevenue') ? '—' : fmt(caMonth.totalAmount)} €`,
    emptyText: 'Aucun CA ce mois-ci', head: ['Commercial', 'CA'],
  });

  const sfSection = listSection({
    emoji: '📧', title: `RDV via SalesForge — ${isToday ? 'jour' : periodTxt}`, color: C.cyan, bg: '#ECFEFF',
    rows: active(sf.detail),
    valueFn: (r) => r.count,
    totalLabel: 'Total SalesForge', totalValue: sf.total,
    emptyText: 'Aucun RDV SalesForge sur la période', head: ['Commercial', 'RDV'],
  });

  const footer = `<tr><td style="padding:4px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background-color:${P.footBg};border:${P.heroBorder};border-radius:14px;padding:18px 24px;">
        <div style="font-size:13px;font-weight:800;color:${P.footTitle};font-family:${FONT};letter-spacing:1px;">OPENMEDIAS</div>
        <div style="font-size:10px;color:${P.footSub};font-family:${FONT};padding-top:3px;">Reporting automatique · Dashboard · Aircall + Calendly + Salesforce + DocuSign</div>
      </td>
    </tr></table>
  </td></tr>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporting commercial</title>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.bg};">
    <tr><td align="center" style="padding:24px 12px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        ${hero}
        <tr><td style="padding:12px;font-size:12px;color:#50628A;font-family:Arial,sans-serif;">CA gagné : opportunités Salesforce par date de clôture. Propositions suivies : statuts actuels modifiés sur la période, sans historique exact des envois. Vue globale sans masquage individuel.${data.errors ? ' Certaines sources sont indisponibles : les sections concernées sont masquées.' : ''}</td></tr>
        ${anomalyCard}
        ${unavailable('calls') ? '' : callsSection}
        ${unavailable('rdvToday') ? '' : rdvSection}
        ${unavailable('rdvBooked') ? '' : rdvPrisSection}
        ${unavailable('propals','propalsComptes') ? '' : propalsSection}
        ${unavailable('signatures') ? '' : sigSection}
        ${unavailable('bdc') ? '' : bdcSection}
        ${unavailable('monthRevenue') ? '' : caSection}
        ${unavailable('salesforge') ? '' : sfSection}
        ${footer}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
