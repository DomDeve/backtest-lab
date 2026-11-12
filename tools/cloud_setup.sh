#!/usr/bin/env bash
# Bereitet einen frischen Klon des backtest-lab für einen Lauf in der Cloud vor:
# Kursdaten aus cloud-data/ entpacken, Abhängigkeiten installieren, Indikatoren neu bauen.
# Aufruf aus dem Repo-Wurzelverzeichnis: bash tools/cloud_setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Werkzeuge prüfen"
node -e 'const m=+process.versions.node.split(".")[0]; if(m<20){console.error("Node >= 20 nötig, gefunden "+process.versions.node); process.exit(1)}'
python3 --version

echo "== Daten prüfen"
erwartet=$(awk '{print $1}' cloud-data/daten.sha256)
ist=$(cat cloud-data/daten.tar.zst.part-* | sha256sum | awk '{print $1}')
if [ "$erwartet" != "$ist" ]; then
  echo "FEHLER: Prüfsumme der Datenteile stimmt nicht (erwartet $erwartet, ist $ist)"; exit 1
fi

echo "== Daten entpacken"
if command -v zstd >/dev/null 2>&1; then
  cat cloud-data/daten.tar.zst.part-* | zstd -d -q | tar -x
else
  python3 -c 'import zstandard' 2>/dev/null || pip install -q --break-system-packages zstandard
  cat cloud-data/daten.tar.zst.part-* | python3 -c 'import sys,zstandard; zstandard.ZstdDecompressor().copy_stream(sys.stdin.buffer, sys.stdout.buffer)' | tar -x
fi

echo "== Abhängigkeiten"
npm install --no-audit --no-fund --silent

echo "== Indikatoren bauen (M5, M15, H4)"
if [ ! -d data/indicators ] || [ -z "$(ls -A data/indicators 2>/dev/null)" ]; then
  node tools/indicators.js
  node tools/indicators.js --tf M15,H4
fi

echo "== Fertig"
