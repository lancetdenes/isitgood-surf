// surf-config.js — Data-source config loaded before app.js.
//
// Defaults (Fly.io deployment): same-origin relative URLs.
//
// For Vercel + Cloudflare R2 deployment, override these values before
// deploying. Example:
//   DATA_BASE:    "https://data.isitgood.surf"
//   MANIFEST_URL: "https://data.isitgood.surf/manifest-gfs.json"
window.SURF_CONFIG = {
  DATA_BASE: "",
  MANIFEST_URL: "/api/latest/gfs",
};
