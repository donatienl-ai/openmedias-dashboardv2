#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================================
 RADAR ÉDITORIAL — Configuration des sources
============================================================================
Séparé du scraper pour que l'ajout d'une émission ne demande pas de toucher
au code. Une source = un dict.

CHAMPS COMMUNS
  source       "Nous" | "Concurrents"
  media        nom d'affichage du média
  emission     nom d'affichage de l'émission
  kind         "html" (page qui liste des liens) | "sitemap" (XML)
  url          URL, OU liste d'URLs candidates essayées dans l'ordre
               jusqu'à ce que l'une renvoie des résultats. Sert quand on
               n'est pas sûr du slug d'une page dossier.
  path_filter  fragment qui DOIT apparaître dans l'URL d'un épisode valide
               (peut être une liste : au moins un doit matcher)
  container    sélecteur CSS pour restreindre le scan à une zone (optionnel)
  paginate     True -> scrape page2, page3...
  page_pattern "slash" ({url}page2/) | "query" ({url}?page=2)
  max_pages    plafond de pagination (défaut 50)
  exclude      fragments d'URL à rejeter (bruit éditorial)
  emission_map [(fragment_url, nom_emission)] pour éclater une source en
               plusieurs émissions selon le slug

POURQUOI CERTAINES URLS SONT "CANDIDATES"
  Les régies Figaro / Le Point / La Tribune ne publient pas de flux RSS par
  rubrique. On passe donc par leurs pages dossier, dont le slug exact n'a pas
  pu être vérifié depuis l'environnement de dev (ces domaines bloquent les
  crawlers). Le scraper essaie chaque candidat et te dit lequel a marché :
      python scrape_openmedias.py --check
  Une fois le bon slug connu, réduis la liste à celui-là.
============================================================================
"""

# Bruit éditorial récurrent observé dans l'ancien export RSS (fichier xlsx) :
# les flux de rubrique mélangeaient advertorials et vraie rédaction.
NOISE = [
    "/le-scan-eco",
    "/flash-actu",
    "/flash-eco",
    "/live/",
    "/story/",
    "/videos/",
    "/en-direct",
    "/dossier/",
    "/podcast",
]

SOURCES = [
    # =====================================================================
    # NOUS — OpenMedias
    # =====================================================================
    dict(source="Nous", media="Capital", emission="Le rendez-vous des pros",
         kind="html",
         url="https://www.capital.fr/dossiers/le-rendez-vous-des-pros",
         path_filter="/entreprises-marches/",
         container="div.dossier-contentSection"),

    dict(source="Nous", media="TIME", emission="Business à succès",
         kind="html",
         url="https://www.timefrance.fr/business-a-succes/",
         path_filter="/business-a-succes/"),

    # Renommée à l'antenne "Vision d'Entreprises" (le slug d'URL, lui, n'a pas
    # bougé : toujours /focus-entreprises/ — cf. demande Donatien 2026-09-17).
    # Le catalogue existant (648 épisodes déjà scrapés sous l'ancien nom) a été
    # migré en une fois pour rester sur une seule émission continue plutôt que
    # de se retrouver splitté en deux entrées dans le radar.
    dict(source="Nous", media="BFM Business", emission="Vision d'Entreprises",
         kind="html",
         url="https://www.bfmtv.com/economie/professionnels/focus-entreprises/",
         path_filter="/focus-entreprises/",
         paginate=True, page_pattern="slash"),

    dict(source="Nous", media="Le Figaro", emission="Réussites d'entreprises",
         kind="html",
         url="https://www.lefigaro.fr/economie/dossier/reussites-d-entreprises",
         path_filter="/economie/",
         paginate=True, page_pattern="query", exclude=NOISE),

    # Média corrigé en BFM TV (et non BFM Business) le 2026-09-17, à la demande
    # de Donatien — "Entreprises d'Avenir" est bien une émission BFM TV (elle
    # vit sous une rubrique "BFM Pratique" partagée, mais le partenaire éditorial
    # est BFM TV, pas BFM Business), distincte de "Vision d'Entreprises" ci-dessus
    # qui, elle, est bien BFM Business. Sans ce fix les deux émissions
    # retombaient sous le même filtre média "BFM Business" côté radar.
    dict(source="Nous", media="BFM TV", emission="Entreprises d'avenir",
         kind="html",
         url="https://www.bfmtv.com/pratique/entreprises-d-avenir/",
         path_filter="/entreprises-d-avenir/",
         paginate=True, page_pattern="slash"),

    # Ajouts 2026-07-30 (demande Donatien) — 5 émissions OpenMedias.
    dict(source="Nous", media="BFM Business", emission="Perspectives d'entreprises",
         kind="html",
         url="https://www.bfmtv.com/economie/professionnels/perspectives-d-entreprises/",
         path_filter="/perspectives-d-entreprises/",
         paginate=True, page_pattern="slash"),

    dict(source="Nous", media="RMC Sport", emission="Les entreprises du sport",
         kind="html",
         url="https://rmcsport.bfmtv.com/services/les-entreprises-du-sport/",
         path_filter="/les-entreprises-du-sport/",
         paginate=True, page_pattern="slash"),

    # Même problème structurel que les autres dossiers Figaro : les articles
    # vivent sous /sports/<slug>-YYYYMMDD, indistingables de la rédaction
    # sportive par l'URL — seule la page dossier fait foi.
    dict(source="Nous", media="Le Figaro", emission="L'entreprise sportive de la semaine",
         kind="html",
         url="https://www.lefigaro.fr/sports/dossier/l-entreprise-sportive-de-la-semaine",
         path_filter="/sports/", url_must_match=r"-\d{8}$|/l-entreprise-sportive-de-la-semaine/.+-\d+$",
         paginate=True, page_pattern="query", exclude=NOISE),

    # Page quasi figée depuis 2023 côté CNEWS (6 liens, "corner partenaires") —
    # configurée quand même : si l'émission reprend, les nouveaux liens
    # seront ramassés. Pas d'exclude NOISE : 2 des 6 contenus sont des vidéos.
    dict(source="Nous", media="CNews", emission="Réussites d'entreprises",
         kind="html",
         url="https://www.cnews.fr/reussites-dentreprises",
         path_filter="/le-corner-partenaires/"),

    # DataDome (captcha JS) bloque requests ET cloudscraper, comme les deux
    # autres sources Le Point — KO en scrape direct. Configurée pour le jour
    # où le blocage est contourné (navigateur réel) ou levé.
    dict(source="Nous", media="Le Point", emission="Portraits d'entrepreneurs",
         kind="html",
         url="https://www.lepoint.fr/portraits_entrepreneurs/",
         path_filter="/portraits_entrepreneurs/",
         paginate=True, page_pattern="query", exclude=NOISE),

    # =====================================================================
    # CONCURRENTS — BFM Business (path_filter propre, déjà fiable)
    # =====================================================================
    dict(source="Concurrents", media="BFM Business", emission="#Decryptage",
         kind="html",
         url="https://www.bfmtv.com/economie/replay-emissions/hashtag-decryptage/",
         path_filter="/hashtag-decryptage/",
         paginate=True, page_pattern="slash"),

    dict(source="Concurrents", media="BFM Business",
         emission="Grand Angle paroles d'entreprises",
         kind="html",
         url="https://www.bfmtv.com/economie/replay-emissions/grand-angle-paroles-d-entreprises/",
         path_filter="/grand-angle-paroles-d-entreprises/",
         paginate=True, page_pattern="slash"),

    dict(source="Concurrents", media="BFM Business", emission="Impact PME l'hebdo",
         kind="html",
         url="https://www.bfmtv.com/economie/replay-emissions/impact-pme-l-hebdo/",
         path_filter="/impact-pme-l-hebdo/",
         paginate=True, page_pattern="slash"),

    dict(source="Concurrents", media="BFM Business", emission="Trajectoire",
         kind="html",
         url="https://www.bfmtv.com/economie/replay-emissions/trajectoire/",
         path_filter="/trajectoire/",
         paginate=True, page_pattern="slash"),

    dict(source="Concurrents", media="BFM Business", emission="#JMLATECH",
         kind="html",
         url="https://www.bfmtv.com/economie/replay-emissions/hashtag-jmlatech/",
         path_filter="/hashtag-jmlatech/",
         paginate=True, page_pattern="slash"),

    dict(source="Concurrents", media="BFM Business", emission="#JMLECO",
         kind="html",
         url="https://www.bfmtv.com/economie/replay-emissions/hashtag-jmleco/",
         path_filter="/hashtag-jmleco/",
         paginate=True, page_pattern="slash"),

    dict(source="Concurrents", media="BFM Business", emission="Objectif Croissance",
         kind="html",
         url=["https://www.bfmtv.com/economie/replay-emissions/objectif-croissance/",
              "https://www.bfmtv.com/economie/objectif-croissance/"],
         path_filter="/objectif-croissance/",
         paginate=True, page_pattern="slash"),

    # =====================================================================
    # CONCURRENTS — Le Point
    #   path_filter très propre : /stories/ = 100 % brand content (régie).
    #   Vérifié sur les 66 URLs de l'ancien export : aucun faux positif.
    # =====================================================================
    dict(source="Concurrents", media="Le Point", emission="Le Point Stories",
         kind="html",
         url=["https://www.lepoint.fr/stories/",
              "https://www.lepoint.fr/stories"],
         path_filter="/stories/",
         paginate=True, page_pattern="query", exclude=NOISE),

    # Le Point /services/ regroupe plusieurs opérations de la régie.
    # On éclate par slug : MasterClass d'un côté, le reste en "Le Point Services".
    dict(source="Concurrents", media="Le Point", emission="Le Point Services",
         kind="html",
         url=["https://www.lepoint.fr/services/",
              "https://www.lepoint.fr/services"],
         path_filter="/services/",
         paginate=True, page_pattern="query", exclude=NOISE,
         emission_map=[
             ("interview-masterclass", "MasterClass avec Michel Denisot"),
             ("masterclass",           "MasterClass avec Michel Denisot"),
         ]),

    # Sonde de fraîcheur : le flux podcast Apple/Anchor de la MasterClass.
    # Ne remplace pas le scrape (pas d'URL article) mais détecte les sorties.
    dict(source="Concurrents", media="Le Point", emission="MasterClass avec Michel Denisot",
         kind="sitemap",
         url="https://www.lepoint.fr/sitemap_news.xml",
         path_filter=["/services/interview-masterclass", "/stories/"],
         optional=True),

    # =====================================================================
    # CONCURRENTS — La Tribune
    #   Tout le brand content vit sous /article/partenaires/ (vérifié sur
    #   les 45 URLs #JMLATECH de l'ancien export).
    # =====================================================================
    dict(source="Concurrents", media="La Tribune", emission="La Tribune - Partenaires",
         kind="html",
         url=["https://www.latribune.fr/article/partenaires/",
              "https://www.latribune.fr/partenaires/",
              "https://www.latribune.fr/article/partenaires"],
         path_filter="/article/partenaires/",
         paginate=True, page_pattern="query", exclude=NOISE,
         emission_map=[
             ("/la-technologie-pour-un-monde-meilleur", "#JMLATECH"),
             ("/jmlatech",                              "#JMLATECH"),
             ("/jmleco",                                "#JMLECO"),
         ]),

    # =====================================================================
    # CONCURRENTS — Le Figaro
    #   PROBLÈME STRUCTUREL : les advertorials Figaro vivent sous /economie/
    #   et /lifestyle/ avec la même forme d'URL que la vraie rédaction
    #   (/economie/<slug>-YYYYMMDD). Aucun path_filter ne peut les isoler.
    #   -> seule voie : la page dossier de chaque émission. Slugs à confirmer
    #      via `--check` (plusieurs candidats essayés).
    # =====================================================================
    dict(source="Concurrents", media="Le Figaro", emission="Focus Business",
         kind="html",
         url=["https://www.lefigaro.fr/economie/dossier/focus-business",
              "https://www.lefigaro.fr/economie/dossier/focus-business-entreprises",
              "https://www.lefigaro.fr/dossier/focus-business"],
         path_filter=["/economie/", "/lifestyle/"],
         paginate=True, page_pattern="query", exclude=NOISE),

    dict(source="Concurrents", media="Le Figaro", emission="Regards de Dirigeants",
         kind="html",
         url=["https://www.lefigaro.fr/economie/dossier/regards-de-dirigeants",
              "https://www.lefigaro.fr/dossier/regards-de-dirigeants"],
         path_filter=["/economie/", "/lifestyle/"],
         paginate=True, page_pattern="query", exclude=NOISE),

    dict(source="Concurrents", media="Le Figaro", emission="Portraits d'Entreprises",
         kind="html",
         url=["https://www.lefigaro.fr/lifestyle/dossier/portraits-d-entreprises",
              "https://www.lefigaro.fr/economie/dossier/portraits-d-entreprises",
              "https://www.lefigaro.fr/dossier/portraits-d-entreprises"],
         path_filter=["/lifestyle/", "/economie/"],
         paginate=True, page_pattern="query", exclude=NOISE),
]
