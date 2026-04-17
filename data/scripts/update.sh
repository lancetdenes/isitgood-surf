#!/bin/bash
# update.sh — Download and process the latest model run
#
# Usage:
#   bash data/scripts/update.sh gfs
#   bash data/scripts/update.sh ecmwf
#   bash data/scripts/update.sh all     # both models
#
# Designed to be called by the scheduler in server.js.
# Downloads GRIB data, processes to binary, and cleans up old runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")"
MODEL="${1:-all}"
MAX_RUNS=1  # Keep only the latest run per model (3GB volume is tight)

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"
}

download_and_process() {
  local model="$1"
  log "Starting ${model} update..."

  # Download
  if bash "${SCRIPT_DIR}/download-${model}.sh"; then
    log "${model} download complete"
  else
    log "${model} download failed"
    return 1
  fi

  # Process GRIB → binary
  if python3 "${SCRIPT_DIR}/process-grib.py" "${model}"; then
    log "${model} processing complete"
  else
    log "${model} processing failed"
    return 1
  fi

  # Delete GRIB files immediately after processing (saves ~1.5GB)
  local grib_dir="${DATA_DIR}/grib/${model}"
  if [ -d "$grib_dir" ]; then
    log "Removing GRIB files to free space"
    rm -rf "$grib_dir"
  fi

  # Clean up old runs (keep only MAX_RUNS most recent)
  local model_dir="${DATA_DIR}/${model}"
  if [ -d "$model_dir" ]; then
    local runs
    runs=$(ls -1d "$model_dir"/*/ 2>/dev/null | sort -r)
    local count=0
    for run_dir in $runs; do
      count=$((count + 1))
      if [ $count -gt $MAX_RUNS ]; then
        log "Removing old run: $(basename "$run_dir")"
        rm -rf "$run_dir"
      fi
    done
  fi

  # Clean up old GRIB files too
  local grib_dir="${DATA_DIR}/grib/${model}"
  if [ -d "$grib_dir" ]; then
    local grib_runs
    grib_runs=$(ls -1d "$grib_dir"/*/ 2>/dev/null | sort -r)
    local gcount=0
    for grib_run_dir in $grib_runs; do
      gcount=$((gcount + 1))
      if [ $gcount -gt $MAX_RUNS ]; then
        log "Removing old GRIB: $(basename "$grib_run_dir")"
        rm -rf "$grib_run_dir"
      fi
    done
  fi

  log "${model} update done"
}

if [ "$MODEL" = "all" ]; then
  download_and_process "gfs"
  download_and_process "ecmwf"
elif [ "$MODEL" = "gfs" ] || [ "$MODEL" = "ecmwf" ]; then
  download_and_process "$MODEL"
else
  echo "Usage: $0 {gfs|ecmwf|all}"
  exit 1
fi
