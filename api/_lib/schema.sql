CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  handle text NOT NULL,
  banned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('photo','video')),
  r2_key text NOT NULL,
  bytes integer,
  content_type text NOT NULL,
  lat double precision,
  lng double precision,
  captured_at timestamptz,
  stamp_source text CHECK (stamp_source IN ('exif','device','manual')),
  spot_name text,
  caption text,
  status text NOT NULL CHECK (status IN ('pending','live','removed')) DEFAULT 'pending',
  report_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_live_recent ON media (status, created_at DESC);
CREATE INDEX IF NOT EXISTS media_geo ON media (lat, lng);
CREATE INDEX IF NOT EXISTS media_captured ON media (captured_at);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  reason text,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_dedupe ON reports (media_id, ip_hash);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash text PRIMARY KEY,
  email citext NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
