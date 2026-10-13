# STRYX Vault

Gestionnaire de mots de passe pour téléphone, au style STRYXTUNE (noir spatial, vortex, tuiles verre).

## Sécurité
- Tout est chiffré sur le téléphone : AES-256-GCM, clé dérivée du mot de passe maître (PBKDF2-SHA256, 600 000 itérations).
- Aucune donnée n'est envoyée sur Internet. L'application fonctionne hors ligne.
- Le mot de passe maître n'est jamais enregistré : **s'il est oublié, le coffre est irrécupérable.**
- Verrouillage automatique (1, 5 ou 15 min, et au retour dans l'appli après 30 s), presse-papiers vidé 30 s après une copie.

## Fonctions
Ajout / modification / suppression, recherche, catégories (Jeux, Réseaux, E-mail, Banque, Travail, Autre),
générateur de mots de passe, indicateur de robustesse, sauvegarde chiffrée (export / import), changement du mot de passe maître.

## Installer sur le téléphone
L'application est une PWA : elle doit être servie en HTTPS (par exemple via GitHub Pages).
1. Ouvrez l'adresse de l'application dans Chrome (Android) ou Safari (iPhone).
2. Android : menu ⋮ › **Installer l'application**. iPhone : bouton Partager › **Sur l'écran d'accueil**.
3. Elle s'ouvre ensuite en plein écran comme une vraie appli, même sans connexion.

Pensez à exporter régulièrement une sauvegarde (Paramètres › Exporter) : si les données du navigateur sont effacées, le coffre l'est aussi.
