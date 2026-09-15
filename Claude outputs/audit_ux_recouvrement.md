# Audit UX/UI — Page Recouvrement

Périmètre : `/recouvrement` (bandeau KPI, barre de période, onglets statuts, recherche, tableau des factures, fiche détail). Basé sur la lecture du code actuel + les deux captures partagées (chiffres coupés, densité générale).

---

## 1. Cartes KPI (Encours total / À relancer / Taux de retard / DSO)

**Constat.** Les 4 cartes sont posées à plat, même poids visuel, aucune ne dit si le chiffre est bon ou mauvais dans le temps (pas d'évolution vs la période précédente). Le "Taux de retard" (99 %) et le montant "À relancer aujourd'hui" ne couvrent pas le même périmètre que les onglets juste en dessous (les KPI excluent les factures soldées/annulées hors recouvrement, les onglets reflètent le statut brut Pennylane) — ça peut donner l'impression que les chiffres "ne collent pas entre eux" alors que c'est juste deux définitions différentes, jamais expliquées à l'écran.

**Propositions**
- Ajouter une micro-info (icône ⓘ ou `title` au survol) sur "Taux de retard" et "À relancer aujourd'hui" précisant le périmètre exact ("hors factures soldées/annulées/en litige suivi à part"). Correctif rapide, pas de refonte.
- Ajouter une comparaison à la période précédente sous chaque carte (ex. "+230 j vs mois dernier", petite flèche rouge/verte) — plus parlant maintenant qu'un filtre de période existe, mais demande de calculer le KPI sur la période N-1 côté API.
- Réordonner par priorité de lecture : "À relancer aujourd'hui" (le plus actionnable) en premier à gauche plutôt qu'"Encours total".

---

## 2. Chiffres coupés / illisibles dans les cartes

**Déjà corrigé** dans la dernière livraison (notation compacte "16,8 M€" + valeur exacte au survol). À surveiller sur d'autres écrans si le même patron de carte KPI est réutilisé ailleurs dans le dashboard (le bug touchait uniquement `.kpi-val` ici, mais la classe est probablement partagée).

---

## 3. Barre d'onglets Pennylane (9 filtres à plat)

**Constat.** Les 9 chips ("Toutes/Brouillon/À traiter/À venir/En retard/Encaissée/Partiellement encaissée/Annulée/Avoir") ont toutes la même couleur à l'état actif (bleu accent), qu'il s'agisse d'un statut critique ("En retard") ou neutre ("Annulée", "Avoir"). Il faut lire le texte pour savoir si on regarde un problème ou un non-sujet. Sur écran étroit, "Partiellement encaissée" (le libellé le plus long) force un retour à la ligne disgracieux, comme visible sur la capture.
Autre point plus factuel : deux statuts Pennylane existent dans les données (`archived`, `proforma`, `estimate_*`, etc. — visibles dans `PENNYLANE_STATUS_LABEL`) mais n'ont **aucun onglet dédié** ; les factures archivées (6 dans ta synchro) ne sont accessibles que via "Toutes" + recherche manuelle, nulle part ailleurs.

**Propositions**
- Reprendre les couleurs déjà définies pour "Répartition de l'encours par statut" (`FINANCE_STATUS_COLOR`) sur l'état actif de chaque chip, au lieu du bleu uniforme partout — cohérence immédiate avec le reste de la page, aucun nouveau code couleur à inventer.
- Raccourcir "Partiellement encaissée" → "Partiel." ou "Part. encaissée" pour éviter le retour à la ligne, ou passer le libellé complet uniquement en `title`.
- Ajouter un onglet "Archivée" (ou fusionner ces factures dans "Annulée" si elles n'ont pas de valeur métier propre) pour qu'aucune facture synchronisée ne soit invisible depuis les filtres.

---

## 4. Bandeau "Synchro Pennylane — Toutes X · Encaissée Y · …"

**Constat.** Cette ligne (11px, grise, tout sur une seule ligne) répète presque exactement les compteurs déjà affichés sur les chips juste en dessous, en plus dense et moins lisible. Elle a été pensée comme "repère de cohérence de synchro" (vérifier que rien ne manque), mais dans l'usage quotidien elle fait doublon visuel sans rien apporter de plus que les onglets.

**Propositions**
- La masquer par défaut et ne l'afficher qu'au clic sur un petit lien "Détail de la synchro" à côté du bouton "Synchroniser Pennylane" — utile ponctuellement (vérifier après une synchro), pas en permanence à l'écran.
- Alternative plus légère : la garder mais uniquement pour les statuts qui n'ont pas d'onglet dédié (Archivée, Proforma, Devis…), ce qui la rend complémentaire au lieu de redondante.

---

## 5. Empilement vertical avant le tableau

**Constat.** Avant d'atteindre la première ligne de facture, l'utilisateur traverse : bandeau synchro → 4 cartes KPI → barre de période → barre d'onglets → carte "recherche" isolée (un seul champ, dans sa propre carte blanche) → carte tableau. Ça fait beaucoup de blocs empilés, chacun avec sa propre ombre/bordure, pour arriver à la donnée utile.

**Propositions**
- Fusionner le champ de recherche dans la barre d'onglets (déjà en `flex-wrap`), aligné à droite — supprime une carte entière et le vide qu'elle ajoute.
- Réduire les marges verticales entre les blocs restants (actuellement ~14-24px partout) pour resserrer l'ensemble, surtout utile sur petit écran.

---

## 6. Tableau des factures

**Constat.** 10 colonnes denses (Facture/Entreprise/Nom Prénom/Mail/Téléphone/Échéance/Retard/Montant HT/Montant TTC/Statut), pas de tri par colonne (les en-têtes ne sont pas cliquables ici, contrairement à d'autres tableaux de l'app qui ont déjà `.sortable-th`). Sur un métier de relance, pouvoir trier par échéance ou par montant restant dû est souvent le premier réflexe.

**Propositions**
- Rendre les colonnes Échéance / Retard / Montant TTC triables (le style existe déjà ailleurs dans le fichier, juste à réutiliser).
- Masquer Téléphone et Montant HT sous un breakpoint étroit (ou dans un menu "colonnes visibles"), en gardant Facture/Entreprise/Échéance/Retard/Montant TTC/Statut comme socle minimal.

---

## Priorisation suggérée

**Rapide (pas de refonte, cosmétique/config)**
1. Couleurs de statut sur les chips actifs (réutilise l'existant)
2. Raccourcir "Partiellement encaissée"
3. Tooltip de périmètre sur les 2 KPI qui divergent des onglets
4. Fusionner recherche + barre d'onglets

**À discuter avant de coder (choix produit)**
5. Onglet "Archivée" manquant — le crée-t-on, ou on les fusionne ailleurs ?
6. Masquer/simplifier le bandeau "Synchro Pennylane"
7. Tri de colonnes + colonnes responsives
8. Comparaison période N / N-1 sur les KPI

Dis-moi lesquels tu veux qu'on attaque en premier, je peux commencer par le lot "rapide" tout de suite.
