#!/usr/bin/env bash
# Download and extract GSHHG 2.3.7 if not already present.
# Produces: data/reference/gshhs_h.b (and the rest of the archive).
set -euo pipefail

REF_DIR="$(dirname "$0")/../reference"
ARCHIVE="$REF_DIR/gshhg-bin-2.3.7.zip"
TARGET="$REF_DIR/gshhs_h.b"
URL="https://www.ngdc.noaa.gov/mgg/shorelines/data/gshhg/latest/gshhg-bin-2.3.7.zip"

mkdir -p "$REF_DIR"

if [[ -f "$TARGET" ]]; then
  echo "gshhs_h.b already present at $TARGET"
  exit 0
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Downloading GSHHG 2.3.7 (~60 MB)..."
  curl -fL -o "$ARCHIVE" "$URL"
fi

echo "Extracting gshhs_h.b..."
unzip -j -o "$ARCHIVE" "gshhg-bin-2.3.7/gshhs_h.b" -d "$REF_DIR"
echo "Done. $TARGET is ready."
