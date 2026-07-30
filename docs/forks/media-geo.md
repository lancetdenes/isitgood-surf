# Fork report — photo geolocation & timeline surfacing (`fork/media-geo`)

*2026-07-29 · builds on the dormant spot-media-uploads v1 backend*

Goal (owner's words): photos should "time and date and location stamp to the
forecast from that time" — (A) auto-assign geotagged photos to their spot,
(B) manual picker when there's no geotag, (C) photos surface on the map and
on the forecast timeline as ground truth pinned to `(lat, lng, captured_at)`.

## What changed (commit by commit)

1. **`feat(geo)` spot-snapping module + server-side spot_name** —
   `public/js/spot-snap.js` (pure, shared browser/server): ≤2 km → spot name,
   2–10 km → "near <spot>", >10 km → coords only. `api/_lib/spots.mjs` loads
   the shipped 523-spot `named-spots.json` and fills the previously-stubbed
   `spot_name` in `api/uploads/complete.mjs`. No external geocoding API.
2. **`feat(api)` bbox mode on `GET /api/spots/media`** —
   `?bbox=w,s,e,n&sinceHours=168&limit=200` (map-viewport query, newest-
   captured first, same `(lat,lng)` + `(captured_at)` indexes). Additive;
   point+radius mode untouched; both modes now return `spotName`.
3. **`feat(dev)` local mock media backend** — `server-media-mock.js`, mounted
   by `server.js` only when `DATABASE_URL` is absent (or `MEDIA_MOCK=1`).
   In-memory `/api/me` (dev@local), 15 seeded photos near real NE-US spots
   over the past 48 h, presign → PUT → complete storing bytes in a tmp dir.
   Reuses the real `uploadrules`/`stamp`/`spot-snap` modules so it can't
   drift from prod. Fixtures under `test/fixtures/media/` (regenerable via
   `generate-fixtures.mjs`), including `gps-higgins.jpg` — a hand-built
   minimal JPEG with genuine GPS EXIF + DateTimeOriginal (no exiftool
   needed).
4. **`feat(ui)` auto-assign + full-screen picker** — upload sheet shows
   "📍 Higgins Beach — from your photo" for geotagged photos; non-geotagged
   media cannot upload until located via `geo-picker.js` (crosshair map,
   live nearest-spot label, "use my location", spot search). Lightbox gains
   spot name, stamp badge, frame-relative timestamp, jump button.
5. **`feat(ui)` photos map layer + time coupling** — `media-map.js`:
   thumbnail-circle markers with glow; ±6 h window (`TIME_WINDOW_HOURS`)
   around `runTime + hour` brightens matching photos, dims the rest to 30%
   (one class toggle per marker per scrub; Date parsed once per photo).
   "Photos" toggle (default ON when photos are in view) + floating 📷 FAB.
6. **`docs(spec)` addendum + `verify/` screenshots.**

**Bug found & fixed (pre-existing v1):** `exifr.parse(file, { gps: true,
pick: ['DateTimeOriginal','latitude','longitude'] })` never returns GPS —
the global `pick` filters the raw GPS tags away before exifr converts them
to `latitude`/`longitude`. Both the client prefill and the server re-verify
had this, meaning "verified" EXIF could never have worked in prod. Fixed
with per-segment options `{ exif: ['DateTimeOriginal'], gps: true }`.
Related fix: images already ≤1600 px now upload without canvas re-encode so
EXIF survives the server-side re-check.

## UX decisions & alternatives considered

**(A) auto-assign.** Chose client-side snapping against the shipped
named-spots list with three tiers (at / near / far) mirrored server-side into
`spot_name`. Alternatives: external reverse-geocoding API (rejected: network
dependency, cost, and beach-level names are worse than the curated surf-spot
list); snapping media rows to spot IDs (rejected: v1 schema keys media by
lat/lng, and "near"-tier photos must keep exact coords).

**(B) manual picker.** Replaced the inline mini-map (blank background, easy
to ignore) with a full-screen picker with a fixed crosshair — pan-under-
crosshair is more precise on mobile than dragging a pin, and the live
nearest-spot label gives instant feedback. Upload is *blocked* until a
location is set for non-geotagged media (previously it silently used the
panel location, which fabricated data). Alternatives: keep draggable pin
(rejected: fiddly on phones); require choosing from a spot list only
(rejected: mysto spots deserve exact pins).

**(C) map + timeline.** DOM markers (`maplibregl.Marker`) with CSS-class
state rather than a GeoJSON symbol/circle layer — photo counts are tiny for
now, thumbnails-in-circles need DOM anyway, and class toggling makes the
scrub path trivially cheap. Feature-state on a symbol layer is the upgrade
path if counts grow. Dim-don't-hide (30%) keeps evidence discoverable while
scrubbing; ±6 h matches the 3 h forecast step and typical session length.
Time mapping is absolute (`runTime + hour` vs `captured_at`), so recent
photos naturally light up the early timeline (h=0 is runTime, which is up to
~6 h in the past) and old photos degrade to always-dim. One MapLibre gotcha:
the marker root's inline `transform`/`opacity` belongs to MapLibre, so all
visual state lives on an inner element.

## Verification (all on PORT=3005, mock mode, Chrome)

- `npm run test:api` — 38 tests pass (new: spot-snap tiers incl. real data
  file, bbox parse/clamp).
- `verify/photos-map-h0.png` — markers on the map at "Now": recent photos
  bright/glowing, older ones dimmed dots. FAB + Photos toggle visible.
- `verify/photos-map-h48-dimmed.png` — same viewport at +48 h: every photo
  dimmed (time coupling proven visually).
- `verify/upload-autoassign.png` — GPS fixture upload: "📍 Higgins Beach —
  from your photo", EXIF time prefilled, "verified from photo". Completing
  it stored `spot_name="Higgins Beach"`, `stamp_source="exif"` (server
  re-verified the EXIF from the uploaded bytes).
- `verify/manual-picker.png` — full-screen picker after searching
  "narraga": crosshair on Narragansett, live label, use-my-location +
  confirm buttons. Confirming stored `stamp_source="manual"`,
  `spot_name="Narragansett"`.
- `verify/lightbox-timestamp.png` — lightbox: "📍 Montauk · Wed 8:49 PM, 2h
  before this frame · ✓ verified capture · jump timeline to this photo".
  Jump button verified to move the slider.
- Dormant gating re-verified: with `MEDIA_MOCK=0` and no `DATABASE_URL`,
  `/api/me` 404s and the toggle, FAB, and markers all stay hidden.

## Still blocked on provisioning (before prod works)

Unchanged from v1 (`PLAN-spot-media-uploads.md` Task 0): Neon `DATABASE_URL`
(+ `npm run migrate`), Resend key + sender, R2 CORS PUT rule + credentials,
`SESSION_SECRET`/`ADMIN_EMAILS`/`APP_ORIGIN` in Vercel env. Nothing in this
fork adds new infra requirements — the bbox mode is the same table/indexes,
and spot naming is a bundled JSON file.

## Risks / notes

- **EXIF stripping on large photos**: >1600 px photos are still canvas
  re-encoded, losing EXIF → server downgrades to `manual` even for genuine
  captures. Fix candidates: EXIF segment transplant into the re-encoded JPEG,
  or uploading originals under a size cap. Flagged in the spec addendum.
- Vercel must trace `public/data/named-spots.json` + `public/js/spot-snap.js`
  into the `api/uploads/complete` bundle (loaded via `createRequire`/ESM
  import, which nft handles); worth confirming on first preview deploy.
- The mock's seeds regenerate per server boot (captured_at relative to boot),
  so local demos always have fresh-looking photos; uploads to the mock are
  lost on restart by design.
- `named-spots.json` is fetched once per session client-side (~40 KB); fine,
  but could be lazy-loaded only when the media feature is active.
- Marker approach is O(photos-in-view) DOM nodes; revisit as a symbol layer
  with feature-state past a few hundred photos in view.
