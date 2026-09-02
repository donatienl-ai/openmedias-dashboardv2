#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================================
 RADAR ÉDITORIAL OPENMEDIAS — Scraper v2 (merge incrémental)
============================================================================
Alimente `catalogue.json` (+ `embeddings.json`) à partir des pages d'émissions
OpenMedias et concurrentes. Conçu pour tourner sans surveillance, 2x/jour,
via .github/workflows/radar-update.yml

CE QUI CHANGE PAR RAPPORT À LA v1
  1. MERGE INCRÉMENTAL — le catalogue n'est plus écrasé. On fusionne par URL :
     ce qui existe est conservé (même si le média a dépublié la page), ce qui
     est nouveau est ajouté. Plus de perte de données sur un scrape partiel.
  2. first_seen — chaque épisode porte la date à laquelle on l'a détecté pour
     la première fois. C'est ce qui alimente l'onglet « Nouveautés » du site.
  3. EMBEDDINGS SÉPARÉS ET INCRÉMENTAUX — les vecteurs partent dans
     `embeddings.json` (quantifiés int8 + base64, ~6x plus léger). Seuls les
     nouveaux épisodes sont encodés : un run quotidien coûte quelques secondes
     au lieu de re-encoder 2800 titres.
  4. SOURCES EXTERNALISÉES — voir sources.py
  5. URLS CANDIDATES — une source peut proposer plusieurs URLs ; la première
     qui renvoie des résultats gagne. Utile quand un slug de page dossier
     n'est pas connu avec certitude.
  6. MODE --check — teste toutes les sources et affiche un tableau de santé,
     sans rien écrire. À lancer en premier depuis ton poste.

POURQUOI CE SCRIPT NE TOURNE PAS DEPUIS UN ENVIRONNEMENT ANTHROPIC
  Le Figaro, Le Point, La Tribune et BFM bloquent les crawlers d'IA au niveau
  du user-agent. Depuis ton poste, un runner GitHub Actions ou un VPS, les
  pages sont publiques et répondent normalement.

INSTALLATION
  pip install requests beautifulsoup4 lxml openpyxl
  pip install cloudscraper          # si un site renvoie 403 (anti-bot)
  pip install sentence-transformers # pour les embeddings sémantiques

UTILISATION
  python scrape_openmedias.py --check              # diagnostic des sources
  python scrape_openmedias.py                      # scrape + merge
  python scrape_openmedias.py --embeddings         # + vecteurs sémantiques
  python scrape_openmedias.py --xlsx "RSS Scraping Concu.xlsx"   # reprise historique
============================================================================
"""
import argparse
import base64
import datetime
import json
import os
import re
import sys
from urllib.parse import urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Dépendances manquantes. Lance : pip install requests beautifulsoup4 lxml openpyxl")

from classify import classify, norm
from sources import SOURCES

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

TODAY = datetime.date.today().isoformat()
DEFAULT_SECTOR = "Économie / Management général"

# Le site est servi depuis radar/frontend/ (monté sur /radar par server/index.js),
# le scraper vit dans radar/scraper/. Les chemins par défaut sont résolus par
# rapport à CE fichier, pas au répertoire courant : le script marche donc
# indifféremment depuis la racine du repo, depuis radar/scraper/, ou depuis un
# runner GitHub Actions.
HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.normpath(os.path.join(HERE, "..", "frontend"))
DEFAULT_OUT = os.path.join(FRONTEND_DIR, "catalogue.json")
DEFAULT_EMB_OUT = os.path.join(FRONTEND_DIR, "embeddings.json")

# Modèle d'embeddings — doit rester identique côté navigateur (index.html)
EMB_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"
EMB_MODEL_JS = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"


# ===========================================================================
# 1. FETCH
# ===========================================================================
_session = None


def _get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({
            "User-Agent": UA,
            "Accept-Language": "fr-FR,fr;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
    return _session


def fetch(url, timeout=20):
    """Renvoie le HTML/XML d'une URL, ou None. Fallback cloudscraper si dispo."""
    try:
        r = _get_session().get(url, timeout=timeout)
        if r.status_code == 200 and len(r.text) > 500:
            return r.text
        if r.status_code != 404:
            print(f"      ! HTTP {r.status_code} sur {url}")
    except Exception as e:
        print(f"      ! erreur réseau : {type(e).__name__} sur {url}")

    try:
        import cloudscraper
        txt = cloudscraper.create_scraper().get(url, timeout=30).text
        if txt and len(txt) > 500:
            print("      (récupéré via cloudscraper)")
            return txt
    except Exception:
        pass
    return None


# ===========================================================================
# 2. DATES
# ===========================================================================
Y = r"(20\d{2})"
M = r"(0[1-9]|1[0-2])"
D = r"(0[1-9]|[12]\d|3[01])"

# Ordre = du plus spécifique au plus générique. Le premier motif qui donne une
# date valide gagne. Les motifs stricts d'abord, pour éviter qu'un identifiant
# numérique long (La Tribune : /supplement/11912485870771/) soit pris pour une date.
DATE_PATTERNS = [
    # Date dans le slug, bordée proprement. À tester AVANT _VN- : certaines URLs
    # BFM portent les deux (video-20251219-132616-...-agc_VN-202601140811) et
    # c'est la date du slug qui est la date de diffusion, pas l'id du CMS.
    (re.compile(r"[-_/]" + Y + M + D + r"(?!\d)"), "ymd"),
    # BFM : ..._VN-202606040123.html  -> YYYYMMDD suivi d'un horodatage collé
    (re.compile(r"_VN-" + Y + M + D), "ymd"),
    # chemins datés : /2026/06/04/
    (re.compile(r"/" + Y + r"/" + M + r"/" + D + r"/"), "ymd"),
    # 04-06-2026 ou 04/06/2026
    (re.compile(r"(?<!\d)" + D + r"[-/]" + M + r"[-/]" + Y + r"(?!\d)"), "dmy"),
    # YYYYMMDD isolé, bordé de non-chiffres des deux côtés
    (re.compile(r"(?<!\d)" + Y + M + D + r"(?!\d)"), "ymd"),
]


def date_from_url(url):
    """Extrait une date ISO d'une URL. Chaîne vide si rien de fiable."""
    for regex, order in DATE_PATTERNS:
        m = regex.search(url)
        if not m:
            continue
        year, month, day = (m.group(1), m.group(2), m.group(3)) if order == "ymd" \
            else (m.group(3), m.group(2), m.group(1))
        try:
            return datetime.date(int(year), int(month), int(day)).isoformat()
        except ValueError:
            continue
    return ""


def clean_date(value):
    """Normalise une date hétérogène (ISO, ISO+heure, datetime) en YYYY-MM-DD."""
    if not value:
        return ""
    s = str(value).strip()
    m = re.match(r"(20\d{2})-(\d{2})-(\d{2})", s)
    if m:
        try:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            return ""
    return ""


# ===========================================================================
# 3. PARSING
# ===========================================================================
def _as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _matches_filter(href, path_filter):
    filters = _as_list(path_filter)
    return any(f in href for f in filters) if filters else True


def _is_noise(href, cfg):
    return any(bad in href for bad in _as_list(cfg.get("exclude")))


def _emission_for(href, cfg):
    """Éclate une source en plusieurs émissions selon le slug de l'URL."""
    for fragment, name in cfg.get("emission_map", []):
        if fragment in href:
            return name
    return cfg["emission"]


def clean_title(raw):
    t = re.sub(r"\s+", " ", (raw or "").replace("\xa0", " ")).strip()
    # préfixes parasites récoltés dans les listings
    t = re.sub(r"^(Entreprises|Économie|Economie|VIDÉO|VIDEO|REPLAY)\s*[:\-–]?\s*", "", t)
    return t.strip()


def _best_from_srcset(srcset):
    """srcset/data-srcset : "url1 128w, url2 224w, ..." -> la meilleure URL
    (le plus grand descripteur de largeur, ou la derniere entree a defaut)."""
    if not srcset:
        return ""
    best_url, best_w = "", -1
    for part in srcset.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        url, w = bits[0], 0
        if len(bits) > 1 and bits[1].endswith("w"):
            try:
                w = int(bits[1][:-1])
            except ValueError:
                w = 0
        if url and w >= best_w:
            best_w, best_url = w, url
    return best_url


def _find_thumb_img(a):
    """Retrouve la <img> d'une carte-episode. Beaucoup de sites (WordPress/
    Elementor notamment) placent l'image plusieurs niveaux au-dessus du lien,
    dans un wrapper <div> generique qui ne la contient pas directement : on
    remonte jusqu'a trouver un ancetre qui a reellement une <img>, plutot que
    de s'arreter au premier <article>/<div>/<li> rencontre (qui peut etre vide)."""
    img = a.find("img")
    if img:
        return img
    el = a.parent
    depth = 0
    while el is not None and getattr(el, "name", None) not in (None, "[document]", "html") and depth < 5:
        found = el.find("img")
        if found:
            return found
        el = el.parent
        depth += 1
    return None


def parse_html_page(cfg, url, html, seen):
    """Extrait les épisodes d'une page listing. Retourne une liste de dicts."""
    soup = BeautifulSoup(html, "lxml")
    base = "{0.scheme}://{0.netloc}".format(urlparse(url))

    scope = soup
    if cfg.get("container"):
        found = soup.select(cfg["container"])
        if found:
            scope = found[0]
        else:
            print(f"      ! conteneur '{cfg['container']}' introuvable, scan page entière")

    index_urls = {u.rstrip("/") for u in _as_list(cfg["url"])}
    out = []
    for a in scope.find_all("a", href=True):
        href = urljoin(base, a["href"]).split("?")[0].split("#")[0]
        if not _matches_filter(href, cfg.get("path_filter")):
            continue
        if _is_noise(href, cfg):
            continue
        if href.rstrip("/") in index_urls:
            continue
        title = clean_title(a.get_text(" ", strip=True))
        if len(title) < 12 or href in seen:
            continue
        seen.add(href)

        thumb = ""
        img = _find_thumb_img(a)
        if img:
            thumb = img.get("data-src") or img.get("src") or ""
            if not thumb:
                thumb = _best_from_srcset(img.get("data-srcset") or img.get("srcset") or "")
            if thumb.startswith("//"):
                thumb = "https:" + thumb

        out.append({
            "source": cfg["source"],
            "media": cfg["media"],
            "emission": _emission_for(href, cfg),
            "title": title,
            "date": date_from_url(href),
            "url": href,
            "thumb": thumb,
            "sector": classify(title),
        })
    return out


def parse_sitemap(cfg, url, xml, seen):
    """Extrait les épisodes d'un sitemap (classique ou Google News)."""
    soup = BeautifulSoup(xml, "xml")
    out = []
    for node in soup.find_all("url"):
        loc = node.find("loc")
        if not loc or not loc.text:
            continue
        href = loc.text.strip().split("?")[0]
        if not _matches_filter(href, cfg.get("path_filter")) or _is_noise(href, cfg):
            continue
        if href in seen:
            continue
        seen.add(href)

        title_node = node.find("title")
        title = clean_title(title_node.text if title_node else "")
        if not title:
            # dernier recours : dériver un titre lisible du slug
            slug = urlparse(href).path.rstrip("/").split("/")[-1]
            slug = re.sub(r"[-_](20\d{6}|[A-Z0-9]{20,})$", "", slug)
            title = slug.replace("-", " ").strip().capitalize()
        if len(title) < 12:
            continue

        date_node = node.find("publication_date") or node.find("lastmod")
        out.append({
            "source": cfg["source"],
            "media": cfg["media"],
            "emission": _emission_for(href, cfg),
            "title": title,
            "date": clean_date(date_node.text if date_node else "") or date_from_url(href),
            "url": href,
            "thumb": "",
            "sector": classify(title),
        })
    return out


def scrape_source(cfg, save_debug=True):
    """Scrape une source. Essaie chaque URL candidate. Retourne (records, diagnostic)."""
    candidates = _as_list(cfg["url"])
    kind = cfg.get("kind", "html")
    max_pages = cfg.get("max_pages", 50)
    label = f"{cfg['media']} · {cfg['emission']}"

    for candidate in candidates:
        seen = set()
        html = fetch(candidate)
        if not html:
            continue

        if kind == "sitemap":
            out = parse_sitemap(cfg, candidate, html, seen)
        else:
            out = parse_html_page(cfg, candidate, html, seen)

            if cfg.get("paginate") and out:
                pattern = cfg.get("page_pattern", "slash")
                base_url = candidate.rstrip("/") + "/"
                for page_num in range(2, max_pages + 1):
                    if pattern == "query":
                        page_url = candidate.rstrip("/") + f"?page={page_num}"
                    else:
                        page_url = base_url + f"page{page_num}/"
                    page_html = fetch(page_url)
                    if not page_html:
                        break
                    new = parse_html_page(cfg, page_url, page_html, seen)
                    if not new:
                        break
                    out.extend(new)
                    print(f"      page {page_num} -> +{len(new)}")

        if out:
            note = "" if candidate == candidates[0] else f"  [via candidat : {candidate}]"
            print(f"   -> {len(out):4d}  {label}{note}")
            return out, dict(ok=True, url=candidate, n=len(out))

    # aucune candidate n'a produit de résultat
    optional = cfg.get("optional", False)
    flag = "(optionnel)" if optional else "!! ÉCHEC"
    print(f"   -> {0:4d}  {label}  {flag}")

    if save_debug and not optional and candidates:
        html = fetch(candidates[0])
        if html:
            slug = re.sub(r"[^a-z0-9]+", "-", norm(cfg["emission"])).strip("-")
            # à côté du scraper, pas dans le répertoire courant : évite de semer
            # des debug_*.html à la racine du repo
            path = os.path.join(HERE, f"debug_{slug}.html")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(html)
            print(f"      page récupérée mais 0 lien retenu -> {path} pour diagnostic")
        else:
            print("      page inaccessible (blocage réseau ou URL morte)")

    return [], dict(ok=False, url=candidates[0] if candidates else "", n=0,
                    optional=optional)


# ===========================================================================
# 4. REPRISE DE L'HISTORIQUE XLSX
# ===========================================================================
def parse_xlsx(path):
    """Ingère l'ancien export RSS. Sert une seule fois, pour l'historique.

    Attention : ces flux mélangeaient advertorials et vraie rédaction. On
    filtre le bruit connu, mais un résidu est possible sur les entrées Figaro.
    """
    from openpyxl import load_workbook

    MEDIA = {
        "www.bfmtv.com": "BFM Business",
        "www.lefigaro.fr": "Le Figaro",
        "www.lepoint.fr": "Le Point",
        "www.latribune.fr": "La Tribune",
    }
    NOISE = ("/le-scan-eco", "/flash-actu", "/flash-eco", "/live/")

    wb = load_workbook(path, read_only=True)
    out, skipped = [], 0
    for sheet in wb.sheetnames:
        for row in wb[sheet].iter_rows(min_row=2, values_only=True):
            if not row or len(row) < 3 or not row[0] or not row[2]:
                continue
            url = str(row[2]).strip().split("?")[0]
            if any(bad in url for bad in NOISE):
                skipped += 1
                continue
            title = clean_title(str(row[0]))
            if len(title) < 12:
                continue
            netloc = urlparse(url).netloc
            out.append({
                "source": "Concurrents",
                "media": MEDIA.get(netloc, netloc),
                "emission": sheet.strip(),
                "title": title,
                "date": clean_date(row[1]) or date_from_url(url),
                "url": url,
                "thumb": "",
                "sector": classify(title),
            })
    print(f"   -> {len(out):4d}  historique xlsx ({skipped} entrées de bruit écartées)")
    return out


# ===========================================================================
# 5. MERGE INCRÉMENTAL
# ===========================================================================
def load_catalogue(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError) as e:
        print(f"! catalogue existant illisible ({e}) — on repart de zéro")
        return []


def merge(existing, scraped, backfill=True):
    """Fusionne par URL. Conserve l'existant, enrichit, ajoute le nouveau.

    Renvoie (records, stats). Aucune suppression : une page dépubliée par le
    média reste dans le radar.
    """
    by_url = {}
    for r in existing:
        url = (r.get("url") or "").strip()
        if url:
            by_url[url] = dict(r)

    # Backfill first_seen sur le legacy : on utilise la date de publication pour
    # ne pas faire apparaître 2800 entrées comme « nouvelles » aujourd'hui.
    if backfill:
        for r in by_url.values():
            if not r.get("first_seen"):
                r["first_seen"] = clean_date(r.get("date")) or "legacy"

    added, updated = 0, 0
    for r in scraped:
        url = (r.get("url") or "").strip()
        if not url:
            continue
        if url in by_url:
            old = by_url[url]
            changed = False
            # on complète les trous sans écraser ce qui est déjà renseigné
            for field in ("thumb", "date", "title", "emission", "media"):
                if not old.get(field) and r.get(field):
                    old[field] = r[field]
                    changed = True
            if old.get("source") != r.get("source"):
                old["source"] = r["source"]
                changed = True
            if changed:
                updated += 1
        else:
            r = dict(r)
            r["first_seen"] = TODAY
            by_url[url] = r
            added += 1

    records = list(by_url.values())
    # tri stable : plus récent d'abord (date de pub, sinon détection)
    records.sort(key=lambda r: (r.get("date") or "", r.get("first_seen") or ""), reverse=True)
    for i, r in enumerate(records):
        r["id"] = i
        r.setdefault("sector", DEFAULT_SECTOR)
        r.setdefault("first_seen", "legacy")
        r.pop("emb", None)  # les vecteurs vivent dans embeddings.json

    return records, dict(added=added, updated=updated, total=len(records))


# ===========================================================================
# 6. EMBEDDINGS (fichier séparé, quantifiés int8, incrémentaux)
# ===========================================================================
def emb_text(r):
    return f"{r.get('title', '')} {r.get('sector', '')}".strip()


def load_embeddings(path):
    """Renvoie {url: [floats]} depuis embeddings.json, ou {}."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            blob = json.load(fh)
        urls = blob.get("urls") or []
        dim = int(blob.get("dim") or 0)
        raw = base64.b64decode(blob.get("data") or "")
        if not urls or not dim or len(raw) != len(urls) * dim:
            print("! embeddings.json incohérent — recalcul complet")
            return {}
        out = {}
        for i, url in enumerate(urls):
            chunk = raw[i * dim:(i + 1) * dim]
            out[url] = [(b - 256 if b > 127 else b) / 127.0 for b in chunk]
        return out
    except Exception as e:
        print(f"! embeddings.json illisible ({e}) — recalcul complet")
        return {}


def write_embeddings(path, records, cache):
    """Écrit embeddings.json : int8 quantifié + base64. ~6x plus léger qu'en floats JSON."""
    vectors, urls = [], []
    for r in records:
        vec = cache.get(r["url"])
        if vec:
            urls.append(r["url"])
            vectors.append(vec)
    if not vectors:
        print("! aucun vecteur à écrire")
        return 0

    dim = len(vectors[0])
    buf = bytearray()
    for vec in vectors:
        for v in vec:
            q = int(round(max(-1.0, min(1.0, v)) * 127))
            buf.append(q & 0xFF)

    blob = {
        "model": EMB_MODEL_JS,
        "dim": dim,
        "count": len(vectors),
        "quant": "int8",
        "generated": TODAY,
        "urls": urls,
        "data": base64.b64encode(bytes(buf)).decode("ascii"),
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(blob, fh, ensure_ascii=False, separators=(",", ":"))
    size_mb = os.path.getsize(path) / 1e6
    print(f"✓ {len(vectors)} vecteurs ({dim}d, int8) -> {path}  [{size_mb:.1f} Mo]")
    return len(vectors)


def compute_embeddings(records, cache):
    """Encode uniquement les épisodes absents du cache. Retourne (cache, n_nouveaux)."""
    todo = [r for r in records if r["url"] not in cache]
    if not todo:
        print(f"✓ embeddings à jour ({len(cache)} vecteurs en cache, 0 à calculer)")
        return cache, 0

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print("! sentence-transformers absent — lance : pip install sentence-transformers")
        print("  (le site retombe sur le scoring TF-IDF, qui reste fonctionnel)")
        return cache, 0

    print(f"Chargement du modèle {EMB_MODEL}…")
    model = SentenceTransformer(EMB_MODEL)
    print(f"Encodage de {len(todo)} nouveaux épisodes ({len(cache)} déjà en cache)…")
    vecs = model.encode([emb_text(r) for r in todo], batch_size=64,
                        show_progress_bar=True, normalize_embeddings=True)
    for r, vec in zip(todo, vecs):
        cache[r["url"]] = [float(v) for v in vec]
    return cache, len(todo)


# ===========================================================================
# 7. MODE --check
# ===========================================================================
def run_check():
    print("DIAGNOSTIC DES SOURCES — aucune écriture\n")
    results = []
    for cfg in SOURCES:
        _, diag = scrape_source(cfg, save_debug=False)
        diag["label"] = f"{cfg['media']} · {cfg['emission']}"
        results.append(diag)

    ok = [d for d in results if d["ok"]]
    ko = [d for d in results if not d["ok"] and not d.get("optional")]
    opt = [d for d in results if not d["ok"] and d.get("optional")]

    print("\n" + "=" * 74)
    print(f"{len(ok)}/{len(results)} sources opérationnelles")
    print("=" * 74)
    for d in sorted(ok, key=lambda x: -x["n"]):
        print(f"  OK   {d['n']:5d}  {d['label']}")
        print(f"                 {d['url']}")
    if ko:
        print("\nÀ CORRIGER :")
        for d in ko:
            print(f"  KO          {d['label']}")
            print(f"                 dernier candidat testé : {d['url']}")
        print("\n  -> ouvre ces URLs dans ton navigateur. Si la page existe mais que le")
        print("     slug diffère, corrige la liste `url` de la source dans sources.py.")
        print("     Un fichier debug_*.html est écrit quand la page répond mais qu'aucun")
        print("     lien n'est retenu (c'est alors le path_filter qu'il faut ajuster).")
    if opt:
        print("\nOPTIONNELLES sans résultat (non bloquant) :")
        for d in opt:
            print(f"  --          {d['label']}")
    return 0 if ok else 1


# ===========================================================================
# 8. MAIN
# ===========================================================================
def main():
    ap = argparse.ArgumentParser(description="Scraper du Radar Éditorial OpenMedias")
    ap.add_argument("--check", action="store_true",
                    help="teste les sources et sort un diagnostic, sans rien écrire")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="défaut : radar/frontend/catalogue.json")
    ap.add_argument("--emb-out", default=DEFAULT_EMB_OUT,
                    help="défaut : radar/frontend/embeddings.json")
    ap.add_argument("--xlsx", help="ancien export RSS à fusionner (reprise historique)")
    ap.add_argument("--embeddings", action="store_true",
                    help="calcule les vecteurs sémantiques manquants")
    ap.add_argument("--no-merge", action="store_true",
                    help="écrase le catalogue au lieu de fusionner (déconseillé)")
    args = ap.parse_args()

    if args.check:
        return run_check()

    existing = [] if args.no_merge else load_catalogue(args.out)
    print(f"Catalogue existant : {len(existing)} épisodes\n")

    print("Scraping des sources…")
    scraped, failures = [], []
    for cfg in SOURCES:
        records, diag = scrape_source(cfg)
        scraped.extend(records)
        if not diag["ok"] and not diag.get("optional"):
            failures.append(f"{cfg['media']} · {cfg['emission']}")

    if args.xlsx:
        if os.path.exists(args.xlsx):
            print("\nReprise de l'historique xlsx…")
            scraped.extend(parse_xlsx(args.xlsx))
        else:
            print(f"\n! fichier historique introuvable : {args.xlsx} (ignoré)")

    # garde-fou : ne jamais réduire un catalogue existant à néant sur un
    # incident réseau généralisé (site down, IP bloquée, DNS...).
    if existing and not scraped:
        print("\n!! ARRÊT — 0 épisode récupéré alors que le catalogue en contient "
              f"{len(existing)}.")
        print("   Probable blocage réseau. Le catalogue existant est laissé intact.")
        return 2

    records, stats = merge(existing, scraped, backfill=not args.no_merge)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(records, fh, ensure_ascii=False, separators=(",", ":"))

    if args.embeddings:
        cache = load_embeddings(args.emb_out)
        cache, _ = compute_embeddings(records, cache)
        # purge les vecteurs orphelins
        live = {r["url"] for r in records}
        cache = {u: v for u, v in cache.items() if u in live}
        write_embeddings(args.emb_out, records, cache)

    nous = sum(1 for r in records if r.get("source") == "Nous")
    new_today = sum(1 for r in records if r.get("first_seen") == TODAY)

    print(f"\n{'=' * 74}")
    print(f"✓ {stats['total']} épisodes dans {args.out}")
    print(f"  {nous} OpenMedias · {stats['total'] - nous} concurrents")
    print(f"  +{stats['added']} nouveaux · {stats['updated']} enrichis · "
          f"{new_today} détectés aujourd'hui")
    if failures:
        print(f"\n  {len(failures)} source(s) muette(s) — lance --check pour diagnostiquer :")
        for f in failures:
            print(f"    - {f}")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
