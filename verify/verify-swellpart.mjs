/**
 * verify-swellpart.mjs — visual verification for the partitioned-swell fork.
 *
 * Drives the demo app on :3003 through the new swell sub-layers and the spot
 * panel's swell-trains section, saving screenshots into verify/.
 *
 * Run: node verify/verify-swellpart.mjs
 * (requires the demo server: PORT=3003 node server.js after npm run demo data gen)
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const shot = (name) => path.join(DIR, name);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.message));

await page.goto('http://localhost:3003');
await page.waitForFunction(() => window.__app && window.__app.swellGrid, null, { timeout: 30000 });

// Frame the demo's NE-Pacific groundswell (storm near 42N 185E) plus the
// California "coast" of the demo land mask at lon >= -125.
await page.evaluate(() => window.__app.map.jumpTo({ center: [-148, 34], zoom: 3.4 }));
await page.waitForTimeout(1200);

// 1. Combined swell layer
await page.click('[data-layer="swell"]');
await page.waitForTimeout(2500);
await page.screenshot({ path: shot('01-swell-combined.png') });
const toggleVisible = await page.isVisible('#swell-mode-selector');
console.log('sub-toggle visible after selecting swell layer:', toggleVisible);

// 2. Groundswell
await page.click('[data-swellmode="ground"]');
await page.waitForFunction(() => window.__app.swellPartGrid, null, { timeout: 15000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: shot('02-swell-groundswell.png') });

// 3. Windsea
await page.click('[data-swellmode="windsea"]');
await page.waitForTimeout(2500);
await page.screenshot({ path: shot('03-swell-windsea.png') });

// 4. Spot panel with swell-trains section — click just off the demo
// land-mask's west coast (land starts at lon 235 = -125).
await page.click('[data-swellmode="combined"]');
await page.waitForTimeout(800);
const pt = await page.evaluate(() => {
  const p = window.__app.map.project([-126.5, 35]);
  return { x: p.x, y: p.y };
});
await page.mouse.click(pt.x, pt.y);
await page.waitForSelector('#rp-trains-slot .rp-train', { timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: shot('04-panel-swell-trains.png') });
const trains = await page.$$eval('#rp-trains-slot .rp-train', els =>
  els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
console.log('panel trains:', trains);
const lp = await page.$eval('.rp-lp-slot', e => e.innerText).catch(() => '');
console.log('LP chip:', JSON.stringify(lp));

// Zoomed crop of the trains section
const panel = await page.$('#rating-panel');
await panel.screenshot({ path: shot('05-panel-closeup.png') });

// 6. Fallback check: block swellpart fetches and confirm degrade to combined
await page.evaluate(() => window.__app._gridCache.clear());
await page.route('**/swellpart_*.bin', r => r.fulfill({ status: 404, body: 'nope' }));
await page.evaluate(() => { window.__app.partAvailable = null; });
await page.click('[data-swellmode="ground"]');
await page.waitForTimeout(2500);
const state = await page.evaluate(() => ({
  mode: window.__app.swellMode,
  partAvailable: window.__app.partAvailable,
  toggleShown: document.getElementById('swell-mode-selector').style.display !== 'none',
}));
console.log('after 404s:', state);
await page.screenshot({ path: shot('06-fallback-combined.png') });

await browser.close();
console.log('done');
