#!/usr/bin/env python3
"""Downloads the Qdrant server release binary for THIS machine into ai/.qdrant/ (gitignored), verifying its SHA-256
against the digest GitHub publishes for the release asset. No Docker needed. Never run automatically.

    python scripts/install_qdrant.py              # latest release
    python scripts/install_qdrant.py --version v1.20.1 --dest /opt/qdrant

Production should NOT use this: run Qdrant as a managed/private service (see ai/README.md, "Production").
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

API = "https://api.github.com/repos/qdrant/qdrant/releases"


def asset_name() -> str:
    system, machine = platform.system(), platform.machine().lower()
    arm = machine in {"arm64", "aarch64"}
    if system == "Darwin":
        return "qdrant-aarch64-apple-darwin.tar.gz" if arm else "qdrant-x86_64-apple-darwin.tar.gz"
    if system == "Linux":
        return "qdrant-aarch64-unknown-linux-musl.tar.gz" if arm else "qdrant-x86_64-unknown-linux-gnu.tar.gz"
    sys.exit(f"unsupported platform {system}/{machine}: install Qdrant manually (https://qdrant.tech/documentation/guides/installation/)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="latest")
    ap.add_argument("--dest", default=str(Path(__file__).resolve().parents[1] / ".qdrant"))
    args = ap.parse_args()

    url = f"{API}/latest" if args.version == "latest" else f"{API}/tags/{args.version}"
    with urllib.request.urlopen(url, timeout=30) as r:
        release = json.load(r)
    name = asset_name()
    asset = next((a for a in release["assets"] if a["name"] == name), None)
    if asset is None or not str(asset.get("digest", "")).startswith("sha256:"):
        sys.exit(f"release {release['tag_name']} has no verifiable asset {name}")
    expected = asset["digest"].split(":", 1)[1]

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / name
        h = hashlib.sha256()
        with urllib.request.urlopen(asset["browser_download_url"], timeout=300) as r, open(archive, "wb") as out:
            while chunk := r.read(1 << 20):
                h.update(chunk)
                out.write(chunk)
        if h.hexdigest() != expected:
            sys.exit("CHECKSUM MISMATCH: refusing to install")
        with tarfile.open(archive) as tar:
            member = next(m for m in tar.getmembers() if m.name.rstrip("/").split("/")[-1] == "qdrant" and m.isfile())
            member.name = "qdrant"  # never trust archive paths
            tar.extract(member, dest, filter="data")
    binary = dest / "qdrant"
    binary.chmod(0o755)
    print(f"installed {release['tag_name']} ({name}, sha256 verified) -> {binary}")


if __name__ == "__main__":
    main()
