// surf-config.js — Data-source config loaded before app.js.
//
// TRANSITIONAL: frontend is on Vercel, data still served from Fly until R2
// is set up. Once R2 is live, swap both values to the R2 custom domain:
//   DATA_BASE:    "https://data.isitgood.surf"
//   MANIFEST_URL: "https://data.isitgood.surf/manifest-gfs.json"
// and then `fly scale count 0 -a isitgood-surf` to shut Fly off.
window.SURF_CONFIG = {
  DATA_BASE: "https://isitgood-surf.fly.dev",
  MANIFEST_URL: "https://isitgood-surf.fly.dev/api/latest/gfs",
};
