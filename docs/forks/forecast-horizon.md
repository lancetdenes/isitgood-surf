# Fork report: forecast-horizon — 14-day forecast like Surfline

Branch `fork/forecast-horizon`. Extends the visible forecast from 7 days
(168h) to 14 days (336h). The pipeline already downloaded and uploaded
f174–f336 @ 6h to R2; this fork exposes those 28 extra steps in the UI and
extends the point cube + demo data to match.

## What changed

### Shared hour layout (single source of truth + enforced mirrors)
- **`public/js/hours.js`** (new, browser ESM): `FORECAST_HOURS` =
  0–168 @3h + 174–336 @6h (85 steps), plus `hourToIndex`/`indexToHour`/
  `isExtended`/`baseHours`/`extendedHours`.
- **`data/scripts/lib/forecast-hours.js`** (new, CommonJS mirror) for
  `server.js` and `generate-demo.js`.
- **`data/scripts/process-grib.py`**: new `forecast_hours()` (Python mirror);
  heavy imports (`xarray`, `numpy`) no longer hard-exit at import time so the
  function is unit-testable — `main()` still errors clearly without them.
- **`data/scripts/test/forecast-hours.test.js`** (new): asserts the layout
  (85 steps, 3h→6h boundary at 168→174) and that all three mirrors agree —
  including a `python3` probe of process-grib.py (skips if python3 missing).
- `download-gfs.sh` already had both seq ranges; comments now point at the
  mirrors.

### Timeline UI (`index.html`, `ui.js`, `app.js`, `style.css`)
- Slider is now **index-based** (min 0, max 84, step 1) over
  `FORECAST_HOURS` instead of a raw-hour range — one slider step is always
  one forecast step, so scrubbing is smooth across the 168h cadence change.
- Extended-range visual cue: the track beyond 168h is a **dimmer hatched
  segment** with a small `EXTENDED` label above it (split point set from JS
  via a `--ext-split` CSS var so CSS never hardcodes the boundary); the hour
  display appends `· extended` beyond 168h.
- Ticks are absolutely positioned on the index axis (flex spacing would
  drift from the thumb on a non-uniform hour axis). Core range keeps 24h day
  majors + 12h minors; extended range gets 24h day labels (alternating
  major/minor so phones, which hide minors, show 48h days), dimmed via
  `.tick-ext`.
- Play loop advances by index (3h steps, then 6h), wraps at 336h.
- Preload paths (`_preload`, `_preloadAll`) cover all 85 hours.
- New `syncTimeline(hour)` export: the slider now follows programmatic hour
  jumps (pumping peak-hour clicks previously left the slider stale).

### Spot panel (`panel.js`, `forecast.js`)
- Daily section is now a **14-Day Outlook**: week 2 gets a dashed
  `extended · lower confidence` divider and slightly dimmed rows
  (`.rp-day-ext`), full-opacity on hover/selection. Falls back to the
  "7-Day Outlook" label when a run's cube only covers 168h (older runs).
- `forecast.js` needed **no functional change**: SCUB's header stores an
  explicit per-hour table (`hour: hours[h]` everywhere), so non-uniform
  spacing decodes correctly; verified against an 85-hour cube. Comments
  updated.

### Pumping panel (`pumping.js`)
- `hourRangeFor()` now reads `baseHours()`/`extendedHours()` from the shared
  module instead of its own hardcoded 57×3h / 174–336×6h lists. Behavior
  unchanged (verified: week + next tabs both return Top 100).

### Pipeline
- `process-grib.py`: per-hour processing uses `forecast_hours()`
  (same 85 hours as before — extended range was already processed);
  **`cube_hours` now covers all 85 hours** instead of stopping at 168.
- `generate-demo.js`: emits all 85 demo steps (f000–f336) + an 85-hour cube,
  so the feature is locally testable end-to-end.
- `server.js`: `/api/forecast` (legacy path) and cache warmup iterate
  `FORECAST_HOURS`; grid cache cap raised 150→200 (a full run is now 170
  grid files — the old cap would thrash).
- `.github/workflows/update-gfs.yml`: guardrail raised `< 100` → `< 160`
  (full run = 85 wind + 85 swell + points.bin = 171 files), so a
  silently-missing extended range now fails CI instead of shipping.

### Not changed (per constraints)
Data resolution, SRF2/SCUB format versions (SCUB just has more hour-table
entries — same version 1 layout), visual design language, particle tuning.

## How verified

- `node --test data/scripts/test` (incl. new mirror test w/ python3 probe):
  **21 pass, 2 skipped** (pre-existing skips needing reference data).
- `npm run test:api`: **27 pass**. `public/js/test/pumping.test.js`: 5 pass.
- `npm run demo` data + server on **PORT=3002**, driven by Playwright
  (npx-installed, `channel: 'chrome'`, isolated instance — the shared MCP
  browser was being used concurrently by another session). Screenshots in
  `verify/`:
  - `timeline-h000.png` — full 14-day timeline, hatched extended segment +
    EXTENDED label, day ticks out to day 14.
  - `timeline-h168-boundary.png`, `timeline-h336.png` — slider at the
    boundary and at the end (f336 loaded).
  - Scrub across the boundary: f162→f165→f168→f174→f180→f186 loaded in
    order; `· extended` suffix appears exactly beyond 168h; play mode
    crosses the boundary (idx 55 → 67, f234).
  - `panel-extended-hour.png`, `panel-14day-outlook.png` — spot panel opened
    at h=336: 15 day rows, "14-Day Outlook", divider before week 2, panel
    hour synced (Wed 10 PM selected).
  - `pumping-next-week.png` — "score next week" Top 100 with day-7–14 peak
    hours; `pumping-row-jump-extended.png` — row click flies to the spot,
    slider lands in the hatched segment (f180, "Aug 6 · extended"), rating
    panel shows real extended-hour data.
- `process-grib.py`: **could not run end-to-end locally** (no xarray/cfgrib);
  the hours function is unit-tested via the python3 probe, and `build_cube`
  is exercised indirectly by its JS twin (`generate-demo.js` cube, read back
  by the browser). The full GRIB→bin→cube path needs a real CI run.

## Risks / compatibility

- **CI memory/time (needs a real CI run to prove).** `build_cube` holds all
  decoded per-hour float32 grids plus the int16 cube in memory. At 0.25°
  (1440×721) the float arrays grow ~1.4 GB → ~2.1 GB (57→85 hours) and the
  cube ~0.6 GB → ~0.9 GB. Should fit a 16 GB public runner, but watch the
  first workflow run; if it OOMs, quantize per-hour after a first max-abs
  scan pass instead of retaining floats.
- **R2 storage**: points.bin grows ~1.5× (~0.9 GB/run); prune policy keeps
  2 runs, so bucket usage rises accordingly. Per-hour extended grids were
  already being uploaded.
- **Old frontend + new data**: fine. Grid files are per-hour and unchanged;
  the old SCUB reader iterates the header's hour table, so an 85-hour cube
  decodes correctly (old panel would simply render more day rows; old
  timeline still stops at 168h).
- **New frontend + old data** (e.g. a run processed before this change, or
  a partially-failed extended download): timeline hours >168 fall back to
  the nearest available swell grid / keep last wind grid, status still
  updates; the panel falls back to the "7-Day Outlook" label when the cube's
  hour table stops at 168; pumping "next" shows its existing "extended
  forecast not available" message. No hard failures.
- **`/api/forecast` (legacy server path)** now reads 85 files per request;
  cache cap raised to compensate. The client no longer uses this endpoint
  (panel reads the cube), so impact is limited to direct API users.
- Demo cube grew to ~53 MB and demo generation takes ~1.5× longer.
