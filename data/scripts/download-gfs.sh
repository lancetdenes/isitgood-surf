#!/bin/bash
# download-gfs.sh — Download GFS + GFS-Wave GRIB2 data from NOMADS
#
# Downloads surface wind (10m U/V) and wave data (height, direction, period)
# for forecast hours 0-168 every 3 hours, then 174-336 every 6 hours.
#
# Hour layout mirrors public/js/hours.js / data/scripts/lib/forecast-hours.js
# — keep the seq ranges below in sync with those modules.
#
# Usage:
#   bash data/scripts/download-gfs.sh              # downloads latest available run
#   bash data/scripts/download-gfs.sh 20260409 00  # downloads specific run
#
# After downloading, run: python3 data/scripts/process-grib.py gfs
# to convert GRIB2 → binary format for the app.
#
# Prerequisites: curl or wget

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")"

# Determine run date/cycle
if [ $# -ge 2 ]; then
  DATE="$1"
  CYCLE="$2"
else
  # Find the latest available GFS run
  # GFS runs at 00, 06, 12, 18 UTC; data appears ~4-5 hours after run time
  NOW_UTC=$(date -u +%Y%m%d%H)
  DATE=$(echo "$NOW_UTC" | cut -c1-8)
  HOUR=$(echo "$NOW_UTC" | cut -c9-10)

  # Round down to nearest available cycle (accounting for ~5hr delay).
  # 10# forces base-10: "08"/"09" would otherwise be parsed as invalid octal.
  AVAIL_HOUR=$((10#$HOUR - 5))
  if [ $AVAIL_HOUR -lt 0 ]; then
    AVAIL_HOUR=$((AVAIL_HOUR + 24))
    DATE=$(date -u -v-1d +%Y%m%d 2>/dev/null || date -u -d "yesterday" +%Y%m%d)
  fi

  if [ $AVAIL_HOUR -ge 18 ]; then CYCLE="18"
  elif [ $AVAIL_HOUR -ge 12 ]; then CYCLE="12"
  elif [ $AVAIL_HOUR -ge 6 ]; then CYCLE="06"
  else CYCLE="00"
  fi
fi

RUN_ID="${DATE}_${CYCLE}z"
GRIB_DIR="${DATA_DIR}/grib/gfs/${RUN_ID}"
mkdir -p "$GRIB_DIR"

echo "━━━ Downloading GFS run: ${RUN_ID} ━━━"
echo "Output: ${GRIB_DIR}"
echo ""

NOMADS_BASE="https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
WAVE_BASE="https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl"

# Partitioned swell fields (verified against the NOMADS filter CGI and the
# GRIB .idx inventory, 2026-07-29):
#   SWELL/SWDIR/SWPER live at levels "1 in sequence" / "2 in sequence" /
#   "3 in sequence" → filter params lev_1_in_sequence etc.
#   WVHGT/WVDIR/WVPER (wind sea) live at level "surface" → lev_surface.
# The var_* filter restricts lev_surface to just the windsea fields, so the
# subset returns exactly 12 GRIB messages (~7 MB per hour).
SWELLPART_VARS="var_SWELL=on&var_SWDIR=on&var_SWPER=on&var_WVHGT=on&var_WVDIR=on&var_WVPER=on&lev_surface=on&lev_1_in_sequence=on&lev_2_in_sequence=on&lev_3_in_sequence=on"

# Download to a temp file, then move into place — a failed transfer must not
# leave a partial file that later runs treat as cached.
fetch() {
  local URL="$1" OUTPUT="$2"
  if curl -sf -o "${OUTPUT}.tmp" "$URL"; then
    mv "${OUTPUT}.tmp" "$OUTPUT"
  else
    rm -f "${OUTPUT}.tmp"
    return 1
  fi
}

# Forecast hours: 0 to 168 every 3 hours (mirror of hours.js BASE range)
HOURS=$(seq 0 3 168)
TOTAL=$(echo "$HOURS" | wc -w | tr -d ' ')
COUNT=0

for FHR in $HOURS; do
  FHRP=$(printf "%03d" "$FHR")
  COUNT=$((COUNT + 1))
  echo -n "  [${COUNT}/${TOTAL}] f${FHRP}: "

  # --- Surface wind (10m U, V) ---
  WIND_FILE="${GRIB_DIR}/gfs_wind_f${FHRP}.grib2"
  if [ ! -f "$WIND_FILE" ]; then
    WIND_URL="${NOMADS_BASE}?dir=%2Fgfs.${DATE}%2F${CYCLE}%2Fatmos&file=gfs.t${CYCLE}z.pgrb2.0p25.f${FHRP}&var_UGRD=on&var_VGRD=on&lev_10_m_above_ground=on"
    fetch "$WIND_URL" "$WIND_FILE" && echo -n "wind ✓  " || echo -n "wind ✗  "
  else
    echo -n "wind (cached)  "
  fi

  # --- Wave data (sig height, primary direction, primary period) ---
  WAVE_FILE="${GRIB_DIR}/gfs_wave_f${FHRP}.grib2"
  if [ ! -f "$WAVE_FILE" ]; then
    WAVE_URL="${WAVE_BASE}?dir=%2Fgfs.${DATE}%2F${CYCLE}%2Fwave%2Fgridded&file=gfswave.t${CYCLE}z.global.0p25.f${FHRP}.grib2&var_HTSGW=on&var_DIRPW=on&var_PERPW=on"
    fetch "$WAVE_URL" "$WAVE_FILE" && echo -n "wave ✓  " || echo -n "wave ✗  "
  else
    echo -n "wave (cached)  "
  fi

  # --- Partitioned swell (3 swell trains + wind sea) ---
  PART_FILE="${GRIB_DIR}/gfs_swellpart_f${FHRP}.grib2"
  if [ ! -f "$PART_FILE" ]; then
    PART_URL="${WAVE_BASE}?dir=%2Fgfs.${DATE}%2F${CYCLE}%2Fwave%2Fgridded&file=gfswave.t${CYCLE}z.global.0p25.f${FHRP}.grib2&${SWELLPART_VARS}"
    fetch "$PART_URL" "$PART_FILE" && echo "part ✓" || echo "part ✗"
  else
    echo "part (cached)"
  fi
done

# ── Extended-range forecast: f174-f336 at 6-hourly steps (days 7-14) ──
# (mirror of hours.js EXT range)
# Partitioned swell is deliberately NOT downloaded for the extended range:
# partition sub-layers and the panel's swell-trains section cover 0-168h
# only; beyond that the UI falls back to the combined field.
EXT_HOURS=$(seq 174 6 336)
EXT_TOTAL=$(echo "$EXT_HOURS" | wc -w | tr -d ' ')
EXT_COUNT=0

echo ""
echo "━━━ Extended range (days 7-14, 6-hourly) ━━━"
for FHR in $EXT_HOURS; do
  FHRP=$(printf "%03d" "$FHR")
  EXT_COUNT=$((EXT_COUNT + 1))
  echo -n "  [${EXT_COUNT}/${EXT_TOTAL}] f${FHRP}: "

  WIND_FILE="${GRIB_DIR}/gfs_wind_f${FHRP}.grib2"
  if [ ! -f "$WIND_FILE" ]; then
    WIND_URL="${NOMADS_BASE}?dir=%2Fgfs.${DATE}%2F${CYCLE}%2Fatmos&file=gfs.t${CYCLE}z.pgrb2.0p25.f${FHRP}&var_UGRD=on&var_VGRD=on&lev_10_m_above_ground=on"
    fetch "$WIND_URL" "$WIND_FILE" && echo -n "wind ✓  " || echo -n "wind ✗  "
  else
    echo -n "wind (cached)  "
  fi

  WAVE_FILE="${GRIB_DIR}/gfs_wave_f${FHRP}.grib2"
  if [ ! -f "$WAVE_FILE" ]; then
    WAVE_URL="${WAVE_BASE}?dir=%2Fgfs.${DATE}%2F${CYCLE}%2Fwave%2Fgridded&file=gfswave.t${CYCLE}z.global.0p25.f${FHRP}.grib2&var_HTSGW=on&var_DIRPW=on&var_PERPW=on"
    fetch "$WAVE_URL" "$WAVE_FILE" && echo "wave ✓" || echo "wave ✗"
  else
    echo "wave (cached)"
  fi
done

echo ""
echo "━━━ Download complete ━━━"
echo "GRIB files: ${GRIB_DIR}"
echo ""
echo "Next step — convert to app format:"
echo "  python3 data/scripts/process-grib.py gfs ${RUN_ID}"
