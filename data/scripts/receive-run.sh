#!/bin/bash
# receive-run.sh — Extract an uploaded tarball of processed .bin files and
# atomically publish the run. Called from GitHub Actions after SSH upload.
#
# Usage: bash receive-run.sh <tarball_name> <run_id> <model>
#   tarball_name: e.g. gfs-20260417_06z.tar.gz (must exist in UPLOADS_DIR)
#   run_id: e.g. 20260417_06z
#   model: gfs (currently only gfs is supported)

set -euo pipefail

TARBALL="${1:?missing tarball name}"
RUN_ID="${2:?missing run id}"
MODEL="${3:-gfs}"

DATA_DIR="/app/data"
UPLOADS_DIR="${DATA_DIR}/uploads"
MODEL_DIR="${DATA_DIR}/${MODEL}"
TMP_DIR="${MODEL_DIR}/${RUN_ID}.tmp"
FINAL_DIR="${MODEL_DIR}/${RUN_ID}"
MIN_FILES=100  # Expect 114 (57 wind + 57 swell); allow a few missing hours.

mkdir -p "$MODEL_DIR"

if [ ! -f "${UPLOADS_DIR}/${TARBALL}" ]; then
  echo "ERROR: tarball not found: ${UPLOADS_DIR}/${TARBALL}"
  exit 2
fi

echo "[receive] Extracting ${TARBALL} → ${TMP_DIR}"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
tar -xzf "${UPLOADS_DIR}/${TARBALL}" -C "$TMP_DIR"

count=$(find "$TMP_DIR" -maxdepth 1 -name '*.bin' | wc -l)
echo "[receive] Extracted $count .bin files"
if [ "$count" -lt "$MIN_FILES" ]; then
  echo "ERROR: expected >= ${MIN_FILES} files, got $count"
  rm -rf "$TMP_DIR"
  exit 3
fi

# Atomic publish: single rename makes the run visible to the web server
# (which already filters out *.tmp dirs in /api/latest).
if [ -d "$FINAL_DIR" ]; then
  rm -rf "${FINAL_DIR}.old"
  mv "$FINAL_DIR" "${FINAL_DIR}.old"
fi
mv "$TMP_DIR" "$FINAL_DIR"
rm -rf "${FINAL_DIR}.old" 2>/dev/null || true

# Keep only the latest run per model
ls -1d "${MODEL_DIR}"/*/ 2>/dev/null \
  | grep -Ev '\.tmp/$|\.old/$' \
  | sort -r | tail -n +2 | xargs -r rm -rf

# Clean up upload
rm -f "${UPLOADS_DIR}/${TARBALL}"

echo "[receive] Published ${MODEL}/${RUN_ID}"
