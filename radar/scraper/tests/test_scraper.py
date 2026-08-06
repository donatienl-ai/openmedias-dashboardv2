#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================================
 TESTS — scraper v2
============================================================================
Tourne hors réseau : le parsing est testé sur des fixtures HTML calquées sur
la structure réelle des pages, le merge sur le vrai catalogue.json.

  python tests/test_scraper.py
============================================================================
"""
import base64
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # radar/scraper
FRONTEND = os.path.normpath(os.path.join(ROOT, "..", "frontend"))    # radar/frontend
sys.path.insert(0, ROOT)

from scrape_openmedias import (  # noqa: E402
    clean_date, clean_title, date_from_url, load_embeddings, merge,
    parse_html_page, parse_sitemap, write_embeddings,
)
from sources import SOURCES  # noqa: E402

PASS, FAIL = [], []


def check(label, got, expected):
    if got == expected:
        PASS.append(label)
    else:
        FAIL.append(f"{label}\n      attendu : {expected!r}\n      obtenu  : {got!r}")


def ok(label, condition, detail=""):
    if condition:
        PASS.append(label)
    else:
        FAIL.append(f"{label}{('  — ' + detail) if detail else ''}")


# ===========================================================================
# 1. EXTRACTION DE DATES — sur de vraies URLs des 4 médias
# ===========================================================================
def test_dates():
    check("date Figaro (-YYYYMMDD)",
          date_from_url("https://www.lefigaro.fr/economie/vente-unique-les-ressorts-d-une-croissance-20260603"),
          "2026-06-03")
    check("date BFM (DD-MM_VN)",
          date_from_url("https://www.bfmtv.com/economie/replay-emissions/trajectoire/video-trajectoire-evidency-04-06_VN-202606040123.html"),
          "2026-06-04")
    check("date Le Point (id Arc, pas de date)",
          date_from_url("https://www.lepoint.fr/stories/froid-24-lexpert-M2IUKC7PJFDHRFISLNUI"),
          "")
    check("date invalide rejetee (mois 13)",
          date_from_url("https://exemple.fr/article-20261301"), "")
    check("faux positif evite (id numerique long)",
          date_from_url("https://www.latribune.fr/article/partenaires/supplement/11912485870771/gestion-d-actifs"),
          "")
    check("date BFM (_VN- sans tiret de slug)",
          date_from_url("https://www.bfmtv.com/economie/replay-emissions/impact-pme-l-hebdo/video-cap-pme-l-hebdo-la-sante_VN-202605310412.html"),
          "2026-05-31")
    # Cas piege : deux dates dans l'URL. La date du slug est celle de diffusion,
    # _VN-... n'est que l'identifiant du CMS BFM (souvent posterieur).
    check("date BFM : slug prioritaire sur l'id CMS",
          date_from_url("https://www.bfmtv.com/economie/replay-emissions/grand-angle-paroles-d-entreprises/video-20251219-132616-grand-angle-agc_VN-202601140811.html"),
          "2025-12-19")
    check("date chemin /YYYY/MM/DD/",
          date_from_url("https://exemple.fr/2026/06/04/mon-article"), "2026-06-04")
    check("date DD-MM-YYYY", date_from_url("https://exemple.fr/article-04-06-2026"), "2026-06-04")
    check("id Arc de 20+ caracteres non pris pour une date",
          date_from_url("https://www.lepoint.fr/stories/helvetx-KO7OF6A5PFFADD6CCWYHCJSJEY"), "")
    check("clean_date depuis ISO+heure",
          clean_date("2026-03-06T08:00:00.000Z"), "2026-03-06")
    check("clean_date sur vide", clean_date(None), "")
    check("clean_date sur bruit", clean_date("bientot"), "")


# ===========================================================================
# 2. NETTOYAGE DE TITRES
# ===========================================================================
def test_titles():
    check("prefixe 'Entreprises' retire",
          clean_title("Entreprises  Froid 24 : le specialiste"), "Froid 24 : le specialiste")
    check("nbsp normalise",
          clean_title("KELP Group\xa0: l'allie"), "KELP Group : l'allie")
    check("prefixe VIDEO retire",
          clean_title("VIDÉO : Trajectoire Evidency"), "Trajectoire Evidency")
    check("titre propre inchange",
          clean_title("Decibell : la pepite bretonne"), "Decibell : la pepite bretonne")


# ===========================================================================
# 3. PARSING HTML — path_filter, exclusion du bruit, emission_map
# ===========================================================================
FIXTURE_FIGARO = """
<html><body><main>
  <a href="/economie/waga-energy-transformer-les-dechets-en-souverainete-20260403">
    <img data-src="//i.f1g.fr/waga.jpg">Waga Energy : transformer les dechets en levier de souverainete
  </a>
  <a href="/economie/demgy-group-expert-en-plasturgie-haute-performance-20260515">
    Demgy Group : expert en plasturgie et polymeres haute performance
  </a>
  <!-- bruit editorial : doit etre ecarte par `exclude` -->
  <a href="/economie/le-scan-eco/sebastien-lecornu-annonce-500-controles-20260308">
    Sebastien Lecornu annonce 500 controles dans les stations-service
  </a>
  <!-- hors path_filter -->
  <a href="/sport/psg-gagne-encore-un-match-20260101">Le PSG gagne encore un match important</a>
  <!-- trop court -->
  <a href="/economie/x-20260101">Suite</a>
</main></body></html>
"""


def test_parse_html():
    cfg = dict(source="Concurrents", media="Le Figaro", emission="Focus Business",
               url="https://www.lefigaro.fr/economie/dossier/focus-business",
               path_filter=["/economie/", "/lifestyle/"],
               exclude=["/le-scan-eco", "/flash-actu"])
    got = parse_html_page(cfg, cfg["url"], FIXTURE_FIGARO, set())

    check("figaro : 2 episodes retenus", len(got), 2)
    titles = [r["title"] for r in got]
    ok("figaro : bruit /le-scan-eco ecarte",
       not any("Lecornu" in t for t in titles), f"titres={titles}")
    ok("figaro : hors-perimetre /sport ecarte",
       not any("PSG" in t for t in titles), f"titres={titles}")
    check("figaro : date extraite", got[0]["date"], "2026-04-03")
    check("figaro : thumb protocole-relatif corrige",
          got[0]["thumb"], "https://i.f1g.fr/waga.jpg")
    check("figaro : URL absolutisee",
          got[0]["url"],
          "https://www.lefigaro.fr/economie/waga-energy-transformer-les-dechets-en-souverainete-20260403")
    check("figaro : secteur classe", got[0]["sector"], "Énergie & environnement")


FIXTURE_LEPOINT = """
<html><body>
  <a href="/services/interview-masterclass-par-michel-denisot-groupe-roy-energie-ULIAJICATVHXLKLTOCV6EMYDKE">
    Interview Masterclass par Michel Denisot : Groupe Roy Energie, le solaire local
  </a>
  <a href="/services/made-in-france-5-entrepreneurs-qui-ont-relocalise-R426E6OIDFEAVL355DYSJFZPWM">
    Made in France : 5 entrepreneurs qui ont relocalise leur production
  </a>
</body></html>
"""


def test_emission_map():
    cfg = dict(source="Concurrents", media="Le Point", emission="Le Point Services",
               url="https://www.lepoint.fr/services/", path_filter="/services/",
               emission_map=[("interview-masterclass", "MasterClass avec Michel Denisot")])
    got = parse_html_page(cfg, cfg["url"], FIXTURE_LEPOINT, set())
    by_title = {r["title"][:20]: r["emission"] for r in got}
    check("emission_map : 2 episodes", len(got), 2)
    check("emission_map : masterclass reetiquete",
          by_title.get("Interview Masterclas"), "MasterClass avec Michel Denisot")
    check("emission_map : le reste garde le nom par defaut",
          by_title.get("Made in France : 5 e"), "Le Point Services")


def test_index_url_excluded():
    """La page dossier elle-meme ne doit pas se retrouver comme episode."""
    cfg = dict(source="Nous", media="Le Figaro", emission="Test",
               url=["https://www.lefigaro.fr/economie/dossier/reussites-d-entreprises"],
               path_filter="/economie/")
    html = ('<a href="/economie/dossier/reussites-d-entreprises">Reussites d entreprises le dossier</a>'
            '<a href="/economie/vrai-episode-tres-interessant-20260101">Vrai episode tres interessant</a>')
    got = parse_html_page(cfg, cfg["url"][0], html, set())
    check("page dossier non comptee comme episode", len(got), 1)


def test_dedup_within_page():
    cfg = dict(source="Nous", media="X", emission="Y",
               url="https://x.fr/liste/", path_filter="/article/")
    html = ('<a href="/article/mon-episode-formidable-20260101">Mon episode formidable</a>'
            '<a href="/article/mon-episode-formidable-20260101">Mon episode formidable (bis)</a>')
    got = parse_html_page(cfg, "https://x.fr/liste/", html, set())
    check("dedup intra-page par URL", len(got), 1)


FIXTURE_SITEMAP = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>https://www.lepoint.fr/stories/softwareone-la-cybersecurite-comme-levier-RJSLBSRSTNFITFDYRQLEIYXCXE</loc>
    <news:news><news:publication_date>2026-06-04T09:12:00Z</news:publication_date>
      <news:title>SoftwareOne : la cybersecurite comme levier de resilience operationnelle</news:title>
    </news:news>
  </url>
  <url>
    <loc>https://www.lepoint.fr/politique/un-article-de-redaction-classique-a-ecarter</loc>
    <news:news><news:publication_date>2026-06-04T10:00:00Z</news:publication_date>
      <news:title>Un article de redaction classique a ecarter</news:title>
    </news:news>
  </url>
</urlset>
"""


def test_parse_sitemap():
    cfg = dict(source="Concurrents", media="Le Point", emission="Le Point Stories",
               kind="sitemap", url="https://www.lepoint.fr/sitemap_news.xml",
               path_filter=["/stories/"])
    got = parse_sitemap(cfg, cfg["url"], FIXTURE_SITEMAP, set())
    check("sitemap : 1 seul episode retenu", len(got), 1)
    check("sitemap : titre lu depuis news:title",
          got[0]["title"], "SoftwareOne : la cybersecurite comme levier de resilience operationnelle")
    check("sitemap : date de publication lue", got[0]["date"], "2026-06-04")


# ===========================================================================
# 4. MERGE INCREMENTAL
# ===========================================================================
def test_merge_basics():
    existing = [
        {"url": "https://a.fr/1", "title": "Ancien un tres long titre", "source": "Nous",
         "media": "M", "emission": "E", "date": "2026-01-15", "thumb": "", "sector": "S"},
        {"url": "https://a.fr/2", "title": "Ancien deux tres long titre", "source": "Nous",
         "media": "M", "emission": "E", "date": "", "thumb": "", "sector": "S"},
    ]
    scraped = [
        # meme URL, thumb desormais disponible -> enrichissement
        {"url": "https://a.fr/1", "title": "Ancien un tres long titre", "source": "Nous",
         "media": "M", "emission": "E", "date": "2026-01-15",
         "thumb": "https://img/1.jpg", "sector": "S"},
        # nouveau
        {"url": "https://a.fr/3", "title": "Nouveau trois tres long titre", "source": "Concurrents",
         "media": "M", "emission": "E", "date": "2026-07-28", "thumb": "", "sector": "S"},
    ]
    records, stats = merge(existing, scraped)

    check("merge : 1 ajout", stats["added"], 1)
    check("merge : 1 enrichissement", stats["updated"], 1)
    check("merge : total", stats["total"], 3)

    by_url = {r["url"]: r for r in records}
    ok("merge : rien n'est supprime", "https://a.fr/2" in by_url)
    check("merge : thumb complete", by_url["https://a.fr/1"]["thumb"], "https://img/1.jpg")
    ok("merge : first_seen backfille depuis la date de pub",
       by_url["https://a.fr/1"]["first_seen"] == "2026-01-15")
    ok("merge : legacy sans date marque 'legacy'",
       by_url["https://a.fr/2"]["first_seen"] == "legacy")

    from scrape_openmedias import TODAY
    check("merge : nouveau porte la date du jour",
          by_url["https://a.fr/3"]["first_seen"], TODAY)
    check("merge : ids reattribues sans trou",
          sorted(r["id"] for r in records), [0, 1, 2])
    ok("merge : tri par date decroissante",
       [r["url"] for r in records][0] == "https://a.fr/3",
       f"ordre={[r['url'] for r in records]}")


def test_merge_idempotent():
    """Rejouer le meme scrape ne doit rien ajouter."""
    scraped = [{"url": "https://a.fr/1", "title": "Un titre suffisamment long", "source": "Nous",
                "media": "M", "emission": "E", "date": "2026-01-15", "thumb": "t", "sector": "S"}]
    first, s1 = merge([], scraped)
    second, s2 = merge(first, scraped)
    check("idempotence : 1er passage ajoute", s1["added"], 1)
    check("idempotence : 2e passage n'ajoute rien", s2["added"], 0)
    check("idempotence : 2e passage n'enrichit rien", s2["updated"], 0)
    check("idempotence : total stable", s2["total"], 1)
    check("idempotence : first_seen preserve",
          second[0]["first_seen"], first[0]["first_seen"])


def test_merge_no_emb_leak():
    existing = [{"url": "https://a.fr/1", "title": "Titre assez long ici", "source": "Nous",
                 "media": "M", "emission": "E", "date": "2026-01-01", "thumb": "",
                 "sector": "S", "emb": [0.1] * 384}]
    records, _ = merge(existing, [])
    ok("merge : champ emb purge du catalogue", "emb" not in records[0])


def test_merge_real_catalogue():
    """Merge sur le vrai catalogue : aucune perte, aucune fausse nouveaute."""
    path = os.path.join(FRONTEND, "catalogue.json")
    if not os.path.exists(path):
        FAIL.append("catalogue.json introuvable — test reel non joue")
        return
    with open(path, encoding="utf-8") as fh:
        real = json.load(fh)

    records, stats = merge(real, [])
    check("catalogue reel : aucune perte", stats["total"], len(real))
    check("catalogue reel : aucun ajout a vide", stats["added"], 0)

    from scrape_openmedias import TODAY
    faux_neufs = [r for r in records if r.get("first_seen") == TODAY]
    ok("catalogue reel : aucune entree legacy marquee neuve aujourd'hui",
       len(faux_neufs) == 0, f"{len(faux_neufs)} entrees")

    dated = [r for r in records if r["first_seen"] != "legacy"]
    ok("catalogue reel : first_seen backfille sur la majorite",
       len(dated) > len(real) * 0.95,
       f"{len(dated)}/{len(real)} avec une date reelle")

    ok("catalogue reel : toutes les cles attendues presentes",
       all({"url", "title", "source", "media", "emission", "sector",
            "first_seen", "id"} <= set(r) for r in records))

    urls = [r["url"] for r in records]
    check("catalogue reel : URLs uniques", len(urls), len(set(urls)))


# ===========================================================================
# 5. EMBEDDINGS — aller-retour quantification int8
# ===========================================================================
def test_embeddings_roundtrip():
    records = [{"url": f"https://a.fr/{i}"} for i in range(5)]
    import random
    random.seed(42)
    original = {}
    for r in records:
        vec = [random.uniform(-1, 1) for _ in range(384)]
        norm_ = sum(v * v for v in vec) ** 0.5
        original[r["url"]] = [v / norm_ for v in vec]

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "embeddings.json")
        n = write_embeddings(path, records, original)
        check("embeddings : tous les vecteurs ecrits", n, 5)

        blob = json.load(open(path, encoding="utf-8"))
        check("embeddings : dim conservee", blob["dim"], 384)
        check("embeddings : quantification declaree", blob["quant"], "int8")
        raw = base64.b64decode(blob["data"])
        check("embeddings : taille binaire = count x dim", len(raw), 5 * 384)

        back = load_embeddings(path)
        check("embeddings : relecture complete", len(back), 5)

        # erreur de quantification : doit rester sous le pas de quantification
        worst = max(abs(a - b)
                    for url in original
                    for a, b in zip(original[url], back[url]))
        ok("embeddings : erreur de quantification < 1/127",
           worst < 1 / 127, f"erreur max={worst:.5f}")

        # la similarite cosinus doit survivre a l'aller-retour
        def dot(a, b):
            return sum(x * y for x, y in zip(a, b))
        u, v = records[0]["url"], records[1]["url"]
        drift = abs(dot(original[u], original[v]) - dot(back[u], back[v]))
        ok("embeddings : cosinus preserve (derive < 0.005)",
           drift < 0.005, f"derive={drift:.6f}")


def test_embeddings_missing_file():
    check("embeddings : fichier absent -> cache vide",
          load_embeddings("/inexistant/embeddings.json"), {})


def test_embeddings_corrupt_file():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "embeddings.json")
        with open(path, "w") as fh:
            json.dump({"dim": 384, "urls": ["a", "b"], "data": base64.b64encode(b"\x01\x02").decode()}, fh)
        check("embeddings : fichier incoherent -> cache vide (pas de crash)",
              load_embeddings(path), {})


def test_embeddings_partial_cache():
    """Un catalogue plus grand que le cache ne doit pas ecrire de vecteurs bidons."""
    records = [{"url": f"https://a.fr/{i}"} for i in range(4)]
    cache = {"https://a.fr/0": [0.5] * 8, "https://a.fr/2": [-0.5] * 8}
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "e.json")
        n = write_embeddings(path, records, cache)
        check("embeddings : seuls les vecteurs connus sont ecrits", n, 2)
        blob = json.load(open(path, encoding="utf-8"))
        check("embeddings : urls alignees sur les vecteurs",
              blob["urls"], ["https://a.fr/0", "https://a.fr/2"])


# ===========================================================================
# 6. COHERENCE DE LA CONFIG DES SOURCES
# ===========================================================================
def test_sources_config():
    ok("sources : liste non vide", len(SOURCES) > 0)
    for cfg in SOURCES:
        label = f"{cfg.get('media')}/{cfg.get('emission')}"
        ok(f"sources[{label}] : champs obligatoires",
           all(k in cfg for k in ("source", "media", "emission", "url", "path_filter")))
        ok(f"sources[{label}] : source valide",
           cfg["source"] in ("Nous", "Concurrents"))
        ok(f"sources[{label}] : kind valide",
           cfg.get("kind", "html") in ("html", "sitemap"))
        urls = cfg["url"] if isinstance(cfg["url"], list) else [cfg["url"]]
        ok(f"sources[{label}] : URLs en https",
           all(u.startswith("https://") for u in urls))

    names = [(c["media"], c["emission"], c.get("kind", "html")) for c in SOURCES]
    ok("sources : pas de doublon media/emission/kind",
       len(names) == len(set(names)),
       f"doublons={[n for n in names if names.count(n) > 1]}")

    nous = [c for c in SOURCES if c["source"] == "Nous"]
    ok("sources : les 10 emissions OpenMedias sont couvertes", len(nous) == 10,
       f"{len(nous)} trouvees")


# ===========================================================================
# RUNNER
# ===========================================================================
def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        try:
            fn()
        except Exception as e:
            import traceback
            FAIL.append(f"{fn.__name__} a leve {type(e).__name__}: {e}\n"
                        + traceback.format_exc(limit=3))

    print(f"\n{'=' * 74}")
    print(f"  {len(PASS)} OK   ·   {len(FAIL)} ECHEC")
    print("=" * 74)
    if FAIL:
        for f in FAIL:
            print(f"\n  ECHEC  {f}")
        return 1
    print("  Tout est vert.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
