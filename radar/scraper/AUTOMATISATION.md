# Radar éditorial — automatisation et intégration

Le radar est un onglet d'OpenDashboard, servi sous `/radar`, dont le catalogue se
remplit tout seul deux fois par jour.

---

## Où vit quoi

| Chemin | Rôle |
|---|---|
| `radar/frontend/index.html` | le site (HTML autonome, aucun build) |
| `radar/frontend/catalogue.json` | **généré** — ne pas éditer à la main |
| `radar/frontend/embeddings.json` | **généré** — ne pas éditer à la main |
| `radar/scraper/sources.py` | **la seule chose à éditer** pour ajouter/corriger une émission |
| `radar/scraper/scrape_openmedias.py` | fetch, parsing, merge, embeddings |
| `radar/scraper/classify.py` | classification sectorielle |
| `.github/workflows/radar-update.yml` | le robot (2x/jour) |
| `server/index.js` | monte `/radar` en statique (même patron que `/planning`) |

Même architecture que le planning : un front autonome servi en statique, pas de
build, pas d'API dédiée. Le radar est 100 % client — il lit les deux JSON et
calcule les scores dans le navigateur.

---

## Ce qui tourne tout seul

| Quoi | Quand |
|---|---|
| Scrape des 19 sources + merge + commit | 5h et 12h UTC (7h / 14h Paris l'été, 6h / 13h l'hiver) |
| Redéploiement Render | automatique, sur push |

S'il n'y a rien de neuf, aucun commit n'est fait et Render ne redéploie pas. Le
message de commit porte `[skip ci]` : seuls des fichiers de données changent, pas
la peine de relancer le build React et le smoke test de `ci.yml`.

---

## À FAIRE UNE FOIS : valider les sources concurrentes

Neuf sources concurrentes utilisent des URLs de pages dossier que je n'ai pas pu
vérifier : Le Figaro, Le Point et La Tribune bloquent les crawlers d'IA. Depuis
un runner GitHub ou ton poste, elles répondent normalement.

**Sans terminal** : repo GitHub → **Actions** → *Radar — mise à jour du
catalogue* → **Run workflow** → mode `check`. Le tableau des 19 sources s'affiche
dans le récapitulatif du run, et les pages de diagnostic sont téléchargeables en
artefact.

**Depuis ton poste**, si tu préfères :

```bash
cd radar/scraper
python -m pip install -r requirements.txt
python scrape_openmedias.py --check
```

Pour chaque ligne `KO` :

1. Ouvre l'URL dans ton navigateur.
2. Si la page existe sous un autre slug → corrige la liste `url` de la source
   dans `sources.py`. Chaque source accepte plusieurs candidates, essayées dans
   l'ordre :
   ```python
   url=["https://www.lefigaro.fr/economie/dossier/le-vrai-slug",
        "https://www.lefigaro.fr/economie/dossier/focus-business"],
   ```
3. Si la page répond mais qu'aucun lien n'est retenu, un `debug_<emission>.html`
   est écrit à côté du scraper : c'est le `path_filter` qu'il faut ajuster.

### Le cas Le Figaro

Les advertorials Figaro (`Focus Business`, `Regards de Dirigeants`,
`Portraits d'Entreprises`) vivent sous `/economie/` et `/lifestyle/` avec
exactement la même forme d'URL que les articles de la rédaction :
`/economie/<slug>-YYYYMMDD`. **Aucun filtre d'URL ne peut les distinguer.** La
page dossier de chaque émission est le seul point d'entrée fiable.

C'est ce qui polluait l'ancien export : les flux RSS étaient des flux de
rubrique, pas d'émission. L'article « Sébastien Lecornu annonce 500 contrôles
dans les stations-service » s'y retrouvait classé à la fois en *Portraits
d'Entreprises* et en *Regards de Dirigeants*. Le scraper filtre maintenant ce
bruit (`NOISE` dans `sources.py`).

---

## À FAIRE UNE FOIS : récupérer l'historique concurrent

Le catalogue s'arrête début juin pour les concurrents (il venait du xlsx). Pour
réinjecter l'historique en filtrant le bruit :

```bash
cd radar/scraper
python scrape_openmedias.py --xlsx "RSS Scraping Concu.xlsx" --embeddings
```

À ne lancer qu'une fois.

---

## Ce que fait le merge

Le catalogue n'est **plus jamais écrasé**. À chaque run :

- fusion par URL — un épisode connu est conservé, ses champs vides complétés
  (vignette, date) sans écraser ce qui existe ;
- un épisode inconnu est ajouté avec `first_seen` = date du jour ;
- **rien n'est supprimé** — si BFM dépublie une page, elle reste dans le radar.

`first_seen` alimente l'onglet **Nouveautés** et les badges « Nouveau » (fenêtre
7 jours). Les 2838 entrées antérieures portent leur date de publication comme
`first_seen`, ou `legacy` si inconnue : elles n'apparaîtront jamais comme neuves.

### Garde-fou

Si un run récupère **0 épisode** alors que le catalogue en contient déjà, le
script sort en code 2 sans rien écrire et le workflow échoue pour te notifier.
C'est le scénario « les médias ont blacklisté l'IP des runners GitHub » : mieux
vaut une alerte qu'un catalogue vidé. Dans ce cas, il faudra faire tourner le
scrape ailleurs (tâche planifiée sur ton poste, ou petit VPS) et pousser.

---

## Recherche sémantique — elle était éteinte

À noter, parce que ce n'était pas visible : **le mode sémantique n'a jamais
fonctionné.** Le front attendait des vecteurs dans `catalogue.json` (champ
`emb`), or il n'y en avait aucun. Le radar tournait en TF-IDF pur depuis le
début, et le badge 🧠 restait masqué.

Maintenant :

- le robot écrit les vecteurs dans `embeddings.json`, quantifiés int8 + base64
  (~1,5 Mo au lieu de ~9 Mo en JSON de flottants) ;
- seuls les **nouveaux** épisodes sont encodés à chaque run ;
- le front charge ce fichier **après** le premier rendu : la page s'affiche
  immédiatement en TF-IDF puis bascule en sémantique ;
- si `embeddings.json` manque, est corrompu, ou si le CDN de transformers.js est
  bloqué par le réseau de l'entreprise, la recherche retombe proprement en
  TF-IDF. Le radar ne casse pas.

---

## Intégration dans OpenDashboard

- **Navigation** : bouton 📡 Radar dans l'`app-switch` des trois apps
  (`client/src/App.js`, `planning/frontend/index.html`,
  `radar/frontend/index.html`). Ouvert à tous les rôles, y compris
  communication.
- **Thème** : le radar lit et écrit la clé localStorage `theme` (défaut
  `light`), exactement comme le dashboard et le planning. Basculer sombre/clair
  dans un onglet suit l'utilisateur dans les deux autres.
- **Session** : même origine, donc `commercialId` / `om_cred` sont déjà
  partagés — aucun re-login en changeant d'onglet.
- **Tokens de DA** : recopiés à l'identique de `client/src/styles.css`, mêmes
  noms et mêmes valeurs. Un test échoue si les deux fichiers divergent (voir
  `testDesignTokenParity`).
- **Effet de bord corrigé** : le planning masquait toute l'`app-switch` pour
  édito et communication (une seule destination, barre à moitié vide). Avec le
  Radar, ces rôles ont deux destinations réelles — la barre reste affichée.
- **404 sous /radar** : un fichier manquant traversait le static et atterrissait
  dans le catch-all React, renvoyant un HTTP 200 contenant le HTML du dashboard.
  Un middleware renvoie maintenant un vrai 404.

### Point d'attention : pas d'authentification sur `/radar`

`express.static` sert `radar/frontend/` sans contrôle d'accès. Quiconque connaît
l'URL peut lire `/radar/catalogue.json`, qui contient toute la veille
concurrentielle. Ce n'est pas une régression (le radar était déjà déployé en site
statique public), mais c'est désormais sur le domaine de l'outil interne.

Si tu veux fermer ça, le plus simple est un middleware `requireAuth` devant le
static, sur le modèle des routes `/api` — à décider, ça change le comportement
pour les comptes non connectés.

---

## Tests

```bash
npm run test:radar            # 122 assertions — index.html dans jsdom
npm run test:radar:scraper    # 144 assertions — parsing, dates, merge, embeddings
```

`npm run test:radar` tourne aussi dans `ci.yml` à chaque push, et
`test_scraper.py` avant chaque scrape : une régression sur le merge bloque le run
avant qu'il touche au catalogue.

Ce que les tests couvrent en particulier :

- les dates BFM à double horodatage
  (`video-20251219-...-agc_VN-202601140811`) — le slug est la date de diffusion,
  `_VN-` n'est que l'identifiant du CMS ;
- les identifiants numériques longs de La Tribune, qui ne doivent pas être lus
  comme des dates ;
- l'idempotence du merge (rejouer le même scrape n'ajoute rien) ;
- l'aller-retour de quantification des vecteurs entre Python et le navigateur,
  signe négatif compris ;
- la dégradation propre quand `embeddings.json` manque ou ne correspond pas au
  catalogue ;
- la parité des tokens de DA entre le radar et le dashboard.

---

## Ajouter une émission

Un dict dans `sources.py`, rien d'autre :

```python
dict(source="Concurrents", media="Challenges", emission="Nom de l'émission",
     kind="html",
     url="https://www.challenges.fr/dossier/nom-de-l-emission",
     path_filter="/entreprise/",
     paginate=True, page_pattern="query", exclude=NOISE),
```

Puis `python scrape_openmedias.py --check` avant de pousser.
