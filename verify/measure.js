#!/usr/bin/env node
/**
 * verify/measure.js — Playwright perf harness for load + timeline-scrub.
 *
 * Prereq: demo server running, e.g.
 *   node data/scripts/generate-demo.js            # or DEMO_RES=hi node ...
 *   PORT=3001 node server.js
 *
 * Run:
 *   node verify/measure.js --label baseline --out verify/baseline.json
 *
 * Uses system Chrome (channel: 'chrome') via playwright-core — no browser
 * download needed. Relies on the in-app dev hooks: window.__app and
 * window.__perfLog entries {t, type: 'hour-applied'|'heatmap-frame'|'heatmap-render'}.
 *
 * Measures:
 *   - time-to-first-grids / first-heatmap after navigation
 *   - network requests+bytes before first heatmap paint
 *   - cold scrub: 20 slider steps immediately after load
 *   - warm scrub: 20 steps after full preload (the Windy steady state)
 *   - panel scrub: 10 steps with the rating panel open (worst path)
 *   - per-step latency (input event -> heatmap texture updated for that hour)
 *   - long tasks (>50ms main-thread blocks) per phase
 *   - heatmap CPU render duration stats
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const args = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
}
const LABEL = argOf('--label', 'run');
const OUT = argOf('--out', `verify/${LABEL}.json`);
const URL = argOf('--url', 'http://localhost:3001');
const SHOT_DIR = path.dirname(OUT);

const CLICK_POINT = { lng: -10.2, lat: 39.0 }; // just off the Portugal coast: demo-ocean + real coastline

function stats(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    mean: +(sum / s.length).toFixed(1),
    median: +pick(0.5).toFixed(1),
    p90: +pick(0.9).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
  };
}

async function longTaskWindow(page, fromT) {
  return page.evaluate((fromT) => {
    const lt = (window.__longTasks || []).filter(e => e.start >= fromT);
    return {
      count: lt.length,
      totalMs: +lt.reduce((a, e) => a + e.dur, 0).toFixed(0),
      maxMs: +lt.reduce((a, e) => Math.max(a, e.dur), 0).toFixed(0),
    };
  }, fromT);
}

async function nowInPage(page) {
  return page.evaluate(() => performance.now());
}

/** Dispatch a slider input for hour h; resolve when the heatmap texture has
 *  been updated with that hour's data. Returns latency ms. */
async function scrubStep(page, h, timeout = 30000) {
  const t0 = await page.evaluate((h) => {
    const t = performance.now();
    const s = document.getElementById('hour-slider');
    s.value = String(h);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return t;
  }, h);
  await page.waitForFunction(
    ([h, t0]) => (window.__perfLog || []).some(e => e.type === 'hour-applied' && e.hour === h && e.t >= t0),
    [h, t0], { timeout, polling: 16 }
  );
  const appliedT = await page.evaluate(
    ([h, t0]) => window.__perfLog.find(e => e.type === 'hour-applied' && e.hour === h && e.t >= t0).t,
    [h, t0]
  );
  await page.waitForFunction(
    (appliedT) => (window.__perfLog || []).some(e => e.type === 'heatmap-frame' && e.t >= appliedT),
    appliedT, { timeout, polling: 16 }
  );
  const frameT = await page.evaluate(
    (appliedT) => window.__perfLog.find(e => e.type === 'heatmap-frame' && e.t >= appliedT).t,
    appliedT
  );
  return frameT - t0;
}

async function scrubPhase(page, hours) {
  const from = await nowInPage(page);
  const latencies = [];
  for (const h of hours) {
    latencies.push(await scrubStep(page, h));
  }
  const longTasks = await longTaskWindow(page, from);
  return { perStepMs: stats(latencies), longTasks, steps: hours.length };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    } catch {}
    // Count maplibregl.Map constructions (mini-map churn detector).
    window.__mapCtorCount = 0;
    let _ml;
    Object.defineProperty(window, 'maplibregl', {
      configurable: true,
      get() { return _ml; },
      set(v) {
        if (v && v.Map && !v.__wrapped) {
          const Orig = v.Map;
          const Counted = class extends Orig {
            constructor(...a) { window.__mapCtorCount++; super(...a); }
          };
          v.Map = Counted;
          v.__wrapped = true;
        }
        _ml = v;
      },
    });
  });

  // Network accounting
  let reqCount = 0, respBytes = 0;
  let firstHeatmapWallTime = null;
  page.on('request', () => { reqCount++; });
  page.on('response', async (resp) => {
    try {
      const len = +(resp.headers()['content-length'] || 0);
      if (firstHeatmapWallTime === null) respBytes += len;
    } catch {}
  });

  // ── Phase 1: initial load ──
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__perfLog || []).some(e => e.type === 'heatmap-frame'), null, { timeout: 90000 });
  firstHeatmapWallTime = Date.now();
  const load = await page.evaluate(() => {
    const log = window.__perfLog || [];
    const firstGrids = log.find(e => e.type === 'hour-applied');
    const firstFrame = log.find(e => e.type === 'heatmap-frame');
    return {
      firstGridsMs: firstGrids ? +firstGrids.t.toFixed(0) : null,
      firstHeatmapMs: firstFrame ? +firstFrame.t.toFixed(0) : null,
    };
  });
  const loadLongTasks = await longTaskWindow(page, 0);
  const netBeforeFirstPaint = { requests: reqCount, bytes: respBytes };
  await page.screenshot({ path: path.join(SHOT_DIR, `${LABEL}-initial.png`) });

  const gridInfo = await page.evaluate(() => {
    const g = window.__app?.windGrid;
    return g ? { nx: g.nx, ny: g.ny, dx: g.dx } : null;
  });

  // ── Phase 2: cold scrub (right after load; cache mostly empty) ──
  const coldHours = [];
  for (let h = 3; h <= 60; h += 3) coldHours.push(h);
  const scrubCold = await scrubPhase(page, coldHours);

  // ── Phase 3: warm scrub (after full preload — the Windy steady state) ──
  await page.waitForFunction(
    () => (window.__app?._gridCache?.size ?? 0) >= 114,
    null, { timeout: 180000, polling: 200 }
  ).catch(() => { console.warn('preload never hit 114 entries; continuing'); });
  const warmHours = [];
  for (let h = 60; h >= 3; h -= 3) warmHours.push(h);
  const scrubWarm = await scrubPhase(page, warmHours);

  // ── Phase 4: rating panel open (worst path) ──
  await page.waitForFunction(() => !!window.__coastHiresReady, null, { timeout: 60000 })
    .catch(() => { console.warn('hires coastline never became ready'); });
  await page.evaluate(({ lng, lat }) => {
    window.__app.map.jumpTo({ center: [lng, lat], zoom: 6 });
    return window.__app._onMapClick({ lngLat: { lng, lat } });
  }, CLICK_POINT);
  await page.waitForSelector('.rating-panel.open .rp-detail', { timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT_DIR, `${LABEL}-panel.png`) });

  const panelHours = [];
  for (let h = 3; h <= 30; h += 3) panelHours.push(h);
  const ctorBefore = await page.evaluate(() => window.__mapCtorCount);
  const scrubPanel = await scrubPhase(page, panelHours);
  scrubPanel.miniMapsCreatedDuringScrub =
    (await page.evaluate(() => window.__mapCtorCount)) - ctorBefore;
  await page.screenshot({ path: path.join(SHOT_DIR, `${LABEL}-panel-after-scrub.png`) });

  // Heatmap CPU render duration over the whole session
  const heatmapRender = await page.evaluate(() => {
    return (window.__perfLog || []).filter(e => e.type === 'heatmap-render').map(e => e.dur);
  });

  const result = {
    label: LABEL,
    url: URL,
    when: new Date().toISOString(),
    grid: gridInfo,
    initialLoad: {
      ...load,
      longTasks: loadLongTasks,
      networkBeforeFirstHeatmap: netBeforeFirstPaint,
    },
    scrubCold,
    scrubWarm,
    scrubPanelOpen: scrubPanel,
    heatmapRenderMs: stats(heatmapRender),
  };

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
