/**
 * verify/buoys-verify.mjs — end-to-end check of the buoy layer + panel.
 * Launches its own Chrome (isolated from any shared MCP browser), drives the
 * app on PORT (default 3004), and saves screenshots into verify/.
 *
 *   node verify/buoys-verify.mjs
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve playwright without a local install: PW_MODULE env var, project
// node_modules, or an npx cache. (`npx playwright` installs into the cache.)
async function loadPlaywright() {
  const { execSync } = await import('node:child_process');
  const candidates = [process.env.PW_MODULE].filter(Boolean);
  try {
    const { globSync } = await import('node:fs');
    for (const d of globSync(`${process.env.HOME}/.npm/_npx/*/node_modules/playwright/index.mjs`)) {
      candidates.push(d);
    }
  } catch { /* older node: fall through */ }
  try { candidates.push(execSync('npm root', { encoding: 'utf8' }).trim() + '/playwright/index.mjs'); } catch {}
  for (const c of candidates) {
    if (c && existsSync(c)) return import(pathToFileURL(c));
  }
  return import('playwright'); // last resort: normal resolution
}
const { chromium } = await loadPlaywright();

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = `http://localhost:${process.env.PORT || 3004}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

await page.goto(BASE);
await page.evaluate(() => localStorage.setItem('buoysEnabled', '0'));
await page.reload();

// Wait for map + demo data
await page.waitForFunction(() => window.__app?.map?.loaded() && window.__app.dataPath, null, { timeout: 30000 });
await page.waitForTimeout(1500);

// 1. No buoy fetches while the toggle is off
const early = await page.evaluate(() =>
  performance.getEntriesByType('resource').filter(e => e.name.includes('/api/buoys')).length);
if (early !== 0) fail(`expected no /api/buoys requests before toggle, got ${early}`);

// 2. Enable the layer, move over Monterey Bay
await page.click('#buoys-btn');
await page.waitForFunction(() => window.__app.map.getLayer('buoy-circles'), null, { timeout: 20000 });
await page.evaluate(() => window.__app.map.jumpTo({ center: [-122.8, 36.4], zoom: 6 }));
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(DIR, 'buoy-layer-west-coast.png') });
console.log('ok: buoy layer over west coast');

// 3. Click 46042 (Monterey) → panel + spectrum
const pt = await page.evaluate(() => {
  const map = window.__app.map;
  const f = map.querySourceFeatures('buoy-stations').find(x => x.properties.id === '46042');
  if (!f) return null;
  const p = map.project(f.geometry.coordinates);
  return { x: p.x, y: p.y };
});
if (!pt) { fail('46042 not in rendered source'); }
else {
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('#buoy-panel.open', { timeout: 10000 });
  await page.waitForFunction(() =>
    /NDBC 46042/.test(document.getElementById('buoy-panel').innerText) &&
    !document.querySelector('#buoy-panel .bp-loading'), null, { timeout: 15000 });
  const text = await page.$eval('#buoy-panel', el => el.innerText);
  for (const needle of ['WAVE HEIGHT', 'DOMINANT PERIOD', 'WIND', 'WATER', 'SWELL SPECTRUM']) {
    if (!text.toUpperCase().includes(needle)) fail(`panel missing "${needle}"`);
  }
  const hasSvg = await page.$('#buoy-panel svg.bp-spectrum');
  if (!hasSvg) fail('spectrum SVG missing');
  await page.screenshot({ path: path.join(DIR, 'buoy-panel-46042.png') });
  await page.locator('#buoy-panel').screenshot({ path: path.join(DIR, 'buoy-panel-46042-closeup.png') });
  console.log('ok: 46042 panel with spectrum');
}

// 4. Ocean click closes buoy panel, opens rating panel
await page.mouse.click(220, 420);
await page.waitForTimeout(2500);
const state = await page.evaluate(() => ({
  rating: document.getElementById('rating-panel').classList.contains('open'),
  buoy: document.getElementById('buoy-panel').classList.contains('open'),
}));
if (!state.rating || state.buoy) fail(`ocean click state wrong: ${JSON.stringify(state)}`);
else console.log('ok: ocean click opens rating panel, closes buoy panel');

await browser.close();
console.log(process.exitCode ? 'VERIFY FAILED' : 'VERIFY PASSED');
