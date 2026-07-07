# surf_app V3

## Data sources

- **Coastline (high-res)**: GSHHG 2.3.7 (Wessel & Smith, 1996; continuously maintained) — distributed under LGPL v3. Source: https://www.soest.hawaii.edu/pwessel/gshhg/
- **Coastline (fallback)**: Natural Earth 10m physical coastline — public domain.
- **Weather data**: NOAA GFS / NCEP (public domain).

## Spot media uploads (v1)

Users can upload photos and ≤30s clips of spots, stamped with capture time +
location (EXIF-verified where possible). Design: `SPEC-spot-media-uploads.md`;
implementation plan: `PLAN-spot-media-uploads.md`.

- **Backend**: Vercel functions under `api/` (magic-link auth, presigned R2
  uploads, nearby-media list, reports, admin moderation). Metadata in Neon
  Postgres, media files in the existing R2 bucket under `media/`.
- **Setup**: copy `.env.example` → `.env`, fill values (Neon `DATABASE_URL`,
  Resend key, R2 credentials, `SESSION_SECRET` via `openssl rand -hex 32`,
  `ADMIN_EMAILS`), add the same vars to the Vercel project, allow `PUT` from
  the app origin in the R2 bucket's CORS settings, then run `npm run migrate`.
- **Feature gating**: the UI probes `/api/me` and hides all media features
  until the API responds, so the static site works unchanged before the
  backend is provisioned.
- **Quotas**: 10 uploads/day/user, 3 magic links/hour/email, 3 signups/day/IP,
  20 reports/day/IP; 3 distinct-IP reports flag media for review.
- **Admin**: `/admin.html` (requires a session whose email is in `ADMIN_EMAILS`).
- **Tests**: `npm run test:api` (27 unit tests, no external services needed).
