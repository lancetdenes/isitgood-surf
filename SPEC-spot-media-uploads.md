# SPEC — Spot Media Uploads (v1)

*2026-07-07 · status: approved design, pre-implementation*

## Summary

Users upload photos and short video clips of surf spots, each stamped with **when** and **where** it was captured. Media appears in the spot's rating panel so anyone can see what the spot actually looked like at a given time. Sign-in is required to upload; viewing is public.

Phase 2 (explicitly out of scope here): geo-targeted outreach (Instagram ads / notifications) prompting people near firing spots to upload. The v1 schema must support its core query — "media near (lat,lng) captured within window T" — via indexed `captured_at` + geography columns, but no outreach code ships in v1.

## Constraints (from production architecture)

- Frontend is **static files on Vercel** (`isitgood-surf` project); there is no server in prod. All backend work lands as **Vercel functions** in an `api/` directory.
- Media storage reuses the **existing Cloudflare R2 bucket** (credentials already exist as GitHub/repo secrets) under a new `media/` prefix, served from the existing public r2.dev origin.
- Database: **Neon Postgres** (Vercel Marketplace, free tier).
- Email: **Resend** free tier for magic-link sign-in.
- Local dev keeps working via `node server.js` + `vercel dev` (or fetch-mocked API).

## Decisions

| Question | Decision |
|---|---|
| v1 scope | Uploads only; outreach is phase 2 |
| Media types | Photos + video clips ≤30s / ≤100MB, no transcoding (modern phone MP4/HEVC assumed web-playable) |
| Time/location stamp | EXIF prefill + user confirm; fallback to device geolocation + now; trust tier recorded |
| Identity | Light accounts (email magic link); uploads live immediately; report + admin removal |
| Backend | Vercel functions + presigned R2 uploads + Neon Postgres |

## User experience

**Viewing.** The spot rating panel gains a "Recent media" strip: newest-first thumbnails; tapping opens a lightbox with the media, capture-time badge ("Sat 7 AM · 3 days ago"), distance-to-spot, caption, uploader handle, trust tag, and a report button. Spots with media get a small camera glyph on their map marker.

**Uploading.**
1. Camera button in the spot panel (and a floating action button on mobile when a spot is selected) opens the upload sheet. Signed-out users are routed through magic-link sign-in first.
2. User picks a file. Client-side validation: type (`image/jpeg|png|heic`, `video/mp4|quicktime`), video ≤30s and ≤100MB.
3. The browser parses EXIF locally (photos): capture time and GPS prefill the form and pre-place a pin on a mini-map. The user confirms or adjusts pin/time, adds an optional ≤140-char caption.
4. No usable EXIF → prefill from device geolocation + current time, labeled "location set by uploader".
5. Photos are downscaled client-side to ≤1600px longest edge (canvas re-encode, JPEG q≈0.85) before upload; the original is not kept. Videos upload as-is.
6. Upload goes browser → R2 via presigned PUT; on completion the client calls `uploads/complete` and the media appears in the panel.

## Trust model

Each media row records `stamp_source`:

- `exif` — capture time/GPS came from the file and the server-side re-read agrees with the claim (≤25 km and ≤48 h delta). Displayed as "verified capture data".
- `device` — no EXIF; stamped from browser geolocation + server time at upload. Displayed as "user-reported".
- `manual` — user overrode the prefill, or server EXIF re-read disagreed with the claim beyond thresholds. Displayed as "user-reported".

The server independently re-parses EXIF from the stored object for photos in `uploads/complete` (never trusts the client's parse). v1 never hard-rejects on mismatch — it downgrades the tier.

## Architecture

```
Browser (static app on Vercel)
  ├─ GET  media lists ───────────► api/spots/media?lat&lng&limit  ─► Neon
  ├─ auth: POST api/auth/request-link ─► Resend email
  │        GET  api/auth/callback?token ─► sets signed session cookie
  ├─ POST api/uploads/presign ───► validates session+quota ─► presigned R2 PUT URL
  ├─ PUT  media bytes ───────────► R2 directly (media/<id>.<ext>)
  └─ POST api/uploads/complete ──► server EXIF re-read (photos), writes Neon row
Admin (allowlisted email): api/admin/list | delete | ban
Anyone: POST api/report
```

### API surface (Vercel functions, all JSON)

- `POST api/auth/request-link` `{email}` → 204. Creates one-time token (15 min TTL), emails link.
- `GET api/auth/callback?token` → sets `session` cookie (HTTP-only, signed JWT, 90 days), redirects to `/`.
- `POST api/auth/logout` → clears cookie.
- `GET api/me` → `{user}` or 401.
- `POST api/uploads/presign` `{contentType, bytes, kind}` → `{uploadUrl, mediaId}` or 401/429. Enforces type/size caps and quotas.
- `POST api/uploads/complete` `{mediaId, lat, lng, capturedAt, caption, claimedStampSource}` → media row (status `live`). Verifies object exists in R2, size within cap, EXIF re-check, reverse-geocodes a display name (existing coastline utilities).
- `GET api/spots/media?lat=&lng=&radiusKm=25&limit=30` → newest-first live media near a point.
- `POST api/report` `{mediaId, reason}` → 204 (no auth required; IP rate-limited).
- `GET api/admin/media?status=reported|live`, `DELETE api/admin/media/:id`, `POST api/admin/ban {userId}` — session email must be in `ADMIN_EMAILS` env.

### Data model (Neon)

```sql
users:   id uuid PK, email citext UNIQUE, handle text, banned bool DEFAULT false,
         created_at timestamptz
media:   id uuid PK, user_id FK, kind text CHECK (kind IN ('photo','video')),
         r2_key text, bytes int, content_type text,
         lat double precision, lng double precision,
         captured_at timestamptz, stamp_source text CHECK (stamp_source IN ('exif','device','manual')),
         spot_name text, caption text,
         status text CHECK (status IN ('live','removed')) DEFAULT 'live',
         report_count int DEFAULT 0, created_at timestamptz
         -- indexes: (status, created_at DESC), (lat, lng), (captured_at)
reports: id uuid PK, media_id FK, reason text, ip_hash text, created_at timestamptz
tokens:  token_hash text PK, email citext, expires_at timestamptz
```

Nearby queries use a simple bounding-box on `(lat,lng)` + haversine filter in SQL — no PostGIS needed at v1 scale.

### Abuse limits

- 10 uploads/day/user; 3 magic-link requests/hour/email; 3 new accounts/day/IP-hash; 20 reports/day/IP-hash.
- 3 distinct-IP reports on one media item flag it `reported` in the admin list (stays live until removed).
- Presigned URLs: 10 min TTL, content-length-range enforced by R2 presign conditions.

## Error handling

- Upload failures (presign expiry, R2 error) surface a retry affordance in the sheet; `uploads/complete` is idempotent per `mediaId`.
- Orphaned R2 objects (presigned but never completed): daily-batch cleanup can wait; v1 records presign timestamps so a later sweep is possible. Documented as accepted debt.
- All functions return typed JSON errors `{error, code}`; the client maps codes to friendly copy.

## Non-goals (v1)

Outreach/ads (phase 2) · video transcoding/thumbnails (poster frame is captured client-side at upload) · comments, likes, follows, feeds · native app / push notifications · EXIF-based automatic spot matching to the named-spots list (media is keyed by lat/lng, not spot IDs).

## Testing

- **Unit (node --test):** EXIF parse + trust-tier downgrade logic; quota/rate-limit logic; presign request validation.
- **Integration:** functions run under `vercel dev` against a Neon branch DB; script exercises auth → presign → (mock PUT) → complete → list → report → admin delete.
- **Playwright smoke (system Chrome):** sign-in with intercepted magic link, upload a fixture photo with EXIF, assert it renders in the spot panel with "verified" tag; assert quota error on the 11th upload.

## Rollout

1. Ship functions + schema behind the existing site (no flag needed — UI entry points appear only when `api/me` responds).
2. Seed with your own uploads; watch admin list.
3. Phase 2 (outreach) gets its own spec once v1 has real uploads.
