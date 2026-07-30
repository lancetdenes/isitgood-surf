/** named-spots.js — cached client-side loader for the named-spots list. */
let _p = null;
export function loadNamedSpots() {
  if (!_p) {
    _p = fetch('/data/named-spots.json')
      .then(r => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return _p;
}
