# StryxMDP

Gestionnaire de mots de passe pour téléphone : noir spatial, vortex, tuiles verre.

## Sécurité
- Tout est chiffré sur le téléphone : AES-256-GCM, clé dérivée du mot de passe maître (PBKDF2-SHA256, 600 000 itérations).
- Aucune donnée n'est envoyée sur Internet. L'application fonctionne hors ligne.
- Le mot de passe maître n'est jamais enregistré : **s'il est oublié, le coffre est irrécupérable.**
- Verrouillage automatique (1, 5 ou 15 min, et au retour dans l'appli après 30 s), presse-papiers vidé 30 s après une copie.

## Fonctions
Ajout / modification / suppression, recherche, catégories (Jeux, Réseaux, E-mail, Banque, Travail, Autre),
générateur de mots de passe, indicateur de robustesse, sauvegarde chiffrée (export / import), changement du mot de passe maître.

## Mettre l'appli en ligne (une seule fois)
L'icône ne peut être créée que si l'appli est ouverte depuis une adresse HTTPS. Avec GitHub Pages :
1. Sur GitHub : **Settings › Pages › Build and deployment › Source : Deploy from a branch**.
2. Choisissez la branche qui contient ce dossier, dossier **/ (root)**, puis **Save**.
3. Après 1 à 2 minutes, l'appli est disponible à l'adresse :
   `https://yuzoky.github.io/stryxtune-mises-a-jour/stryxmdp/`

## Créer l'icône sur le téléphone
1. Ouvrez l'adresse ci-dessus sur le téléphone : Chrome sur Android, Safari sur iPhone.
2. Touchez **📲 Installer l'appli sur l'écran d'accueil** sur l'écran d'accueil de StryxMDP.
   - Android : confirmez avec **Installer**.
   - iPhone : suivez les 3 étapes affichées (Partager › Sur l'écran d'accueil › Ajouter).
3. L'icône StryxMDP apparaît sur le téléphone. L'appli s'ouvre en plein écran et fonctionne sans connexion.

Pensez à exporter régulièrement une sauvegarde (Paramètres › Exporter) : si les données du navigateur sont effacées, le coffre l'est aussi.
