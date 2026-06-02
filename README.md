# OpenMedias · Sales Dashboard

Dashboard temps réel de la performance commerciale OpenMedias. Reprend les mêmes KPIs que le reporting quotidien Make, mais en consultation live via une interface web.

Backend Node/Express (détient les clés API et fait les appels), frontend React, protégé par mot de passe.

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

## Déployer sur Render (gratuit)

### Méthode A — via Blueprint (le plus simple)

1. Pousse ce dossier sur un repo GitHub (privé de préférence).
2. Sur [render.com](https://render.com) → New → Blueprint → connecte ton repo.
3. Render lit `render.yaml` et crée le service automatiquement.
4. Dans l'onglet **Environment**, remplis toutes les variables marquées `sync: false` (tes clés).
5. Deploy. L'URL publique apparaît (genre `https://openmedias-dashboard.onrender.com`).

### Méthode B — manuelle

1. Repo GitHub.
2. Render → New → Web Service → connecte le repo.
3. Configure :
   - **Build Command** : `npm install && npm run build`
   - **Start Command** : `npm start`
   - **Plan** : Free
4. Onglet Environment → ajoute toutes les variables du `.env.example`.
5. Create Web Service.

### Note sur le free tier Render
Le service s'endort après 15 min sans trafic. Le premier accès après une pause prend ~30 secondes à se réveiller. C'est normal et sans impact pour un usage interne ponctuel.

---

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

## Évolutions possibles (v2)

- Auto-refresh périodique (toutes les X minutes)
- Graphiques d'évolution (CA mensuel, tendance hebdo)
- Filtres par commercial / par média
- Historique et comparaison de périodes
- Multi-utilisateurs avec rôles
