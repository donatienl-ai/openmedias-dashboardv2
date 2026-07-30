// ── ANALYSE D'URL PROSPECT (Radar éditorial) ────────────────────────────────
// Avant : le front radar (100 % client) passait par des proxies publics
// gratuits (DuckDuckGo instant answer, allorigins.win, microlink.io) pour lire
// le site d'un prospect — rate-limits, pannes et CORS en faisaient la feature
// la moins fiable de l'app, et le texte récupéré était trop pauvre pour un
// bon matching. Depuis la fusion sous /radar, on a un serveur : autant s'en
// servir. Cette route fetche la page elle-même (vrai User-Agent navigateur,
// pas de proxy) et renvoie un texte nettoyé (titre + meta description +
// titres + premiers paragraphes), exactement ce qu'il faut pour extraire des
// mots-clés de qualité côté front.
//
// Sécurité : proxy ouvert = vecteur SSRF. On n'accepte que http(s) vers des
// hôtes publics (IP privées / localhost / .local refusés), réponse plafonnée
// en taille et en temps, pas de forwarding de cookies ni de headers entrants.

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|169\.254\.|\[?::1\]?)/i;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_HTML = 1_500_000; // 1,5 Mo — au-delà, on tronque (les homepages géantes n'apportent rien au matching)

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickMeta(html, names) {
  for (const name of names) {
    // content avant OU après l'attribut name/property — les deux existent
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i'),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1] && m[1].trim().length > 10) return m[1].trim();
    }
  }
  return '';
}

// Extraction pure (testable sans réseau) : titre + meta + titres + paragraphes,
// après suppression du bruit (scripts, styles, nav, bannières cookies...).
export function extractPageText(html) {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const desc = stripTags(pickMeta(html, ['description', 'og:description', 'twitter:description']));

  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+class=["'][^"']*(cookie|consent|gdpr|rgpd|banner|popup|modal|newsletter)[^"']*["'][^>]*>[\s\S]*?<\/(div|section)>/gi, ' ');

  const headings = [...cleaned.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((h) => h.length > 3)
    .slice(0, 12)
    .join(' ');
  const paras = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((p) => p.length > 40) // vire les micro-paragraphes de nav résiduelle
    .slice(0, 20)
    .join(' ');

  const text = [title, desc, headings, paras].filter(Boolean).join(' ').slice(0, 8000);
  return { title, text };
}

export function registerRadarPageTextRoute(app) {
  app.get('/radar/api/page-text', async (req, res) => {
    try {
      const raw = String(req.query.url || '').trim();
      let u;
      try {
        u = new URL(raw);
      } catch {
        return res.status(400).json({ error: 'URL invalide' });
      }
      if (!/^https?:$/.test(u.protocol)) {
        return res.status(400).json({ error: 'Seuls http(s) sont supportés' });
      }
      const host = u.hostname.toLowerCase();
      if (PRIVATE_HOST.test(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
        return res.status(400).json({ error: 'Hôte non autorisé' });
      }

      const r = await fetch(u.toString(), {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return res.status(502).json({ error: `Le site a répondu HTTP ${r.status}` });

      const html = (await r.text()).slice(0, MAX_HTML);
      const { title, text } = extractPageText(html);
      if (text.length < 80) {
        return res.status(502).json({ error: 'Pas assez de texte lisible sur la page (site en JS pur ?)' });
      }
      res.json({ title, text });
    } catch (e) {
      res.status(502).json({ error: String(e?.message || e) });
    }
  });
}
