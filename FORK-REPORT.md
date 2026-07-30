# Integration report — `integration/all-forks`

Six feature branches, each independently built off the same `main`, merged in
sequence and re-verified as a whole. Per-fork reports are preserved under
`docs/forks/` (moved out of the root as part of each merge commit):
`perf-scrub.md`, `correctness-fixes.md`, `forecast-horizon.md`,
`swell-longperiod.md`, `buoys-spectrum.md`, `media-geo.md`.

Merge order (one merge commit each): perf-scrub → correctness-fixes →
forecast-horizon → swell-longperiod → buoys-spectrum → media-geo.

## Semantic reconciliations (beyond textual conflicts)

1. **H5 "honest status" re-expressed in GridStore terms** (correctness ×
   perf). `_loadHour` always assigns grids — a missing hour clears the
   layer instead of leaving the previous field on screen. Both
   `_loadSwellWithFallback` (async) and `_peekSwellResolved` (instant path,
   driven by the negative cache) return `{ grid, actualHour }`, and the
   status line now distinguishes four states:
   `fNNN loaded` / `fNNN — previewing fMMM while loading...` (the
   intentional never-wait preview, which always swaps to exact data) /
   `fNNN loaded — swell showing fMMM (nearest available)` /
   `fNNN — no wind/swell data for this hour`.

2. **hours.js drives GridStore** (forecast-horizon × perf).
   `_schedulePrefetch` enqueues all 85 `FORECAST_HOURS` steps with priority
   = timeline-index distance from the cursor (forward-biased);
   `_nearestCachedHour` walks the non-uniform axis by index; a new
   `_swellNeighborHours(hour)` replaces all ±3h/±6h arithmetic so the
   168→174 cadence change is handled everywhere (peek, async fallback,
   partitions). GridStore raw-tier LRU cap raised 700 MB → 1000 MB (a full
   85-step run's wind+swell int16 is ~880 MB vs ~590 MB at 57 steps). The
   old `_preload`/`_preloadAll` were superseded by the prioritized
   prefetcher and dropped.

3. **swellpart through GridStore** (swell-longperiod × perf).
   `_loadPartWithFallback` / new `_peekPartResolved` use
   `store.load/peek/isNegative` (worker decode, LRU, memoized 404s); the
   panel's swell-trains section fetches through the same store via the
   panel's `cachedLoad` hook — no raw `fetch()` path remains. Partition
   prefetch runs only while a partition sub-mode is active, only ±4
   timeline steps around the cursor, only ≤168h (swellpart files are ~4×
   a combined grid; full-timeline prefetch would evict the base run from
   the raw tier and pull ~440 MB/run).

4. **Partitions × 14-day timeline.** swellpart exists only for 0–168h. At
   extended hours in a partition mode, `swellPartGrid` is cleared so the
   view falls back to the combined field without flipping the run-level
   `partAvailable` flag (scrubbing back under 168h restores the partition
   view). `generate-demo.js` mirrors this: 85 wind + 85 swell + 57
   swellpart + points.bin = 228 files.

5. **Panel: three forks in one DOM.** perf's in-place `updateSelection`
   patching now also refreshes the swell-trains section + LP chip per hour
   (with explicit stale-row/chip clearing, since there is no innerHTML
   rebuild to do it implicitly); forecast's 14-Day Outlook rows and the
   extended divider render in the full `render()` pass and only get class
   toggles on scrub. Verified: the mini-map canvas survives scrubbing
   (1 canvas before and after a 6-stop scrub; harness reports
   `miniMapsCreatedDuringScrub: 0`).

6. **media-geo × index-based slider (real bug found).** `jumpToHour` wrote
   a raw forecast hour into the now index-based slider (and clamped at
   168). Fixed: `media-map.js` converts via `hourToIndex` (snaps to the
   nearest of the 85 non-uniform steps, clamps to 336h) and `media.js`
   passes unrounded hours. Marker bright/dim coupling reads absolute
   `runTime + hour` and was already axis-agnostic.

7. **Kept-both resolutions.** `coast-points.json`: correctness-fixes'
   regenerated file (3.0 MB, seaward-validated) — confirmed in tree.
   `media.js`: perf's lazy exifr import + media-geo's per-segment pick fix
   combined. `complete.mjs`: correctness' `deleteObject` size re-check +
   media-geo's `spotNameFor`. `app.js` init: media-geo's eager coastline
   load dropped in favor of perf's deferred `_kickCoastlineLoad`.

8. **CI guardrail reconciled** (`update-gfs.yml`): complete run = 85 wind
   + 85 swell + 57 swellpart + points.bin = **228** files; threshold set
   to **210** with the arithmetic in the workflow comment (no swellpart →
   171 fails; no extended range → 172 fails; a handful of transient
   per-hour failures still pass).

9. **verify/measure.js updated for the merged world**: scrub steps set the
   slider by `hourToIndex(h)` and the warm-phase preload gate is 170 grids
   (85×2), not 114.

## Test matrix (all on the merged branch, demo data)

| Suite | Result |
|---|---|
| `test:api` (incl. NDBC + media/spot-snap + upload-size tests) | 58/58 pass |
| `test:hires` | 10/10 pass |
| `test:build` / `node --test data/scripts/test` (incl. hour-mirror test w/ python3 probe) | 18 pass, 2 pre-existing skips |
| `public/js` tests (coastline, fixtures, panel sentinel, pumping) | 27/27 pass |
| `test:harness` | 19/19 pass |

## Perf vs perf-scrub baseline (DEMO_RES=hi, 1440×721; system Chrome; PORT=3007)

`verify/integration.json` (+ `integration-run2.json`) vs perf-scrub's
`verify/after.json`:

| Metric | perf-scrub after | integration (run1 / run2) |
|---|---|---|
| First heatmap paint | 834 ms | **731 / 884 ms** |
| Cold scrub mean / median | 49.5 / 25.4 ms | 63.8 / 30.5 ms · 60.8 / 28.2 ms |
| Warm scrub mean / median | 21.5 / 20.8 ms | **26.0 / 22.8 · 23.9 / 23.4 ms** |
| Panel-open scrub mean | 21.5 ms | **21.5 / 18.8 ms** |
| miniMapsCreatedDuringScrub | 0 | **0** |
| Heatmap CPU per refresh (mean) | 1.6 ms | **1.5 ms** |
| Long tasks during scrub | 0 | **0** |

Warm/panel numbers are within ~10–20% of baseline; the cold-scrub mean is
~25% higher because the prefetch pool now races 170 files instead of 114
(85-step timeline) — medians are within ~15% and long tasks stay at zero.

## Feature walk (PORT=3007, demo data, Chrome; screenshots in `verify/int-*.png`)

- `int-a-f336-extended.png` — slider at f336: hatched EXTENDED segment,
  "Aug 12 · extended", wind field renders, status `f336 loaded`.
- `int-b1-groundswell-mode.png`, `int-b2-panel-trains-lp.png` — Swell →
  Groundswell sub-mode (legend "Groundswell (m)", long dashes) + spot panel
  at f024: Swell Trains (5.2 ft 16 s W **Ground** sorted first, windsea +
  2 secondary trains with energy bars) + **LP 16s** chip + 14-Day Outlook.
- `int-b3-panel-extended-f336.png` — panel scrubbed to f336 with panel
  open: hour syncs, trains/LP clear (no partition data >168h), extended
  divider visible, mini-map not rebuilt.
- `int-c-buoy-46042-spectrum.png` — Buoys layer (73 stations rendered, 910
  from live NDBC), 46042 Monterey panel with live obs (7.5 ft, "41 min
  ago") and two-peak SVG spectrum (16 s swell + ~8 s windsea) with
  direction ribbon.
- `int-d1-photos-h0-bright.png` / `int-d2-photos-h48-dim.png` — photos
  layer at h=0 (5 bright / 4 dim) vs f048 (all 9 dim);
  `int-d3-lightbox.png` — lightbox with spot name, verified-capture badge,
  frame-relative time; "jump timeline" moves the index slider correctly
  (photo before runTime → clamps to f000).
- `int-e1-pumping-list.png` / `int-e2-pumping-row-panel.png` — pumping Top
  100; row #1 (Barbados Soup Bowl, 2.3 ft @ 18 s, 7 mph NE) matches the
  opened panel exactly (2.3 ft 18 s swell, 7 mph NE wind) — the H3
  list-vs-panel agreement holds post-merge.
- `int-f-midpacific-no-confident-rating.png` — click at 49.33°N 179.96°E:
  nearest coast resolves 219.3 km away (the real island, not the phantom
  1.3 km seam artifact), no coast compass/mini-map, rating shows a
  non-confident 0.2/Flat — H4 fix intact.
- Console: **zero page errors** across the whole walk; one benign MapLibre
  vertex-bucket warning from the hires coastline (pre-existing).

## Known limitations / degradations (all deliberate, none silent)

- **Partition sub-modes beyond 168h show the combined field** (no swellpart
  data exists there — matches the pipeline; the panel's trains section
  hides at extended hours). The sub-toggle stays on the chosen mode so
  scrubbing back restores it.
- **Cold-scrub mean is ~25% above the perf-scrub baseline** (more files in
  the prefetch race); warm/panel-path numbers hold.
- swell-longperiod's per-hour partition-miss behavior is kept: if a
  partition file and all neighbor steps are known-missing while a partition
  mode is active, the app reverts to Combined and hides the toggle for the
  run (fork semantics).
- Demo-data artifacts (rectangular land boxes, Pacific-weighted swell)
  are unchanged — e.g. demo swell trains query null inside the demo's
  "North America" box; real GFS data does not have this.
- `process-grib.py`'s combined swellpart+cube path still needs its first
  real CI run (flagged by both forecast-horizon and swell-longperiod; the
  85-hour + 12-param writers are unit/mirror-tested locally).
