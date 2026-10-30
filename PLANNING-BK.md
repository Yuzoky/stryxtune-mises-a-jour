# Planning BK — l'appli des managers (BK Claye-Souilly)

Appli Android pour les managers. Elle sert à lire le planning de l'équipe à partir de la photo de la feuille, à le modifier et à le partager entre managers.

## 1. Installer l'appli

1. Sur le téléphone Android, ouvre ce lien :
   **https://github.com/Yuzoky/stryxtune-mises-a-jour/releases/download/bkplanning/PlanningBK.apk**
2. Ouvre le fichier téléchargé, puis touche **Installer**. Si Android le demande, autorise l'installation d'applis inconnues.
3. Les mises à jour se font ensuite depuis l'appli : **Réglages › Mises à jour**.

## 2. Première ouverture

- **Toi (l'administrateur)** : touche **Créer le restaurant (première fois)**. L'appli crée un **code du restaurant** (ex. `7K4P-M2QX-9TRB-H6WD`). Garde-le bien.
- **Les autres managers** : ils touchent **J'ai le code du restaurant**, puis tapent le code et leur prénom.
  Envoie-leur le code avec **Réglages › Donner le code à un manager** : le message contient aussi le lien de l'appli.

> Avec ce code, on voit et on modifie le planning : donne-le seulement aux managers.

## 3. Activer l'envoi automatique (une seule fois, par l'administrateur)

C'est ce qui fait arriver les plannings tout seuls chez les autres managers.

1. Sur GitHub, crée un dépôt nommé **`bk-planning-data`** (public, coche « Add a README »).
2. Crée une clé : **Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token**.
   - Repository access : **Only select repositories** › `bk-planning-data`
   - Permissions › Repository permissions › **Contents : Read and write**
   - Expiration : la plus longue possible
3. Dans l'appli : **Réglages › Clé d'envoi GitHub**, colle la clé, puis touche **Activer**.

Le planning est chiffré avec le code du restaurant **avant** l'envoi. Sur GitHub, il n'y a que des fichiers illisibles, sans aucun nom.

## 4. Utilisation

| Onglet | Ce qu'on y fait |
|---|---|
| **Planning** | Vue **Jour** : frise de l'équipe, effectif heure par heure, ligne rouge « maintenant », ta ligne en surbrillance. Vue **Semaine** : tout le tableau. Touche une case pour modifier (horaires, Repos, Congé) ou **Échanger** la journée entre deux personnes. |
| **Heures** | Alertes : plus de 10 h par jour, pas de pause après 6 h, moins de 11 h de repos, pas 35 h de repos par semaine, plus de 48 h, trous sans personne, effectif minimum. Heures prévues comparées au contrat. |
| **Ajouter** | **Prendre une photo** de chaque page de la feuille (bien à plat, tout le tableau visible). L'appli lit la photo **sur le téléphone**, sans rien envoyer. Elle vérifie chaque ligne avec le total imprimé : les lignes en orange sont à vérifier (touche une ligne pour voir l'extrait de la photo et corriger), puis touche **Enregistrer la semaine**. |
| **Réglages** | Thème (Automatique, Crème, Sombre, Nuit étoilée, Océan, Forêt, Framboise), code du restaurant, envoi automatique, effectif minimum, verrouillage par empreinte, mises à jour. |

Astuce : dans la fiche d'une personne, **C'est moi** met ta ligne en avant (« Toi : … »).

## 5. Bon à savoir

- La lecture de la photo marche bien sur les feuilles du restaurant. Il faut quand même vérifier les lignes signalées : une case cachée par un aimant ou une bande grise ne peut pas être devinée.
- Plusieurs managers peuvent modifier en même temps : les changements sont fusionnés case par case.
- Outil interne, non officiel, sans lien avec la marque.
