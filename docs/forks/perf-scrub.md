# Fork report — `fork/perf-scrub`

Goal: make the app feel like windy.com — near-instant initial usable paint and
instant, jank-free timeline scrubbing. All behavior/visuals preserved (same
palettes, same particle tuning, same rating logic, vanilla ESM, no build step).

## What changed (per commit)

| Commit | Change |
|---|---|
| `fa257ec` | **dev:** `DEMO_RES=hi` flag for `generate-demo.js` — 0.25° (1440×721) demo grids matching real GFS size, so perf numbers reflect production grid sizes. Default 1° output unchanged. |
| `b955464` | **dev:** Playwright measurement harness (`verify/measure.js`, system Chrome via `playwright-core`) + tiny in-app hooks (`window.__perfLog`, `window.__app`, `__coastHiresReady`). Baseline recorded. |
| `a49bf67` | **panel:** hour changes patch the panel DOM in place instead of rebuilding `.rating-body` innerHTML. The mini-map MapLibre instance now survives scrubbing (was: a brand-new `maplibregl.Map` — new WebGL context + style.json fetch — created **every scrub tick**). Panel sync moved off the scrub critical path (120 ms trailing debounce, no-op when selection unchanged); click handling is one delegated listener. |
| `42cc23d` | **heatmap:** MapLibre `canvas` source replaces ImageSource + `canvas.toBlob(PNG)` + objectURL + async image fetch. After each draw, `play()`/`pause()` uploads the canvas straight to the GPU texture. Per-pixel bilinear indices/weights precomputed per viewport (hour-independent); a scrub tick runs only a tight typed-array loop with a packed-Uint32 palette LUT. Palettes and land/ocean rules unchanged. |
| `d5d92b6` | **data:** new `GridStore` + module worker. Fetch + int16→Float32 decode in a Web Worker (transferable buffers, zero-copy). Two LRU tiers with byte caps: decoded Float32 (300 MB, follows the cursor) + raw int16 bytes (700 MB — a whole real run is ~590 MB, so the full timeline stays local). Priority-queue fetch pool (concurrency 5) radiating out from the current hour, re-prioritized every scrub tick; urgent requests overflow the pool. Negative cache for missing files (404 permanent, transient 15 s). Scrubbing never waits on the network: cached frames apply synchronously; otherwise the nearest cached frame renders immediately and the exact frame swaps in (latest-wins). |
| `d2bf378` | **initial load:** self-hosted `maplibre-gl` 4.7.1 (was blocking unpkg.com script/CSS); hires coastline (14.5 MB) deferred until after first grids render (idle callback; a click still triggers the same shared fetch on demand); Natural Earth `coastline.geojson` (5.4 MB) now strictly a fallback fetched only if the hires load fails; `exifr` dynamically imported only when a photo is picked. |
| `ebd1e9c` | **particles:** per-frame calibrated Mercator projector for the wind/swell advection loops (12 k particles × project+unproject per frame) — allocation-free arithmetic instead of matrix math + Point/LngLat allocations. Exact (0 px error) vs `map.project`; falls back to the real transform when rotated/pitched. |
| `822f1c6` | **heatmap:** grid swaps render synchronously (1–3 ms) instead of next-animation-frame, so a scrub tick's visual update lands in the same frame as the input. |
| `be23561` | **dev:** post-optimization measurements recorded. |

## Baseline vs after

Primary numbers on **0.25° demo grids (1440×721 — real GFS size)**, local
server, system Chrome, 1400×900. `verify/baseline.json` → `verify/after.json`.

| Metric | Baseline | After |
|---|---|---|
| Time to first heatmap paint (nav → texture) | 1112 ms | 834 ms (739 ms in a second run) |
| Requests before first paint | 52 | 57 (prefetch pool starts earlier; nothing blocks paint) |
| Scrub, cold cache — per step mean / median / p90 | 78.7 / 73.0 / 146.4 ms | 49.5 / **25.4** / 159.6 ms (max is one step racing the prefetcher) |
| Scrub, warm cache — per step mean / median / p90 | 64.4 / 69.0 / 71.7 ms | **21.5 / 20.8 / 42.8 ms** |
| Scrub with rating panel open — mean / p90 | 81.2 / 92.9 ms | **21.5 / 37.5 ms** |
| `maplibregl.Map` instances created during 10 panel-open scrub ticks | **10** | **0** |
| Heatmap CPU per refresh — mean / p90 | 5.2 / 7.5 ms | **1.6 / 1.8 ms** |
| Long tasks (>50 ms) during warm scrub | 0 | 0 |
| Decoded-grid memory for a full run | unbounded (~1.2 GB decoded) | capped: ≤300 MB decoded + ≤700 MB raw int16 |

1° demo grids for reference (`baseline-1deg.json` → `after-1deg.json`): warm
scrub 67.5 → 18.4 ms mean; panel-open scrub 77.5 → 14.3 ms mean; first heatmap
2485 → 517 ms (baseline run included first-launch noise; treat load numbers as
indicative, scrub numbers as robust).

The remaining ~20 ms per scrub step is dominated by the slider-input rAF
coalescing in `ui.js` (intentional, one frame max) plus the harness's
frame-boundary accounting — the map texture updates in the same frame the
hour is applied.

Screenshots (in `verify/`): `baseline-initial.png` / `after-initial.png`,
`baseline-panel.png` / `after-panel.png`, `*-panel-after-scrub.png`.

## Reproducing the measurements

```bash
# terminal 1 — demo server with production-size grids
DEMO_RES=hi node data/scripts/generate-demo.js
PORT=3001 node server.js

# terminal 2 — harness (system Chrome; no browser download)
node verify/measure.js --label after --out verify/after.json
```

The harness measures: time-to-first-grids/heatmap, network before first paint,
20-step cold scrub, 20-step warm scrub (after the full 114-file prefetch),
10-step scrub with the rating panel open (worst path), long tasks per phase
(PerformanceObserver), heatmap CPU per refresh, and mini-map construction
churn. Per-step latency = slider `input` event → heatmap texture updated with
that hour's data (page-side timestamps).

## Known risks / limitations

- **Raw-tier sync decode:** peeking an hour whose decoded Float32 was LRU-evicted
  decodes from raw int16 on the main thread (~10–40 ms for a real swell grid,
  observed once as a 59 ms long task before the sync-render commit). Background
  worker re-decode follows the cursor so this is rare; it only replaces what
  would previously have been a network re-fetch.
- **Memory:** steady state for a fully prefetched real run is ~300 MB decoded +
  ~590 MB raw (~0.9 GB, vs ~1.2 GB unbounded before). Both caps are
  constructor options on `GridStore` if mobile needs tighter budgets.
- **Canvas source internals:** the `play()`/`pause()` one-shot upload pattern
  relies on documented MapLibre `CanvasSource` behavior (verified against the
  vendored 4.7.1 source). Pin maplibre upgrades through a quick scrub test.
- **Vendored maplibre:** `public/vendor/maplibre-gl/` is a pinned copy of the
  4.7.1 dist files (no sourcemap); upgrades must re-copy.
- **Panel updates are debounced:** the rating panel now reflects the slider
  ~120 ms after it settles (map layers still update every tick). Screenshots
  taken instantly after a scrub can show the pre-scrub panel selection.
- **Measurement bytes metric** undercounts (gzip/chunked responses lack
  `content-length`); request counts are reliable.
- Demo data land masks are rectangular boxes; hard heatmap edges along
  lon/lat lines in screenshots are the demo data, not rendering bugs.

## Deliberately not done

- **Temporal interpolation between frames** during scrub/play (Windy's blend):
  the plumbing now supports it (all frames decoded + cached), but it changes
  visual output, so it was left out of a perf-only fork.
- **Heatmap in a Web Worker / OffscreenCanvas:** unnecessary — the main-thread
  refresh is ~1.6 ms against an 8 ms budget.
- **Reducing slider rAF coalescing:** kept as-is; it bounds input-flood work
  to one update per frame and costs at most one frame of latency.
- **Server-side changes** (HTTP/2, cache headers, brotli) and **service-worker
  caching** across sessions — out of scope for the frontend scrub path.

## Tests

`npm run test:api` (9 pass), `npm run test:hires` (pass), `npm run test:build`
(pass, 2 skipped) — all green after the changes.
