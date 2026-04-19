# where it's pumping — design spec

Date: 2026-04-19
Status: Approved for planning
Target app: `surf_app_V3`

## Summary

A ranked "top 100 surf spots worldwide" feature for V3. Re-implements V1's top 100 (`surf_app_V1/public/js/top100.js`) using V3's local GFS/ECMWF grid data — eliminating the ~190 external API calls V1 required per scan. Adds a "peak in next N days" view that V1 didn't have.

Three ranking modes, driven by forecast data already loaded client-side:

1. **right now** — ranks every spot for the currently-selected timeline hour, re-ranks live on scrub
2. **score this week** — for each spot, finds peak overall score in days 0–7, ranks by that peak
3. **score next week** — same, for days 7–14 (requires GFS pipeline extension, GFS-only)

Spot universe = curated named spots (~500+) + auto-discovered coast points sampled every 10km globally and tagged with country + nearest town at build time. Total target: ~20k–25k spots.

## Goals

- Let the user see, at a glance, the best surf on the planet at any moment or over the next two weeks
- Include islands and remote coastlines, not just well-known spots
- Zero external API calls at runtime — all scoring from V3's local grid data
- Fast: ranking 20k+ points for the current hour should feel instant

## Non-goals

- Seasonal / monthly / year-ahead forecasts (no deterministic model supports this)
- User-submitted spots, auth, or persistence
- Tide, bathymetry, or local break-quality modeling

---

## Architecture

### New files

```
surf_app_V3/
├── data/
│   └── scripts/
│       └── build-coast-points.js         (new — offline build step)
├── public/
│   ├── data/
│   │   ├── coast-points.json             (new — ~500KB-1MB, gzipped)
│   │   └── named-spots.json              (new — expanded spot list)
│   └── js/
│       └── pumping.js                    (new — ranking logic + panel UI)
└── public/index.html                     (edit — add button + panel)
└── public/css/style.css                  (edit — panel styles)
```

### Data flow

```
build-time:
  coastline.geojson  +  ne_10m_admin_0_countries.geojson  +  cities1000.txt
         │
         ▼
  build-coast-points.js
         │
         ▼
  public/data/coast-points.json    (static asset)

runtime:
  app.js boots  →  loads named-spots.json + coast-points.json  →  caches in memory
  user clicks "where it's pumping"  →  pumping.js opens panel
  panel renders  →  iterates spot list  →  calls forecast.js interpolators  →  ratings.js scoring  →  sorted top 100
  timeline scrub (in "now" mode)  →  re-rank debounced ~150ms
```

---

## Component: `pumping.js`

Single module exposing:

```js
export function openPumpingPanel()      // toggle panel open/close
export function rankSpots(mode, hour)   // returns top 100 sorted array
export function invalidateCache()       // called on data reload
```

Internal responsibilities:
- Load `named-spots.json` + `coast-points.json` on first open (not at boot — lazy)
- For each spot, compute `overallScore` using existing `ratings.js` `oD()`
- "now" mode: single hour, 1 wind + 1 swell interpolation per spot
- "week"/"next week" modes: iterate each forecast hour in range, compute score, track max, return peak + peak-hour
- Memoize week/next-week results until forecast data changes; invalidate on model switch or run change

### Coast detection for ranking

Each spot needs a seaward/offshore direction for the wind rating (V1 used hardcoded regional fallbacks via `eS()` in `ratings.js`). For V3:

- **Named spots** in `named-spots.json`: ship with a precomputed `offshoreDeg` field, baked in by the build script by running `detectCoastFromGrid` at each spot against `swell_f000.bin` of the most recent GFS run at build time. Since coast orientation is geographic (doesn't change per forecast), this value is stable across runs.
- **Coast-discovered points**: also ship with `offshoreDeg`, computed by the same mechanism in the same build script.

This means all 20k+ points already know their shore angle — no per-click detection needed at ranking time.

---

## Component: `build-coast-points.js`

Node script, run manually or via npm script (not part of the per-run data pipeline):

1. Load a simplified world coastline GeoJSON. V3 does not yet ship one — bundle the Natural Earth `ne_10m_coastline.geojson` (~3MB raw, ~800KB simplified with topojson). Commit to `data/reference/coastline.geojson`.
2. For each coastline LineString: walk it in geodesic 10km steps (haversine + bearing interpolation between consecutive vertices). Emit a candidate point at each step.
3. For each candidate (lat, lon):
   - Point-in-polygon against `ne_10m_admin_0_countries.geojson` → `country`. If no match (open ocean islet not in admin boundaries), tag country as `"International waters"` and use latitude in the name.
   - Sample `data/gfs/<latest-run>/swell_f000.bin` at this point. If `height <= 0.05` and all 8 ring-neighbors are also land → drop (point is inland or in freshwater polygon).
   - Nearest-neighbor in GeoNames `cities1000.txt` (KD-tree) within 200km → `town` (or null if nothing within 200km).
   - Compute `offshoreDeg` by running the same ring-sample algorithm used in `forecast.js` → `detectCoastFromGrid`, against `swell_f000.bin`.
4. Build display name:
   - If town exists: `"near {town}, {country}"`
   - Else: `"coast {lat.toFixed(1)}°{N/S}, {country}"`
5. Write `public/data/coast-points.json` as an array of `{la, ln, name, country, offshoreDeg}`

### Dependencies (one-time)

- `ne_10m_admin_0_countries.geojson` — Natural Earth (public domain, ~1MB)
- `cities1000.txt` — GeoNames (CC-BY, ~10MB raw; only keep name/lat/lon/country → ~3MB)

Both committed to `data/reference/` (or fetched by the script on first run).

---

## Component: `named-spots.json`

Schema:

```json
[
  {"n": "Pipeline", "r": "Oahu, Hawaii", "la": 21.66, "ln": -158.05, "offshoreDeg": 160}
]
```

Start from V1's `G` array (~130 spots, already in `surf_app_V1/public/js/spots.js`), then expand by filling known gaps:

- Additional US (Washington, Oregon, Alaska, FL Panhandle)
- Nicaragua, Panama surf belt
- UK south coast, Wales, Channel Islands
- Iceland, Faroes
- West Africa (Liberia, Ghana, Angola)
- Mozambique, Madagascar, Seychelles
- Philippines outer islands, Taiwan, Korea
- Russia (Kamchatka), Alaska
- Samoa, Tonga, Vanuatu, New Caledonia, Cook Islands
- Uruguay, Ecuador
- More of Indonesia (Sumba, Flores, Timor)
- More of Maldives (named atolls), more of Mentawai

Target: **500+ named spots**. Quality > completeness — every entry should be a named break or known surf town.

`offshoreDeg` is baked in at build time. For named spots I'll precompute using the same ring-sampling algorithm against a representative swell grid.

---

## Component: GFS pipeline extension (for "score next week")

Existing download script fetches GFS f000–f168 (3-hourly, 7 days). Need to extend to f171–f336 (6-hourly, days 7–14).

**Changes:**
- Add a second loop in the GFS fetch step: `for fhr in range(171, 337, 6): download(fhr)`
- Processing + binary grid conversion uses existing code unchanged
- File naming continues: `wind_f171.bin, wind_f177.bin, ...wind_f336.bin`, and same for swell
- Estimated added download per run: ~28 extra files × 2 types = 56 files, ~100MB extra per run

**ECMWF caveat:** Per project memory, ECMWF wave files weren't available from the current source, only wind. "Score next week" therefore loads *only GFS* even if the user has ECMWF selected as active model. Small info note in the panel: *"Next-week forecast uses GFS only."*

---

## UI & interaction

### Entry point

Add to top-bar controls:

```html
<button class="ctrl-btn" id="pumping-btn">where it's pumping</button>
```

All-lowercase, no emoji, matches existing `.ctrl-btn` style.

### Panel

Slideout from right edge. Width ~380px on desktop, full-width on mobile. Overlays map with translucent backdrop, does not hide it.

Structure:

```
┌───────────────────────────────┐
│ where it's pumping         ×  │
│                               │
│ [right now] [this week] [next]│  ← segmented control
│                               │
│ list of 100 rows ────────────│
│   ...                         │
└───────────────────────────────┘
```

### Row layout

```
#1  ● Pipeline, Oahu            ↑ 8ft@14s   ← 4mph ENE   Sat 9am
#2  ● Teahupoo, Tahiti          ↑ 6ft@15s   ← 6mph E     Sun 6am
...
```

- Rank number — gold background for top 3
- Color dot — overall rating (gray/amber/gold/teal/blue/purple per project colorblind palette)
- Spot name + region/country
- Swell arrow (oriented) + height `@` period
- Wind arrow (oriented) + speed + direction label
- "When" badge (only in week/next-week modes)

### Interactions

| User action | Effect |
|---|---|
| Click top-bar button | Slide panel in, load data if not yet loaded, default to "right now" |
| Click segmented tab | Switch mode, recompute if needed (cached after first compute) |
| Scrub main timeline while "right now" active | Re-rank visible list, debounced 150ms |
| Click a row | Close panel, `map.flyTo(spot)`, open existing surf-rating panel, if peak-mode jump timeline to peak hour |
| Click × or backdrop | Close panel, preserve cached rankings |

---

## Performance

Rough budget assuming 25,000 spots (500 named + ~24,500 coast):

| Mode | Interpolations | Est. time on laptop |
|---|---|---|
| Right now | 25k × (2 wind + 3 swell) = 125k ops | <100ms |
| This week | 25k × 57 hours × 5 = 7.1M ops | ~1–2s on first compute, then cached |
| Next week | 25k × 28 hours × 5 = 3.5M ops | ~0.5–1s, cached |

Week/next-week modes show a progress indicator during first compute. Results cached in memory until model switch or data-run change.

If laptop-slow cases exceed 2s, fallback: compute in a Web Worker. Don't build the worker until measurement shows it's needed.

---

## Error handling

- If `named-spots.json` or `coast-points.json` fails to load: panel shows "Unable to load spot list. Retry." Retry button re-fetches.
- If a spot's grid interpolation returns null (e.g. point mid-ocean outside swell data): skip silently, that spot doesn't appear in results.
- If "next week" data files are missing (pipeline not yet extended): tab shows "Extended forecast not available for this run. Refreshed daily." Don't crash.

---

## Testing

- Unit-style: `rankSpots('now', 0)` returns 100 entries sorted descending by overall score. Verify top-3 make physical sense for a known run (pick a run with a known big swell and confirm expected spots are high).
- Visual check: open panel in each mode, scrub timeline, click through 5 rows, verify map flies + rating panel opens + timeline jumps correctly.
- Coast points sanity: after running build script, verify island coverage (Hawaii should have 20+ points, Maldives should have many, Iceland should have many).

---

## Open questions deferred to implementation

- Exact segmented-control styling (match existing `.btn-group` pattern in top bar)
- Whether to show "Loading peaks..." spinner during first compute or render "right now" results immediately while peaks compute in background
- Whether first-paint should show cached results from previous session (localStorage) while fresh computation runs

None of these block the plan; address during implementation.
