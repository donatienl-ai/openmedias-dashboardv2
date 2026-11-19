# OpenDashboard · OpenMedias

Dashboard temps réel de la performance commerciale OpenMedias. Reprend les mêmes KPIs que le reporting quotidien Make, mais en consultation live via une interface web.

Backend Node/Express (détient les clés API et fait les appels), frontend React, protégé par mot de passe.

**Fusion des 3 outils sous un seul domaine** : ce service sert aussi **OpenPlanning** (planning de diffusion) et **OpenBDC** (générateur de bons de commande), montés sous `/planning` — voir la section [OpenPlanning + OpenBDC](#openplanning--openbdc-fusionnés) plus bas. Un seul système de comptes (email + mot de passe, table `commercial_users`) : les commerciaux se connectent une fois et accèdent aux deux, sans se reconnecter. Un compte commercial non-admin ne voit que ses propres chiffres sur le dashboard ; les comptes admin (toi + managers) voient toute l'équipe, comme avant.

---

## Ce que ça affiche

- **Calls du jour** (Aircall)
- **R1 / R2 du jour** = rendez-vous qui ont lieu aujourd'hui (Calendly)
- **R1 / R2 pris aujourd'hui** = rendez-vous bookés aujourd'hui, peu importe leur date (Calendly)
- **Propals envoyées aujourd'hui** (Salesforce, Lead Status = Working)
- **Signatures du jour** + montants (Salesforce, Opportunity Closed Won)
- **CA du mois** détaillé par commercial (Salesforce)
- **RDV via SalesForge** cumul all-time (Google Sheets, colonne UTM Source)

---

## Prérequis pour les clés API

### Aircall
Settings → Integrations → API Keys. Récupère l'**API ID** et l'**API Token**.

### Calendly
Le **Personal Access Token** que tu utilises déjà dans Make (Integrations → API & Webhooks). L'URI d'organisation est déjà pré-rempli.

### Salesforce (Username-Password OAuth)
1. Setup → App Manager → ta Connected App (ou crées-en une) → récupère **Consumer Key** et **Consumer Secret**.
2. Dans la Connected App, OAuth Scopes : ajoute au moins `api` et `refresh_token`.
3. **Security Token** : Settings → Reset My Security Token (reçu par email).
4. Login URL : `https://login.salesforce.com` (prod) ou `https://test.salesforce.com` (sandbox).

### Google Sheets (optionnel, pour SalesForge)
1. Google Cloud Console → crée un projet → active **Google Sheets API**.
2. Credentials → Create API Key.
3. La Sheet doit être lisible par l'API : soit "Anyone with the link (Viewer)", soit partagée. (Avec une simple API Key, la Sheet doit être en lecture publique par lien.)

Si tu ne renseignes pas les clés Google, la section SalesForge affichera simplement 0 (le reste fonctionne).

---

## Lancer en local

```bash
# 1. Installer les dépendances backend
npm install

# 2. Installer + builder le front
cd client && npm install && npm run build && cd ..

# 3. Copier le modèle d'env et le remplir
cp .env.example .env
# (édite .env avec tes vraies clés)

# 4. Démarrer
npm start
```

Le dashboard est sur `http://localhost:3001`.

Pour le développement du front avec hot-reload, dans un 2e terminal :
```bash
cd client && npm start
```
(le front tournera sur :3000 et proxyfiera l'API vers :3001)

---

## Déployer sur Render

**Au quotidien, une seule commande suffit** : `npm run deploy -- "message de commit"` (add + commit + push). Render rebuild et redéploie automatiquement à chaque push sur `main` (~3-5 min) — aucune action manuelle sur le dashboard Render. Si ça ne redéploie pas tout seul : onglet **Settings → Build & Deploy → Auto-Deploy** doit être sur *Yes*.
Astuce : pour régler du visuel, teste d'abord en local (`npm run dev` côté serveur + `cd client && npm start` pour le hot-reload React) et ne push qu'une fois satisfait — ça évite les allers-retours de rebuild.

⚠️ Depuis la fusion avec OpenPlanning/OpenBDC, ce service a besoin d'un **disque persistant** (base SQLite du planning) et d'un plan **payant** (le free tier n'a pas de disque, et la RAM sera juste avec SQLite + Puppeteer/Chromium en plus du cache Aircall/Calendly). `render.yaml` est déjà à jour avec ça (`plan: standard`, disque `/var/data`).

### Si le service `openmedias-dashboard` existe déjà sur Render (cas de la bascule)

Un service existant créé avant la fusion n'a ni disque ni les nouvelles variables d'environnement — `git push` seul ne suffit pas à les ajouter :

1. Onglet **Disks** du service → *Add Disk* → nom `planning-db`, mount path `/var/data`, 1 Go.
2. Onglet **Environment** → ajoute toutes les nouvelles variables listées dans `.env.example` sous "OPENPLANNING + OPENBDC" (`PIN_EDIT`, `PIN_COM`, `PIN_EVA`, `PIN_FLAVIE`, `PIN_CLEVEL`, `EMAIL_EVA`, `EMAIL_FLAVIE`, `EMAIL_CLEVEL`, `EMAIL_ADMIN`, `SF_WEBHOOK_SECRET`, `DB_PATH=/var/data/planning.db`) — reprends les mêmes valeurs que sur le service `planning-diffusion` actuel.
3. **Ajoute aussi `NODE_VERSION=20.18.1`** (onglet Environment). Sans ça, Render utilise sa version Node par défaut (très récente) sur laquelle `better-sqlite3` ne compile pas (erreur `npm error ... class CS has no member named ...` au build). Le `engines.node` du `package.json` pointe déjà vers `20.x`, mais si ton service existant ignore ce champ, la variable d'env force la bonne version.
4. Si le plan actuel est **Free**, passe sur un plan payant (nécessaire pour le disque, et probablement pour la RAM).
5. Redeploy (Manual Deploy → Deploy latest commit) une fois le disque et les variables en place.
6. Surveille les logs après le premier `POST /api/bdc/generate` ou `/planning` : c'est le moment où Puppeteer/Chromium consomment le plus de mémoire.

### Nouveau service (via Blueprint)

1. Pousse ce dossier sur un repo GitHub (privé de préférence).
2. Sur [render.com](https://render.com) → New → Blueprint → connecte ton repo.
3. Render lit `render.yaml` et crée le service (avec disque) automatiquement.
4. Dans l'onglet **Environment**, remplis toutes les variables marquées `sync: false`.
5. Deploy. L'URL publique apparaît (genre `https://openmedias-dashboard.onrender.com`).

### Note sur le webhook Salesforce du planning
Si tu bascules l'URL Render du planning, mets à jour l'URL du webhook Salesforce (`/api/webhook/salesforce`) pour qu'il pointe vers `https://<ton-domaine>/planning/api/webhook/salesforce` (le chemin change : `/planning` en préfixe).

---

## Vérifications avant de pousser

Une CI GitHub Actions (`.github/workflows/ci.yml`) tourne sur chaque push/PR
vers `main` : vérifie la syntaxe de tous les fichiers serveur, build le client
React (aurait détecté le bug `Module not found: Can't resolve './calendly.js'`
déjà rencontré), puis démarre le serveur et vérifie que `/api/health` répond.
En local, les mêmes vérifications sont disponibles via :

```bash
npm run check   # syntaxe de tous les fichiers server/ + planning/backend/
npm run smoke   # démarre le serveur (clés API factices) et vérifie /api/health
```

Diagnostic des caches en prod (réservé admin) : `GET /api/admin/cache` (depuis
un compte admin connecté) renvoie l'âge/couverture de chaque cache —
dashboard, Aircall, Salesforce, Calendly, DocuSign — et un ping SQLite sur la
base du planning. `GET /api/health` reste le endpoint léger pour le pinger
(UptimeRobot), avec juste mémoire/uptime en plus.

## Sécurité

- Les clés vivent **uniquement** dans les variables d'environnement Render (ou le `.env` local), jamais dans le code.
- Le `.env` est git-ignoré : il ne partira jamais sur GitHub.
- L'accès au dashboard est protégé par `DASHBOARD_PASSWORD`.
- Pense à mettre un mot de passe fort.

---

## Architecture

```
client/          → React (interface)
  src/App.js     → composant principal (login + dashboard)
  src/styles.css → design OpenMedias
server/          → Express (API)
  index.js       → serveur + route /api/dashboard
  aircall.js     → connecteur Aircall
  calendly.js    → connecteur Calendly (logique R1/R2)
  salesforce.js  → connecteur Salesforce (SOQL)
  sheets.js      → connecteur Google Sheets (SalesForge)
```

Le front appelle `/api/dashboard`, le backend interroge les 4 sources en parallèle et renvoie un JSON agrégé. Si une source plante, les autres s'affichent quand même (erreur partielle signalée en haut).

---

## OpenPlanning + OpenBDC (fusionnés)

`planning/` contient le planning de diffusion et le générateur de BDC, montés sous `/planning` dans ce même service (plus de domaine séparé) :

```
planning/
  backend/
    package.json   → {"type":"commonjs"} : permet à ce code CommonJS d'être
                      importé tel quel depuis server/index.js (ESM), sans
                      renommer les fichiers en .cjs
    router.js       → ex-server.js du planning, converti en express.Router()
    db.js           → SQLite (better-sqlite3) : émissions, comptes commerciaux...
    auth.js         → hash/vérif mot de passe + lookup commercial_users,
                      PARTAGÉ avec server/index.js (un seul système de comptes)
    salesforce.js   → connecteur SF du planning (Opportunités + import Piste BDC)
    reports.js      → reporting email planning (Mailjet)
    bdc/            → moteur BDC (Handlebars + Puppeteer/@sparticuz/chromium),
                      templates (Figaro, BFM Business, Capital), assets
  frontend/
    index.html      → front vanilla JS du planning (un seul fichier), servi
                      statiquement sous /planning
```

`server/index.js` importe `planning/backend/router.js` via `import(...)` dynamique et le monte sur `/planning` (donc ses routes internes `/api/...` deviennent `/planning/api/...`), avant le catch-all React du dashboard. `server/scopeByCommercial.js` filtre la réponse de `/api/dashboard` pour qu'un compte commercial non-admin ne voie que ses propres chiffres (basé sur `roster.js`, qui rattache déjà un nom brut à un commercial pour les autres connecteurs).

Le service `bdc-generator.onrender.com` (version standalone du générateur de BDC) reste déployé en parallèle, indépendant — les deux copies du moteur BDC ne se synchronisent pas automatiquement (répercute manuellement toute correction de template des deux côtés). Idem pour `planning-diffusion.onrender.com`, qui continue de tourner tel quel tant que la bascule n'est pas validée.

---

## Évolutions possibles (v2)

- ~~Multi-utilisateurs avec rôles~~ ✅ fait (comptes commerciaux + admin)
- ~~Filtres par commercial~~ ✅ fait (scoping automatique par compte connecté)
- Auto-refresh périodique (toutes les X minutes)
- Graphiques d'évolution (CA mensuel, tendance hebdo)
- Historique et comparaison de périodes
- Panneau in-app pour gérer les comptes commerciaux / le flag admin (aujourd'hui : PATCH direct sur `/planning/api/admin/commerciaux/:id`)

---

## Export OpenStudio (lecture seule)

`GET /planning/api/openstudio/diffusions` renvoie les diffusions **vidéo** du planning (formats `Plateau TV` et `Immersion` par défaut, modifiables avec `OPENSTUDIO_FORMATS`), avec leur statut et l'e-mail du client : le signataire du bon de commande DocuSign envoyé depuis le dashboard (BDC signé en priorité), à défaut le contact de l'opportunité Salesforce (contact principal en priorité, lu par l'API Salesforce, cache de 6 h ; si Salesforce ne répond pas, l'export part sans ces e-mails). OpenStudio s'en sert pour créer les espaces clients, les codes de connexion et le mail du jour de diffusion.

- **Lecture seule** : la route ne fait que des `SELECT`, rien n'est modifié dans le planning.
- **Accès** : en-tête `X-OpenStudio-Key` égal à la variable `OPENSTUDIO_EXPORT_KEY` (même valeur côté OpenStudio). Sans cette variable, la route répond 503.
- Paramètres facultatifs : `from=AAAA-MM-JJ` (défaut : il y a 90 jours ; les diffusions « à programmer » sont toujours incluses) et `since=<horodatage>` (seulement les lignes modifiées depuis).

```bash
curl https://<dashboard>/planning/api/openstudio/diffusions -H "X-OpenStudio-Key: $OPENSTUDIO_EXPORT_KEY"
```
