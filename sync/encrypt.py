#!/usr/bin/env python3
"""Publie le planning chiffré pour le téléphone lié à Stryx Hub.

Usage : python3 sync/encrypt.py <payload.json> [--pubkey sync/pubkey.txt] [--out sync/planning.json]

- <payload.json> : {"plans": [<planning d'équipe v2>, ...], "removeWeeks": ["AAAA-MM-JJ", ...]}
  (les champs app / id / updated sont ajoutés automatiquement).
- sync/pubkey.txt : code de liaison STRYXKEY:… affiché par l'appli (clé publique, pas secrète).

Chiffrement : ECDH P-256 éphémère + HKDF-SHA256 (info « stryxhub-sync-v1 ») + AES-256-GCM.
Seule la clé privée gardée dans le coffre du téléphone peut déchiffrer le fichier produit.
Nécessite le paquet Python « cryptography ».
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import pathlib
import secrets
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

INFO = b"stryxhub-sync-v1"
HERE = pathlib.Path(__file__).resolve().parent


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text: str) -> bytes:
    text = text.strip().replace("+", "-").replace("/", "_")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_pubkey(path: pathlib.Path) -> bytes:
    code = path.read_text(encoding="utf-8").strip()
    if not code.upper().startswith("STRYXKEY:"):
        sys.exit(f"{path} : code de liaison invalide (doit commencer par STRYXKEY:)")
    raw = unb64u(code.split(":", 1)[1])
    if len(raw) != 65 or raw[0] != 4:
        sys.exit(f"{path} : clé publique P-256 invalide")
    return raw


def encrypt(payload: dict, pub_raw: bytes) -> dict:
    recipient = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), pub_raw)
    eph = ec.generate_private_key(ec.SECP256R1())
    shared = eph.exchange(ec.ECDH(), recipient)
    salt = secrets.token_bytes(16)
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=INFO).derive(shared)
    iv = secrets.token_bytes(12)
    pt = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    ct = AESGCM(key).encrypt(iv, pt, INFO)
    epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {
        "app": "stryxhub-sync",
        "v": 1,
        "kid": hashlib.sha256(pub_raw).digest()[:6].hex(),
        "epk": b64u(epk),
        "salt": b64u(salt),
        "iv": b64u(iv),
        "ct": b64u(ct),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("payload")
    ap.add_argument("--pubkey", default=str(HERE / "pubkey.txt"))
    ap.add_argument("--out", default=str(HERE / "planning.json"))
    args = ap.parse_args()

    payload = json.loads(pathlib.Path(args.payload).read_text(encoding="utf-8"))
    now = datetime.datetime.now(datetime.timezone.utc)
    payload["app"] = "stryxhub-plan"
    payload["id"] = now.strftime("%Y%m%dT%H%M%SZ-") + secrets.token_hex(3)
    payload.setdefault("updated", now.date().isoformat())
    if not isinstance(payload.get("plans", []), list):
        sys.exit("payload : « plans » doit être une liste")

    envelope = encrypt(payload, load_pubkey(pathlib.Path(args.pubkey)))
    out = pathlib.Path(args.out)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(envelope, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, out)
    print(f"{out} écrit (id {payload['id']}, {len(payload.get('plans', []))} semaine(s), clé {envelope['kid']})")


if __name__ == "__main__":
    main()
