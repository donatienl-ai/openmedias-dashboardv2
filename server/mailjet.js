// ==========================================
//  CONNECTEUR MAILJET — Statistiques NL EXT
//  Filtre les campagnes dont le Title contient "EXT"
//  et croise avec Calendly utm_source=Newsletter.
// ==========================================
import fetch from 'node-fetch';

// Auth Basic Mailjet (API Key : Secret Key)
function authHeader() {
  const key = process.env.MAILJET_API_KEY || '';
  const secret = process.env.MAILJET_SECRET_KEY || '';
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

const BASE = 'https://api.mailjet.com/v3/REST';

async function mjGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Mailjet ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

/**
 * Récupère les campagnes envoyées dont le Title contient "EXT",
 * dont la date d'envoi est dans la plage [start, end].
 * Retourne un tableau d'objets enrichis avec leurs stats.
 */
async function getCampaignsExt({ start, end }) {
  // Mailjet filtre sur FromTS (timestamp Unix) pour les campagnes envoyées.
  // On récupère large (depuis 180j si start est proche) et on filtre ensuite.
  const fromTs = Math.floor(start.getTime() / 1000);
  // Mailjet n'a pas de filtre "ToTS" direct, on récupère puis on filtre.
  const limit = 200;
  let offset = 0;
  let allCampaigns = [];

  while (true) {
    const data = await mjGet(
      `/campaignoverview?Limit=${limit}&Offset=${offset}&FromTS=${fromTs}`
    );
    const rows = data.Data || [];
    allCampaigns = allCampaigns.concat(rows);
    if (rows.length < limit) break;
    offset += limit;
    if (offset > 2000) break; // garde-fou
  }

  // Filtre : titre contient "EXT" (insensible à la casse) + dans la plage de dates
  const endTs = end.getTime();
  const ext = allCampaigns.filter((c) => {
    const title = (c.Title || c.Subject || '').toUpperCase();
    if (!title.includes('EXT')) return false;
    // SendStartAt est un timestamp Unix
    const sentAt = c.SendStartAt ? c.SendStartAt * 1000 : null;
    if (!sentAt) return false;
    return sentAt >= start.getTime() && sentAt <= endTs;
  });

  return ext;
}

/**
 * Récupère les statcounters agrégés (opens, clicks, unsubs, delivered, sent)
 * pour un Campaign ID donné.
 */
async function getCampaignStats(campaignId) {
  try {
    const data = await mjGet(
      `/statcounters?SourceId=${campaignId}&CounterSource=Campaign&CounterTiming=Message&CounterResolution=Lifetime`
    );
    const s = (data.Data || [])[0] || {};
    return {
      sent: s.MessageSentCount || 0,
      delivered: s.MessageDeliveredCount || 0,
      opened: s.MessageOpenedCount || 0,
      clicked: s.MessageClickedCount || 0,
      unsubscribed: s.MessageUnsubscribedCount || 0,
      bounced: (s.MessageHardBouncedCount || 0) + (s.MessageSoftBouncedCount || 0),
    };
  } catch {
    return { sent: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, bounced: 0 };
  }
}

/**
 * Point d'entrée principal : stats des NL EXT pour une plage donnée.
 * Retourne :
 *   - campaigns : tableau des NL EXT avec leurs métriques
 *   - totals : agrégat global
 */
export async function getNewsletterStats({ start, end }) {
  const campaigns = await getCampaignsExt({ start, end });

  // Récupère les stats de chaque campagne en parallèle (par paquets de 5)
  const BATCH = 5;
  const enriched = [];
  for (let i = 0; i < campaigns.length; i += BATCH) {
    const batch = campaigns.slice(i, i + BATCH);
    const stats = await Promise.all(batch.map((c) => getCampaignStats(c.ID)));
    stats.forEach((s, j) => {
      const c = batch[j];
      const sent = s.sent || 0;
      const delivered = s.delivered || sent;
      const base = delivered > 0 ? delivered : sent;
      enriched.push({
        id: c.ID,
        title: c.Title || c.Subject || `Campagne ${c.ID}`,
        subject: c.Subject || '',
        sentAt: c.SendStartAt ? new Date(c.SendStartAt * 1000).toISOString() : null,
        sent,
        delivered,
        opened: s.opened,
        clicked: s.clicked,
        unsubscribed: s.unsubscribed,
        bounced: s.bounced,
        openRate: base > 0 ? Math.round((s.opened / base) * 1000) / 10 : 0,
        clickRate: base > 0 ? Math.round((s.clicked / base) * 1000) / 10 : 0,
        unsubRate: base > 0 ? Math.round((s.unsubscribed / base) * 1000) / 10 : 0,
      });
    });
  }

  // Tri par date d'envoi décroissante
  enriched.sort((a, b) => (b.sentAt || '') > (a.sentAt || '') ? 1 : -1);

  // Totaux
  const totals = enriched.reduce(
    (acc, c) => ({
      sent: acc.sent + c.sent,
      delivered: acc.delivered + c.delivered,
      opened: acc.opened + c.opened,
      clicked: acc.clicked + c.clicked,
      unsubscribed: acc.unsubscribed + c.unsubscribed,
      bounced: acc.bounced + c.bounced,
    }),
    { sent: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, bounced: 0 }
  );

  const totalBase = totals.delivered > 0 ? totals.delivered : totals.sent;
  totals.openRate = totalBase > 0 ? Math.round((totals.opened / totalBase) * 1000) / 10 : 0;
  totals.clickRate = totalBase > 0 ? Math.round((totals.clicked / totalBase) * 1000) / 10 : 0;
  totals.unsubRate = totalBase > 0 ? Math.round((totals.unsubscribed / totalBase) * 1000) / 10 : 0;
  totals.count = enriched.length;

  return { campaigns: enriched, totals };
}
