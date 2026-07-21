# Audit UI / UX / Ergonomie — OpenDashboard + OpenPlanning

Fait le 21/07/2026, en conditions réelles sur `openmedias-sales-dashboard.onrender.com` (login, `/planning` en tant que compte Admin, calendrier, liste, reporting, paramètres) + lecture du code (`App.js`, `styles.css`, `planning/frontend/index.html`).

Je n'ai pas pu me connecter côté dashboard (pas d'identifiants) — l'audit de l'écran principal du dashboard (KPI, vue TV) reste donc basé sur le code. Dis-moi si tu veux que je pousse plus loin une fois connecté toi-même dans l'onglet.

## Le problème de fond : deux apps qui ne se ressemblent pas

C'est probablement la plus grosse source de "pas ouf" : le dashboard (React, cards arrondies, police système, thème sombre par défaut) et le planning (HTML/JS custom, sections en `MAJUSCULES ESPACÉES`, thème clair par défaut, boutons pleine largeur) sont deux langages visuels différents. Depuis la fusion, on passe de l'un à l'autre via les nouveaux onglets — le changement de style à chaque bascule est brutal et donne l'impression de deux outils recollés plutôt qu'un seul produit. Unifier une charte commune (typo, rayons de bordure, taille des boutons, palette) serait le chantier avec le plus d'impact perçu, mais aussi le plus long — à traiter en dernier, une fois les points ci-dessous réglés.

## Top 5 à corriger en premier (rapport effort/impact)

1. **Accès aux Paramètres planning caché derrière un raccourci clavier secret** (`Ctrl/Cmd+Alt+R`) — même le compte Admin ne voit "Reporting" et "Paramètres" nulle part dans la nav tant qu'il ne connaît pas ce raccourci. Avec la fusion des deux backends admin faite cette semaine, c'est maintenant LE seul endroit pour gérer comptes/rôles/équipes/reporting — il ne devrait plus être caché. Fix simple : afficher ces onglets directement pour `role==='edit'` (comme les autres éléments `.edit-only`), garder le raccourci en bonus si tu y tiens.
2. **Modale "Diffusions cette semaine" qui s'auto-ouvre à chaque chargement** de `/planning` — sur le calendrier, il faut la fermer avant de pouvoir toucher à quoi que ce soit. Gênant sur un outil qu'on rouvre plusieurs fois par jour. À transformer en widget qu'on ouvre volontairement (ex: bouton dans la topbar), pas en interruption systématique.
3. **Icônes emoji qui ne s'affichent pas correctement** — vérifié en live : l'icône ✉️ ("renvoyer l'invitation" dans Comptes) s'affiche comme un carré blanc vide sur Chrome/Windows, dans les deux thèmes. Les emoji comme icônes fonctionnelles dépendent de la police du système d'exploitation et ne sont pas fiables cross-plateforme. À terme, un petit set d'icônes SVG (ou une lib comme lucide-react, déjà dispo côté dashboard) réglerait ça définitivement pour toutes les icônes de l'appli, pas juste celle-ci.
4. **Boutons à largeur incohérente sur le même écran** — dans Paramètres planning, "Enregistrer" (horizon), "Importer" (Salesforce) et "+ Ajouter" (équipes) s'étirent sur toute la largeur disponible, alors que "Sauvegarder" du nouveau bloc Reporting est en taille normale, juste à côté. Sur un écran large ça fait des boutons démesurés à côté de boutons normaux. Fix : donner un `max-width` raisonnable à tous les boutons d'action (type `160-220px`), qu'ils soient dans une `form-row` pleine largeur ou non.
5. **Badge de rôle qui affiche toujours "Édito" pour les comptes Admin** — vérifié en live avec ton propre compte (rôle réel = Admin) : le badge en haut à gauche du planning affiche "ÉDITO", pas "ADMIN". C'est une simplification du code (admin et édito partagent le même mode interne "edit") mais ça peut semer le doute sur le fait d'être bien connecté avec les bons droits. Fix rapide : garder une distinction visuelle admin/édito sur le badge uniquement (le reste du comportement peut rester identique).

## Autres points relevés

**Écran de connexion (dashboard, `/`)**
- Carte de login très petite, flottant seule au milieu d'un immense fond dégradé vide — fonctionnel mais austère, aucun repère de marque (logo, illustration). Sur un grand écran ça fait "page de test" plus que produit fini.
- Deux liens sous le bouton principal ("Mot de passe unique (admin)" en noir souligné, "Accès édito par code (ancien système)" en violet souligné) ont un traitement visuel différent l'un de l'autre sans raison apparente, et sont juste posés là sans distinction "c'est un mode de secours". Un simple lien discret style "Autres options de connexion ▾" qui déplie les deux choix serait plus propre.
- Les placeholders des champs (Email / Mot de passe) sont assez pâles — lisibles mais en dessous du niveau de contraste confortable.

**Planning — calendrier / liste**
- La vue Liste (tableau des diffusions) est le meilleur écran de l'appli actuellement : dense mais clair, bons chips de KPI en tête, filtres par colonne bien pensés. À prendre comme référence de style pour le reste.
- Petit artefact visuel observé après fermeture de la modale hebdo : un bord de panneau blanc arrondi reste visible furtivement en haut à droite avant de disparaître complètement à la navigation suivante — sent la transition CSS pas totalement terminée (z-index ou opacity qui traîne). Mineur, mais à surveiller si ça devient plus visible sur certains écrans/navigateurs.
- Les nouveaux onglets "📊 Dashboard / 📅 Planning" (ajoutés cette semaine) : pour un compte édito/communication, seul "Planning" s'affiche, dans une barre qui prend toute la largeur — ça laisse un unique pavé actif avec beaucoup de vide à droite, on dirait un élément à moitié cassé plutôt qu'un choix voulu. Pour ces rôles qui n'ont vraiment rien à faire sur le dashboard, masquer complètement la barre d'onglets (au lieu de juste cacher le bouton Dashboard) donnerait un résultat plus propre.

**Paramètres (planning)**
- Beaucoup d'intitulés de section en MAJUSCULES avec letter-spacing (ex. "VISIBILITÉ CÔTÉ COMMERCIAL", "ÉQUIPES ÉDITO") — lourd visuellement à la longue sur un écran qui contient déjà 6-7 blocs empilés. Une capitalisation normale + une icône ou une couleur d'accent suffirait à structurer sans crier.
- Les selects de rôle/équipe dans le tableau "Comptes créés" n'ont pas de label visible au-dessus (seulement un `title` au survol) — sur un tableau à 3 selects par ligne, il faut deviner ou survoler chaque colonne pour comprendre à quoi elle sert. Des en-têtes de colonnes fixes réduiraient la charge cognitive.
- Densité d'information très élevée sur cette page (tout empilé verticalement, pas de sous-navigation) — avec l'ajout du nouveau bloc "OpenDashboard" cette semaine, la page est maintenant longue. Un sommaire latéral ou des sous-onglets (Visibilité / Équipes / Comptes / Reporting dashboard) aiderait à s'y retrouver plutôt que de tout scroller.

**Cohérence générale**
- Le planning est en thème clair par défaut, le dashboard en thème sombre par défaut (`localStorage.getItem('om_theme') || 'dark'`) — première impression différente selon par où on entre, sans lien entre les deux préférences (changer le thème d'un côté n'affecte pas l'autre).
- Aucune erreur JS applicative détectée en navigation live (juste du bruit d'extensions Chrome, sans rapport avec le site) — bon signe côté stabilité.

## Ce que j'ai corrigé au passage

En testant en live j'ai trouvé un vrai trou dans la SSO qu'on avait mise en place : le dashboard restaure sa session depuis `sessionStorage` (propre à un onglet), alors que le planning restaure la sienne depuis `localStorage` (partagé). Résultat : ouvrir `/` dans un nouvel onglet pendant qu'on est connecté sur `/planning` renvoyait quand même à l'écran de login, contrairement à l'objectif "pas de re-login" qu'on visait. J'ai ajouté la même logique de restauration silencieuse (`/api/auth/me`) côté dashboard — vérifié par un build React complet ("Compiled successfully"). Il faudra juste redéployer pour que ce soit actif en prod.

## Suggestion de méthode

Plutôt que de tout attaquer d'un coup, je proposerais : (1) les 5 points prioritaires ci-dessus — petits, rapides, gros gain perçu ; (2) une passe d'harmonisation visuelle légère (mêmes rayons de bordure, mêmes tailles de bouton, même police de titres) sans toucher à la structure ; (3) si après ça tu sens encore que "ça fait pas pro", on regarde une refonte plus profonde d'un des deux écrans (probablement Paramètres planning, le plus chargé).
