// surf-config.js — Data-source config loaded before app.js.
//
// Serving grids from Cloudflare R2 via the bucket's public r2.dev URL.
// Move to a custom domain (e.g. https://data.isitgood.surf) later by
// connecting the bucket to the zone in the Cloudflare R2 dashboard.
window.SURF_CONFIG = {
  DATA_BASE: "https://pub-97a48e761d40405a9d6d905bb62e3452.r2.dev",
  MANIFEST_URL: "https://pub-97a48e761d40405a9d6d905bb62e3452.r2.dev/manifest-gfs.json",
};
