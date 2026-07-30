# Fork report — correctness-fixes

Branch `fork/correctness-fixes`. Fixes the 5 High findings, M2, M3, and four
adjacent one-liner Lows from `docs/REVIEW-main-correctness.md`. Each fix was
reproduced with the review's own measurement methodology against the live run
`gfs/20260729_18z` (swell/wind f000 pulled from R2) and the shipped
`public/assets/coastline-hires.bin`, then re-measured after the fix.

Regression: `test:api` 28/28, `test:hires` 10/10, `test:build` 17/17,
`node --test data/scripts/test` 17/17, all `public/js/test` 27/27,
`test:harness` 19/19 pass. Browser sanity via Playwright (channel chrome) on
`PORT=3006` with demo data — map + wind field render, coast-click panel
(compass + hourly + 7-day) renders, pumping shows 100 ranked rows, pumping-row
click flies + opens the panel, zero page errors. Screenshots in `verify/`.

---

## H4 — phantom coastline at lon ≈ 180 (commit 47b177f)

**Repro:** `findNearestCoastHires(49.33, 179.96)` → coast **1.3 km away**,
`unreliableBearing:false` (a fabricated coast in the open Pacific). 26 indexed
segment midpoints from Greenwich-crossing features (vertex pairs like
`359.93 → 0.00`) landed in the lon 175–185 band.

**Fix:** unwrap each seam-crossing segment's endpoint lons to be continuous
(`|a−b| ≤ 180`) before computing the KD-index midpoint, and shift the segment
into the query's longitude frame before planar projection. Applied to the
browser index (`coastline-hires.js`), the Node builder mirror
(`find-nearest-coast-node.js`), with helpers in `coastline-shared.js`.

**After:** probe distance 1297.7 m → **219.3 km** (a real island); phantom
midpoints in the band **26 → 0**. Rockaway / Normandy control probes unchanged.
Added a regression test asserting no seam segment survives in the 175–185 band.

## H2 — inverted seaward bearings in coast-points.json (commit c1cddd3)

**Repro (1-in-7 sample, 30/50/80/120 km wet probes along `sw` and its flip):**
seaward-only-wet 27.9%, **inverted (only flip reaches ocean) 13.9%**,
both-wet 25.4%, neither 32.7%.

**Fix:** `findNearestCoastNode` now accepts an optional swell grid and runs the
shared `validateSeaward` wet-test (flip when winding-guess faces land, flag
`bothFailed` when neither direction reaches ocean).
`build-coast-points-hires.js` loads the latest local swell grid (halts if none;
`ALLOW_UNVALIDATED=1` overrides), flips failed bearings, drops no-ocean points.
Also fixed `grid-loader.js`, which still expected the retired float32 `SURF`
format and threw on any modern SRF2 int16 grid (broke `fill-named-offshore.js`
and `offshore.test.js`) — it now delegates to `public/js/grid.js`.

**After (regenerated `public/data/coast-points.json`, 6.0 MB → 3.0 MB):**
33,289 points kept, 7,220 bearings flipped, 29,871 no-ocean points dropped.
Re-probe: **inverted 13.9% → 0.0%**, neither 32.7% → 0.1%.

## H1 — panel discarded GSHHG bearing for the coarse grid ring (commit 4ee87e7)

**Repro (310 named spots where both estimators fire, vs live grid):**
`|seaward(grid-ring) − seaward(GSHHG)|` median **29.9°**, p75 55.0°, p90 74.5°,
max 144.5°; 32.3% differ by >45°. `panel.js` used `data.coast || coast`, so the
coarse ring won whenever non-null.

**Fix:** `effectiveCoast` now prefers the GSHHG lookup (`coast`) whenever it is
reliable, using the grid ring only as a fallback. Effective bearing changes for
**310/310** spots. Also folded in **L5**: `fetchRange` now requires HTTP 206 +
exact byte length so a Range-ignoring proxy can't feed the cube reader header
bytes as forecast values.

**Example f000 rating swings (before = grid-ring, after = GSHHG):**
- Pleasure Point: 5.1 Fair → **2.8 Marginal** (grid sw 195° vs GSHHG 320°)
- Steamer Lane: 5.3 Fair → **3.1 Marginal** (grid sw 203° vs GSHHG 278°)
- Vanimo: wind "Light side" → **"Clean offshore"** (grid sw 38° vs GSHHG 266°)

## H3 — leaderboard ranked on land-contaminated swell (commit d3dd03d)

**Repro:** 419/523 named spots (80%) sit in a land-touching cell. Old
pumping.js (plain bilinear + unmasked angular mean) vs the masked read:
height understated median **0.48 m** (p90 1.32, max 2.09); direction off median
**47.8°** (p90 146.3, max 179.6).

**Fix:** new `interpolateSwellMasked` (renormalized bilinear over ocean corners
+ angular mean, mirroring `forecast.js`'s cube reader); `scoreSpot` uses it and
drops fully-inland spots. Test doubles without raw arrays keep the old path.
Also folded in **L9** (pumping-row click no longer throws when the coastline
isn't loaded — lookup moved inside the try) and **L1** (render-generation guard
so a tab/source switch mid-computation can't overwrite the new tab).

**After:** 53 of the top-100 "right now" rows change. list-vs-panel examples now
agree: Pleasure Point 0.6ft@2s from 355° → **4.6ft@16s from 206°**, Ocean Beach
SF 0.2ft@0s → **5.8ft@13s from 239°**, Pipeline 0.8ft@1s → **6.1ft@11s from 73°**.

## H5 — stale/silently-substituted forecast hours (commit 63f050f)

**Fix:** grids are always assigned in `_loadHour` (a missing hour clears the
layer instead of leaving the previous hour's field on screen — all renderers
handle null); `_loadSwellWithFallback` returns `{grid, actualHour}`; the status
line now says `fNNN — no wind/swell data for this hour` or
`fNNN loaded — swell showing fMMM (nearest available)`. No numeric probe — this
is a UI-honesty defect; verified by reading the loader path and browser sanity.

## M2 — path traversal in the Express dev/Fly server (commit 1c41928)

**Repro (local):** `GET /api/runs/..%2F..%2Fcorrectness-fixes%2Fdata` returned
`["scripts","reference","gfs","demo"]` (arbitrary directory listing);
`/api/forecast?path=/../../../../etc` read outside the app root.

**Fix:** whitelist `model` ∈ {gfs,ecmwf,demo}, validate `run` against
`/^\d{8}_\d{2}z$/` (or `demo`), and resolve `/api/forecast`'s path with
`path.resolve` + a `DATA_DIR`-prefix check. **After:** traversal probes → 400;
legit runs/latest/forecast unchanged.

## M3 — presigned PUT with no size binding (commit c7c70f4)

**Fix:** `completeUpload` re-checks the actual `head.bytes` against the per-kind
cap (`maxBytesFor`), deletes the object and throws 413 before the row can go
live — so an oversize body claimed as small at presign time is never served.
Added a unit test for the reject-and-delete path (28/28 api tests pass).

## L10 — directory race in run listing (commit bfbb6d6)

**Fix:** wrapped the `statSync` isDirectory filter (`isDirSafe`) so a run dir
deleted mid-request during an atomic swap no longer 500s the route (and no
longer bounces `/api/latest` to synthetic demo data).

---

## Skipped (per instructions)
M6 (EXIF — sibling fork), all performance findings (separate fork).

## Lows not taken
L2/L3/L4/L6/L7/L8/L11/L12 — not one-liners adjacent to touched code, or require
schema/pipeline changes out of scope for this sweep.

## Risks
- **H1/H3 change displayed scores for many spots** — intended. Coastal spots
  whose grid-ring bearing was wrong now rate differently, and 53% of the
  "right now" leaderboard reshuffles. Some spots that previously showed a
  confident rating now read "coast unknown" when GSHHG can't find a reliable
  bearing (mid-ocean / both-seaward-failed) — this is the honest state.
- **H2 regenerated `coast-points.json` is bound to a specific run's swell
  grid.** Enclosed-water/inland points are now dropped (63k → 33k), so the
  mysto leaderboard covers fewer candidate points but none facing inland. The
  CI build step must have a swell grid available (or set `ALLOW_UNVALIDATED=1`)
  — it now halts rather than silently emitting unvalidated bearings.
- **H4** changes indexing for the 26 seam-crossing features only; all control
  probes and the full hires fixture suite are unchanged.
