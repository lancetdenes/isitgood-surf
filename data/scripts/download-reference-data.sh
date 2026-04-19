#!/bin/bash
# download-reference-data.sh — Fetches Natural Earth + GeoNames datasets
# used by build-coast-points.js. Run once; outputs are gitignored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REF_DIR="$(dirname "$SCRIPT_DIR")/reference"
mkdir -p "$REF_DIR"

echo "━━━ Downloading reference datasets ━━━"

# Natural Earth — 10m coastline (simplified world coast as LineStrings)
COAST_URL="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson"
COAST_OUT="${REF_DIR}/ne_10m_coastline.geojson"
if [ ! -f "$COAST_OUT" ]; then
  echo "  → coastline: $COAST_URL"
  curl -sfL -o "$COAST_OUT" "$COAST_URL"
  echo "    ✓ $(du -h "$COAST_OUT" | cut -f1)"
else
  echo "  → coastline: cached"
fi

# Natural Earth — 10m admin-0 (country polygons)
ADMIN_URL="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson"
ADMIN_OUT="${REF_DIR}/ne_10m_admin_0_countries.geojson"
if [ ! -f "$ADMIN_OUT" ]; then
  echo "  → countries: $ADMIN_URL"
  curl -sfL -o "$ADMIN_OUT" "$ADMIN_URL"
  echo "    ✓ $(du -h "$ADMIN_OUT" | cut -f1)"
else
  echo "  → countries: cached"
fi

# GeoNames — cities with pop > 1000
CITIES_ZIP="${REF_DIR}/cities1000.zip"
CITIES_OUT="${REF_DIR}/cities1000.txt"
if [ ! -f "$CITIES_OUT" ]; then
  echo "  → cities1000: https://download.geonames.org/export/dump/cities1000.zip"
  curl -sfL -o "$CITIES_ZIP" "https://download.geonames.org/export/dump/cities1000.zip"
  unzip -qo "$CITIES_ZIP" -d "$REF_DIR"
  rm "$CITIES_ZIP"
  echo "    ✓ $(du -h "$CITIES_OUT" | cut -f1)"
else
  echo "  → cities1000: cached"
fi

echo ""
echo "━━━ Done ━━━"
echo "Reference data in: $REF_DIR"
