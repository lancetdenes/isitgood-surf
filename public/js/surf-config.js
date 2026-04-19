// surf-config.js — Data-source config loaded before app.js.
//
// Local dev (localhost / 127.0.0.1) reads grids from the Express server's
// own /data/ mount. Any other host reads from Cloudflare R2 (production).
const _isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname);
window.SURF_CONFIG = _isLocal ? {
  DATA_BASE: "",
  MANIFEST_URL: "/api/latest/gfs",
} : {
  DATA_BASE: "https://pub-97a48e761d40405a9d6d905bb62e3452.r2.dev",
  MANIFEST_URL: "https://pub-97a48e761d40405a9d6d905bb62e3452.r2.dev/manifest-gfs.json",
};
