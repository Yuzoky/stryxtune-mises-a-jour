# Planning automatique (Stryx Hub)

`planning.json` contient le planning **chiffré pour un seul téléphone** : seule la clé privée
gardée dans le coffre de l'appli peut le lire. Le fichier peut donc être public sans rien révéler.

- `pubkey.txt` : code de liaison `STRYXKEY:…` affiché par l'appli (Réglages › Planning automatique).
  C'est une clé publique : elle sert seulement à chiffrer.
- `encrypt.py` : `python3 sync/encrypt.py payload.json` produit `planning.json`
  (ECDH P-256 + HKDF-SHA256 + AES-256-GCM).

L'appli récupère `planning.json` à chaque ouverture, le déchiffre et met à jour le planning du coffre.
