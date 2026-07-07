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

  # 10# forces base-10: "08"/"09" would otherwise be parsed as invalid octal.
  AVAIL_HOUR=$((10#$HOUR - 8))
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
# Wave data moved from the standalone WAM model (wam/0p25/oper, files
# "-oper-fc") into the IFS tree (ifs/0p25/wave, files "-wave-fc").
WAVE_BASE="https://data.ecmwf.int/forecasts/${DATE}/${CYCLE}z/ifs/0p25/wave"

# ── Helper: download specific fields via byte-range from JSON index ──
download_fields() {
  local FULL_URL="$1"
  local INDEX_URL="$2"
  local OUTPUT="$3"
  local PARAMS="$4"   # comma-separated shortNames, e.g. "10u,10v"

  # Fetch index and extract byte ranges for the requested params
  local RANGES
  RANGES=$(curl -sf "$INDEX_URL" | python3 -c "
import sys, json
wanted = set(sys.argv[1].split(','))
ranges = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    rec = json.loads(line)
    if rec.get('param') in wanted:
        start = rec['_offset']
        end = start + rec['_length'] - 1
        ranges.append(f'{start}-{end}')
if ranges:
    print(','.join(ranges))
else:
    sys.exit(1)
" "$PARAMS" 2>/dev/null) || return 1

  # Download to a temp file, then move into place — a failed transfer must
  # not leave a partial file that later runs treat as cached.
  if curl -sf -H "Range: bytes=${RANGES}" -o "${OUTPUT}.tmp" "$FULL_URL"; then
    mv "${OUTPUT}.tmp" "$OUTPUT"
  else
    rm -f "${OUTPUT}.tmp"
    return 1
  fi
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
  ATMO_BASE="${DATE}${CYCLE}0000-${STEP}-oper-fc"
  WAVE_FILE_BASE="${DATE}${CYCLE}0000-${STEP}-wave-fc"

  # --- Wind (10u, 10v only — ~1.7 MB via byte-range) ---
  ATMO_FILE="${GRIB_DIR}/ecmwf_atmo_f${FHRP}.grib2"
  if [ ! -f "$ATMO_FILE" ]; then
    if download_fields "${ECMWF_BASE}/${ATMO_BASE}.grib2" "${ECMWF_BASE}/${ATMO_BASE}.index" "$ATMO_FILE" "10u,10v"; then
      echo -n "wind ✓  "
    else
      echo -n "wind ✗  "
    fi
  else
    echo -n "wind (cached)  "
  fi

  # --- Wave data (swh/mwd/pp1d only — ~2.7 MB via byte-range) ---
  WAVE_FILE="${GRIB_DIR}/ecmwf_wave_f${FHRP}.grib2"
  if [ ! -f "$WAVE_FILE" ]; then
    if download_fields "${WAVE_BASE}/${WAVE_FILE_BASE}.grib2" "${WAVE_BASE}/${WAVE_FILE_BASE}.index" "$WAVE_FILE" "swh,mwd,pp1d"; then
      echo "wave ✓"
    else
      echo "wave ✗"
    fi
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
