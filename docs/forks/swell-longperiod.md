# Fork report: partitioned / long-period swell (`fork/swell-longperiod`)

## Goal

Surface long-period groundswell like windy.com's swell layers: distinct swell
trains with height/period/direction, so a 1 ft 18 s forerunner from a distant
storm is visible even when local windsea dominates the combined HTSGW field.

## What changed (by commit)

1. **`feat(pipeline)`** — `download-gfs.sh` fetches a second per-hour GRIB
   subset with the partitioned fields; `process-grib.py` gains
   `process_gfs_swellpart()` writing `swellpart_fNNN.bin` (SRF2, 12 params:
   partitions 1-3 × H/D/P, then windsea H/D/P). `update-gfs.yml` gzips +
   uploads `swellpart_*.bin` to R2 and the file-count guardrail moved
   100 → 160 (complete run = 228 files). The existing `swell_fNNN.bin`,
   `points.bin` cube, and Fly tarball path are untouched.
2. **`feat(demo)`** — `generate-demo.js` synthesizes coherent partition data:
   a 15-18 s groundswell radiating from drifting N-Pacific/Southern-Ocean
   storms, a 10-12 s secondary train, a patchy 8-9 s third train, and 5-8 s
   windsea; the combined field is now the RSS of the components.
3. **`feat(ui)`** — swell sub-toggle **Combined | Groundswell | Windsea**
   (visible only while the Swell layer is active and the run has partition
   files). `grid.js` derives 3-param views from the 12-param grid; heatmap +
   crest particles are driven by the selected view. Partition grids load
   lazily — the default path never fetches them.
4. **`feat(panel)`** — "Swell trains" section: up to 3 partitions + windsea
   for the selected hour, sorted by contribution (H²T), each row showing
   height (ft), period (s), travel-direction arrow + FROM cardinal/degrees,
   and a relative-energy bar. Additive `LP Ns` chip when a partition ≥ 13 s
   exists. `ratings.js` scoring is unchanged (still combined fields).
5. **`test(verify)`** — Playwright script + screenshots under `verify/`.

## NOMADS filter URL research (verified live, 2026-07-29)

The `.idx` inventory for `gfswave.tCCz.global.0p25.fNNN.grib2` lists the
partition fields at GRIB level "N in sequence":

```
SWELL:1 in sequence / SWELL:2 in sequence / SWELL:3 in sequence
SWPER:1-3 in sequence,  SWDIR:1-3 in sequence
WVHGT / WVDIR / WVPER : surface
```

The working `filter_gfswave.pl` query (returns exactly 12 GRIB messages,
~7.2 MB per hour — verified by parsing message headers):

```
&var_SWELL=on&var_SWDIR=on&var_SWPER=on&var_WVHGT=on&var_WVDIR=on&var_WVPER=on
&lev_surface=on&lev_1_in_sequence=on&lev_2_in_sequence=on&lev_3_in_sequence=on
```

`lev_surface` combined with the `var_*` filter selects only the windsea
fields (not HTSGW etc.). cfgrib exposes the partitions as `shts`/`swdir`/
`mpts` with a 3-long `orderedSequenceData` dimension and windsea as
`shww`/`wvdir`/`mpww` at `surface` — `process_gfs_swellpart` filters on
`typeOfLevel` and accepts alternate shortNames defensively.

`process_gfs_swellpart` was tested end-to-end on a **real f000 GRIB**
downloaded via that URL (local xarray/cfgrib): 1440×721 grid, sane ranges
(partition-1 heights ≤ 8.1 m, periods ≤ 22.9 s, direction ≤ 360°, correct
land/absence zeros).

## Period encoding choice (groundswell/windsea particles)

**Crest-dash length scales with period** (10 s = default dash, clamped
0.5×-2×); the heatmap palette stays *height* in every mode. Rationale: one
variable per visual channel — reusing the height palette keeps heights
comparable across Combined/Groundswell/Windsea and the legend truthful, while
dash length maps to physical wavelength (L ∝ T²): long lazy crest lines for
18 s groundswell vs short choppy ticks for 6 s windsea reads instantly.
A period-tinted palette would have made "3 m of windsea" and "1 m of
groundswell" incomparable in the same visual system. Combined mode renders
exactly as before (flag off). No particle speed tuning globals were touched.

## File size impact

| artifact | size |
|---|---|
| swellpart GRIB subset (download, per hour) | 7.2 MB |
| `swellpart_fNNN.bin` raw (1440×721, 12 params) | 24.9 MB |
| same, gzip -9 (as stored/served from R2) | 7.7 MB |
| per run (57 hours, 0-168h only) | +1.42 GB raw → **+439 MB on R2** |
| CI extra GRIB download per run | ~410 MB |
| demo `swellpart_fNNN.bin` (360×181) | 1.5 MB |

Extended-range hours (174-336) deliberately skip partitions — the slider and
panel only cover 0-168 h and "score next week" stays on combined. `points.bin`
is unchanged, so panel *ratings* stay two ~1 KB range reads; the trains
section costs one ~7.7 MB (wire) grid per *viewed* hour, promise-cached and
shared with the map-layer cache.

## Fallback behavior (old runs without swellpart)

- Sub-toggle only appears after a cheap `HEAD swellpart_f000.bin` probe
  succeeds; re-probed per run/model.
- If a fetch 404s while a partition mode is active, the app reverts to
  Combined and hides the toggle (`_setPartUnavailable`).
- The panel's trains section simply stays hidden when the file is missing.
- Verified by route-blocking `swellpart_*.bin` in Playwright
  (`verify/06-fallback-combined.png`).

## Screenshots (`verify/`)

- `01-swell-combined.png` — combined heatmap + crest particles (prod look)
- `02-swell-groundswell.png` — longest-period partition: storm-radial
  direction field, longer dashes, "Groundswell (m)" legend
- `03-swell-windsea.png` — windsea bands, short choppy dashes
- `04-panel-swell-trains.png` / `05-panel-closeup.png` — trains list
  (4.8 ft 16 s W **Ground** / 3.6 ft 6 s WNW **Windsea** / 1.3 ft 10 s S
  **Swell**) + `LP 16s` chip; the 16 s train sorts first despite windsea
  being present — exactly the forerunner-visibility goal
- `06-fallback-combined.png` — swellpart blocked → combined-only, no toggle

Reproduce: `node data/scripts/generate-demo.js && PORT=3003 node server.js`,
then `node verify/verify-swellpart.mjs` (Playwright, channel `chrome`).

## Verification run

- `npm run test:api` — 27/27 pass; `test:build` and `test:hires` also pass.
- Real-GRIB processing test as above (xarray/cfgrib available locally).
- Playwright flow: toggle visibility, all three modes, panel trains, LP chip,
  404 degrade — all asserted, output logged in the script.

## Risks / follow-ups

- **Pipeline needs a real CI run.** The workflow changes (download loop, gzip
  glob, upload include, guardrail 160) are untested in GitHub Actions; CI's
  eccodes/cfgrib versions could expose different shortNames (fallbacks are in
  place, but watch the first run's logs). A partial partition-download failure
  does *not* abort the run — the UI degrades per-hour via the ±3/±6 h
  fallback.
- **R2 storage/egress** grows ~440 MB per run (~880 MB with the two-run
  retention). Egress is free on R2 but users on partition modes pull ~7.7 MB
  per scrubbed hour; only ±3/6 h are preloaded (and only while a partition
  mode is active).
- **CI runtime**: +410 MB download + 57 extra cfgrib decodes; expect several
  extra minutes against the 45-min job timeout.
- Groundswell view picks the longest-period partition per cell with
  height ≥ 0.1 m; GFS partition indices are not continuous entities, so cell
  boundaries between competing trains can look patchy on real data — evaluate
  on the first real run.
- `verify/verify-swellpart.mjs` imports `playwright`, resolved locally via a
  symlink into an npx cache (not committed); run with any playwright install
  on PATH/node_modules.
