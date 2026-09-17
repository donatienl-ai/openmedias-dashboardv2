# Audit UX/UI — Recouvrement (v2 : deep dive + alignement DA)

Ce document remplace la v1 (audit initial). La quasi-totalité de la v1 a été livrée depuis (donut, deltas vs période N-1, sous-navigation Vue d'ensemble/Factures/Litiges, tri des colonnes, filtre calendrier libre, échéance éditable, couleurs par statut sur les onglets, fusion recherche/onglets). Ce qui suit, c'est la suite : (A) aligner la direction artistique de l'outil sur celle du nouveau site openmedias.fr, et (B) un deep dive ergonomie sur ce qui reste frictionnel dans l'usage quotidien.

Méthode : le site a été rouvert en direct (capture d'écran + lecture des styles calculés réels, pas une estimation) pour extraire les vraies valeurs de couleur/police/forme, et le code actuel de `recouvrement/frontend/index.html` a été relu en entier pour ne proposer que des points non déjà couverts.

---

## A. Alignement DA avec openmedias.fr

### Ce que le site utilise réellement (valeurs mesurées)

| Élément | Valeur exacte sur le site |
|---|---|
| Fond dominant (hero, à propos, footer) | `rgb(13,13,43)` = **#0D0D2B** (bleu nuit/indigo très profond) |
| Couleur d'accent / CTA | `rgb(59,59,249)` = **#3B3BF9** (indigo vif, presque violet) |
| Police de titres | **Garet** (arrondie, très épaisse — poids 800), tout en majuscules sur les headlines |
| Police de texte courant | **Inter** — déjà exactement notre police body actuelle |
| Boutons | **entièrement arrondis** (`border-radius: 50px`, effet pilule), texte en majuscules, gras |
| Boutons secondaires / icônes | cercles parfaits avec liseré fin, fond transparent (flèches de carrousel, réseaux sociaux) |
| Cartes médias | photo plein cadre en fond, overlay sombre, chiffres clés en gros (Garet blanc) |
| Une seule carte claire repérée | le détail d'un média sélectionné (fond blanc, texte marine) — le clair est l'exception, pas la norme |

### Constat

L'outil aujourd'hui (`--bg:#F1F4F9`, `--accent:#2563EB`, police de titre `Sora`, rayons 12-18px) n'a presque rien en commun visuellement avec le site : accent bleu classique vs indigo vif du site, coins arrondis modérés vs pilules complètes, Sora vs Garet. Vu de l'extérieur ça ressemble à deux produits différents de deux boîtes différentes.

**Mais copier le site à l'identique serait une erreur d'usage.** Le site est une vitrine qu'on visite 2 minutes ; le Recouvrement est un outil de travail qu'on garde ouvert des heures, avec des tableaux denses et des montants à lire vite. Un fond bleu nuit sur tout l'écran, avec des dizaines de lignes de facture dessus, fatigue l'œil et réduit le contraste utile aux couleurs sémantiques (rouge retard / vert soldé) qui font le vrai travail ici. C'est le même arbitrage que fait la plupart des outils B2B qui ont un site vitrine sombre et un produit clair (Stripe en est l'exemple le plus connu).

### Proposition : reprendre l'identité, pas le mode sombre

**À adopter tel quel (identité de marque, sans risque ergonomique) :**
- `--accent: #3B3BF9` à la place de `#2563EB` — impact immédiat et cohérent partout où `--accent` est déjà utilisé (boutons primaires, liens, chips actives, focus des inputs).
- Police de titres `Garet` à la place de `Sora` pour les vrais titres de marque (le "💶 Recouvrement" du header, les titres de section) — garder `Inter` pour tout le reste (déjà partagé avec le site, aucun changement).
- Boutons primaires en pilule complète (`border-radius: 999px`) au lieu de `--radius-sm`, pour `.btn-primary` — les boutons secondaires/tertiaires peuvent rester en rayon actuel pour ne pas tout transformer en pilule (sinon effet "tout arrondi" qui nuit à la hiérarchie visuelle dans un tableau dense).
- Les boutons icône seuls (thème, déconnexion, toggle sync) passent en cercle parfait avec liseré fin, comme sur le site — cohérent avec ce qu'on a déjà en grande partie.

**À NE PAS copier tel quel :**
- Le fond bleu nuit en continu — trop de fatigue visuelle sur un usage prolongé + tableau de chiffres. Le garder pour un futur écran d'accueil/login uniquement (le `#pin-screen` actuel, lui, peut tout à fait passer en marine + Garet + CTA pilule indigo : c'est un écran de 5 secondes, pas un espace de travail).
- Les majuscules systématiques sur les CTA — lisible sur un site en 3 boutons, fatigant sur un outil avec des dizaines de boutons/labels à l'écran.

**Effort estimé pour le lot "identité" (accent + police titres + boutons primaires + login en marine) :** cosmétique pur, aucune logique touchée, un seul passage sur les variables CSS `:root` + `.btn-primary` + `#pin-screen` suffit pour 90 % de l'effet visuel.

---

## B. Deep dive ergonomie (round 2)

### B1. Pas de vue centrée client — seulement facture par facture

**Constat.** Toute la page raisonne "une ligne = une facture". Un client avec 4 factures en cours apparaît 4 fois dans le tableau, sans vue qui dise "ce client-là, au total, doit X€ et Y factures sont en retard" avant d'ouvrir chaque facture une par une. On a ajouté un encadré "Ce client en direct" dans la fiche détail (bon rattrapage), mais il faut déjà être dans une facture précise pour le voir — impossible de trier/prioriser les CLIENTS directement depuis la liste.

**Proposition.** Une 4e vue dans la sous-navigation : **"Clients"**, une ligne par client (regroupement par `customerId`), avec : nombre de factures ouvertes, montant total dû, la plus ancienne échéance dépassée, un lien direct vers la facture la plus urgente de ce client. C'est la vue qu'un chargé de recouvrement ouvre en premier le matin dans les outils comme Kollekt/LeanPay — prioriser par client plutôt que par facture évite de relancer la même entreprise trois fois dans la même semaine sur trois factures différentes.

### B2. Aucune notion de priorité/score — juste un tri manuel colonne par colonne

**Constat.** Le tri par Échéance/Retard/Montant existe (bien), mais rien ne combine les deux pour répondre à "qu'est-ce que je traite en premier aujourd'hui ?". Une facture de 200€ en retard de 5 jours et une facture de 15 000€ en retard de 3 jours arrivent au même niveau visuel.

**Proposition.** Un tri "Priorité" (montant restant dû × jours de retard, ou une pondération simple) comme option supplémentaire dans les en-têtes triables déjà en place — pas une nouvelle UI, juste une 4e clé de tri qui réutilise `setFinanceSort()`.

### B3. Fiche facture : un seul long scroll (Infos → Commentaires → Échéances → Relances)

**Constat.** La modale empile aujourd'hui 4 blocs verticaux (`finance-detail-section` × 4) plus le nouvel encadré client. Sur une facture avec beaucoup d'historique de relances, il faut scroller loin dans la modale pour arriver aux commentaires ou aux échéances de paiement.

**Proposition.** Des sous-onglets internes à la modale (Infos / Relances / Commentaires / Échéancier), même mécanique que la sous-navigation `finance-subnav` déjà en place pour la page principale — pas de nouveau concept à apprendre, juste répété à l'échelle de la fiche.

### B4. La relance reste 100 % manuelle, sans suggestion de prochaine action

**Constat.** "Nouvelle relance" est un formulaire libre (canal + note) à remplir soi-même à chaque fois. Rien n'indique "ça fait 12 jours que personne n'a relancé cette facture" avant d'ouvrir la fiche.

**Proposition légère (pas d'automatisation d'envoi, juste un signal) :** un badge discret dans le tableau/la fiche — "Dernière relance il y a 12j" ou "Jamais relancée" — calculé depuis `relances` déjà chargées. Aide à prioriser sans construire un moteur d'envoi automatique (hors périmètre probable ici, Pennylane n'étant pas notre système d'emailing).

### B5. Pas d'action groupée

**Constat.** Chaque changement de statut/relance se fait facture par facture. Marquer 5 factures d'un même client "En cours" après un appel groupé demande 5 allers-retours.

**Proposition.** Cases à cocher sur les lignes du tableau + une barre d'action groupée minimale ("Changer le statut de la sélection"). À réserver pour une itération suivante si la vue "Clients" (B1) absorbe déjà une bonne partie du besoin.

### B6. Litiges : snapshot honnête, mais pas d'action d'escalade

**Constat.** La vue Litiges (livrée) affiche bien un instantané sans faux historique — c'est la bonne posture. Mais une fois qu'on y est, il n'y a pas d'action propre à ce contexte (ex. "Envoyer en contentieux", "Marquer résolu") — on retombe sur le même select générique de statut que partout ailleurs.

**Proposition.** Rien d'urgent tant qu'il n'y a pas de vrai processus contentieux formalisé côté OpenMedias — à garder en tête si un jour un statut "Contentieux" s'ajoute à `internal_status`.

### B7. Accessibilité couleur

**Constat.** Beaucoup de signaux reposent uniquement sur la couleur (barre de retard rouge, deltas rouge/vert, chips de statut) — un daltonien perd une partie de l'info.

**Proposition.** Ajouter un petit pictogramme (▲/▼ déjà présent sur les deltas, bien) partout où c'est encore couleur seule — coût faible, déjà à moitié fait.

### B8. États de chargement/vide

**Constat.** Au premier chargement, les cartes KPI et le tableau restent vides une fraction de seconde sans indicateur (pas de skeleton), et l'état vide du tableau est un seul message texte générique quel que soit le filtre actif.

**Proposition.** Un skeleton simple sur les cartes KPI pendant le fetch initial, et un message d'état vide qui varie selon le contexte ("Aucune facture en litige" vs "Aucun résultat pour cette recherche" vs filtre de période).

---

## Priorisation suggérée

**Rapide (cosmétique/config, aucune logique touchée)**
1. Accent `#3B3BF9` + police `Garet` sur les titres + boutons primaires en pilule (DA, section A)
2. Écran de connexion (`#pin-screen`) refait en marine/Garet/CTA indigo — vitrine à moindre risque
3. Pictogrammes en plus de la couleur sur les signaux existants (B7)
4. Tri "Priorité" en 4e option de tri (B2)
5. Badge "Dernière relance il y a Xj" (B4)

**À discuter avant de coder (choix produit, plus structurant)**
6. Vue "Clients" dédiée dans la sous-navigation (B1) — le changement le plus utile pour le métier, mais demande de définir ce qu'on affiche/priorise par client
7. Fiche facture en sous-onglets (B3)
8. Actions groupées (B5)
9. Skeletons/états vides contextuels (B8)

Dis-moi par quel lot tu veux qu'on commence — je peux enchaîner tout de suite sur le lot "rapide" si tu valides.
