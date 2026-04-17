#!/bin/bash
# download-ecmwf.sh — Download ECMWF IFS open data (wind + waves)
#
# Uses byte-range requests via the JSON .index files to download ONLY
# the 10u/10v fields (~1.7 MB) instead of the full file (~113 MB).
# Wave data comes from the separate WAM model.
#
# Usage:
#   bash data/scripts/download-ecmwf.sh              # downloads latest
#   bash data/scripts/download-ecmwf.sh 20260409 00  # specific run
#
# After downloading, run: python3 data/scripts/process-grib.py ecmwf
#
# Prerequisites: curl, python3 (for JSON parsing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")"

# Determine run
if [ $# -ge 2 ]; then
  DATE="$1"
  CYCLE="$2"
else
  NOW_UTC=$(date -u +%Y%m%d%H)
  DATE=$(echo "$NOW_UTC" | cut -c1-8)
  HOUR=$(echo "$NOW_UTC" | cut -c9-10)

  AVAIL_HOUR=$((HOUR - 8))
  if [ $AVAIL_HOUR -lt 0 ]; then
    AVAIL_HOUR=$((AVAIL_HOUR + 24))
    DATE=$(date -u -v-1d +%Y%m%d 2>/dev/null || date -u -d "yesterday" +%Y%m%d)
  fi

  if [ $AVAIL_HOUR -ge 12 ]; then CYCLE="12"
  else CYCLE="00"
  fi
fi

RUN_ID="${DATE}_${CYCLE}z"
GRIB_DIR="${DATA_DIR}/grib/ecmwf/${RUN_ID}"
mkdir -p "$GRIB_DIR"

echo "━━━ Downloading ECMWF IFS run: ${RUN_ID} ━━━"
echo "Output: ${GRIB_DIR}"
echo ""

ECMWF_BASE="https://data.ecmwf.int/forecasts/${DATE}/${CYCLE}z/ifs/0p25/oper"
WAM_BASE="https://data.ecmwf.int/forecasts/${DATE}/${CYCLE}z/wam/0p25/oper"

# ── Helper: download specific fields via byte-range from JSON index ──
download_wind_fields() {
  local FULL_URL="$1"
  local INDEX_URL="$2"
  local OUTPUT="$3"

  # Fetch index and extract 10u/10v byte ranges
  local RANGES
  RANGES=$(curl -sf "$INDEX_URL" | python3 -c "
import sys, json
ranges = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    rec = json.loads(line)
    if rec.get('param') in ('10u', '10v'):
        start = rec['_offset']
        end = start + rec['_length'] - 1
        ranges.append(f'{start}-{end}')
if ranges:
    print(','.join(ranges))
else:
    sys.exit(1)
" 2>/dev/null) || return 1

  curl -sf -H "Range: bytes=${RANGES}" -o "$OUTPUT" "$FULL_URL"
}

# Forecast hours: 0 to 168 every 3 hours
HOURS=$(seq 0 3 168)
TOTAL=$(echo "$HOURS" | wc -w | tr -d ' ')
COUNT=0

for FHR in $HOURS; do
  FHRP=$(printf "%03d" "$FHR")
  COUNT=$((COUNT + 1))
  echo -n "  [${COUNT}/${TOTAL}] f${FHRP}: "

  STEP="${FHR}h"
  FILE_BASE="${DATE}${CYCLE}0000-${STEP}-oper-fc"

  # --- Wind (10u, 10v only — ~1.7 MB via byte-range) ---
  ATMO_FILE="${GRIB_DIR}/ecmwf_atmo_f${FHRP}.grib2"
  if [ ! -f "$ATMO_FILE" ]; then
    FULL_URL="${ECMWF_BASE}/${FILE_BASE}.grib2"
    INDEX_URL="${ECMWF_BASE}/${FILE_BASE}.index"
    if download_wind_fields "$FULL_URL" "$INDEX_URL" "$ATMO_FILE"; then
      echo -n "wind ✓  "
    else
      echo -n "wind ✗  "
    fi
  else
    echo -n "wind (cached)  "
  fi

  # --- Wave data (separate WAM model — already small files) ---
  WAVE_FILE="${GRIB_DIR}/ecmwf_wave_f${FHRP}.grib2"
  if [ ! -f "$WAVE_FILE" ]; then
    WAVE_URL="${WAM_BASE}/${FILE_BASE}.grib2"
    curl -sf -o "$WAVE_FILE" "$WAVE_URL" && echo "wave ✓" || echo "wave ✗"
  else
    echo "wave (cached)"
  fi
done

echo ""
echo "━━━ Download complete ━━━"
echo "GRIB files: ${GRIB_DIR}"
echo ""
echo "Next step — convert to app format:"
echo "  python3 data/scripts/process-grib.py ecmwf ${RUN_ID}"
