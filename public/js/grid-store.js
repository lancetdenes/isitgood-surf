/**
 * grid-store.js — decoded-grid cache + prioritized fetch/decode pipeline.
 *
 * This is the data layer behind Windy-feel scrubbing:
 *
 *   - Two cache tiers, both LRU with byte caps:
 *       decoded  Float32 Grids ready to render (default 300 MB — holds a
 *                wide window of hours around the scrub cursor at real
 *                0.25° grid sizes, or several full runs of demo data)
 *       raw      original int16 file bytes (default 1000 MB — holds an
 *                entire real 14-day run: 85 wind + 85 swell steps of the
 *                shared FORECAST_HOURS timeline is ~880 MB), so the whole
 *                timeline stays local even when the decoded tier evicts
 *     A decoded-tier miss that hits the raw tier never touches the network:
 *     urgent requests decode synchronously (~a few ms), background requests
 *     re-decode in the worker.
 *
 *   - Fetch + int16→Float32 decode happen in a Web Worker; buffers transfer
 *     back zero-copy. Falls back to main-thread decode if workers are
 *     unavailable.
 *
 *   - A small concurrency pool with a priority queue: the prefetcher loads
 *     hours nearest the scrubber first, and urgent (negative-priority)
 *     requests may overflow the pool so a scrub tick never queues behind
 *     background prefetches.
 *
 *   - Failures are memoized ("negative cache"): 404/403/410 permanently for
 *     the session (data holes don't heal within a run), transient network
 *     errors for a short TTL — so scrubbing over a hole never re-fetches
 *     per tick.
 */

import { Grid, parseBinary, loadGrid } from './grid.js';

const DEFAULT_MAX_DECODED_BYTES = 300 * 1024 * 1024;

// Raw-tier entries larger than this never decode synchronously on the main
// thread — a 12-param swellpart file is ~25 MB of int16 and costs 40-80 ms
// to decode, which is exactly the scrub jank the sync path must never cause.
// Wind (~4 MB) and combined swell (~6 MB) stay comfortably under it.
const SYNC_DECODE_MAX_BYTES = 16 * 1024 * 1024;
// Sized to the 85-step (0–336h) timeline: a full real run's wind+swell int16
// bytes are ~880 MB (was ~590 MB for the old 57-step / 168h horizon).
const DEFAULT_MAX_RAW_BYTES = 1000 * 1024 * 1024;
const TRANSIENT_NEG_TTL_MS = 15 * 1000;
const PERMANENT_STATUSES = new Set([403, 404, 410]);

export class GridStore {
  constructor({
    maxBytes = DEFAULT_MAX_DECODED_BYTES,
    maxRawBytes = DEFAULT_MAX_RAW_BYTES,
    concurrency = 5,
    workerUrl = '/js/grid-worker.js',
  } = {}) {
    this.cache = new Map();     // url -> { grid, bytes }; Map order = LRU order
    this.totalBytes = 0;
    this.maxBytes = maxBytes;

    this.rawCache = new Map();  // url -> { buffer, bytes }; Map order = LRU order
    this.totalRawBytes = 0;
    this.maxRawBytes = maxRawBytes;

    this.concurrency = concurrency;

    this._negative = new Map(); // url -> expiry timestamp (Infinity = permanent)
    this._pending = new Map();  // url -> job
    this._queue = [];           // jobs not yet started
    this._inFlight = 0;

    this._workerUrl = workerUrl;
    this._worker = null;        // null = not created, false = unavailable
    this._workerJobs = new Map(); // id -> job
    this._nextId = 1;
  }

  /**
   * Synchronous lookup. Returns the decoded Grid, or null.
   * A raw-tier hit is decoded on the spot (a few ms — vastly cheaper than
   * any network wait, and only happens when the decoded LRU already evicted
   * that hour).
   */
  peek(url) {
    const hit = this.cache.get(url);
    if (hit) {
      this._touch(this.cache, url, hit);
      return hit.grid;
    }
    const raw = this.rawCache.get(url);
    if (raw) {
      if (raw.bytes > SYNC_DECODE_MAX_BYTES) return null; // worker's job
      this._touch(this.rawCache, url, raw);
      try {
        const grid = parseBinary(raw.buffer);
        this._storeDecoded(url, grid);
        return grid;
      } catch (e) {
        this.rawCache.delete(url);
        this.totalRawBytes -= raw.bytes;
        return null;
      }
    }
    return null;
  }

  /** True if the grid is available locally, decoded or raw (no LRU touch). */
  has(url) {
    return this.cache.has(url) || this.rawCache.has(url);
  }

  /** Number of URLs available locally — used to detect "fully prefetched". */
  readyCount() {
    let n = this.cache.size;
    for (const url of this.rawCache.keys()) {
      if (!this.cache.has(url)) n++;
    }
    return n;
  }

  /** True if the URL is negative-cached (known missing/failed, unexpired). */
  isNegative(url) {
    const until = this._negative.get(url);
    return until !== undefined && until > Date.now();
  }

  /**
   * Load a grid. Resolves with the Grid, or null on failure (never rejects).
   * Lower priority values start sooner; negative priorities are "the user is
   * looking at this right now": they may overflow the concurrency pool and
   * decode raw-tier hits synchronously.
   */
  load(url, priority = 0) {
    const hit = this.cache.get(url);
    if (hit) {
      this._touch(this.cache, url, hit);
      return Promise.resolve(hit.grid);
    }
    const negUntil = this._negative.get(url);
    if (negUntil !== undefined) {
      if (negUntil > Date.now()) return Promise.resolve(null);
      this._negative.delete(url);
    }
    const rawHit = this.rawCache.get(url);
    if (rawHit && priority < 0 && rawHit.bytes <= SYNC_DECODE_MAX_BYTES) {
      return Promise.resolve(this.peek(url)); // sync decode from raw tier
    }
    let job = this._pending.get(url);
    if (job) {
      if (priority < job.priority) job.priority = priority;
      this._pump();
      return job.promise;
    }
    job = { url, priority, started: false, workerId: 0 };
    job.promise = new Promise((resolve) => { job.resolve = resolve; });
    this._pending.set(url, job);
    this._queue.push(job);
    this._pump();
    return job.promise;
  }

  /** Drop queued work and abort in-flight fetches (e.g. run/model switch). */
  reset() {
    for (const job of this._queue) {
      this._pending.delete(job.url);
      job.resolve(null);
    }
    this._queue.length = 0;
    if (this._worker) {
      for (const job of this._workerJobs.values()) {
        this._worker.postMessage({ type: 'abort', id: job.workerId });
      }
    }
    this._negative.clear();
  }

  // ── internals ──

  _touch(map, url, hit) {
    // Map insertion order doubles as LRU order: re-insert on access.
    map.delete(url);
    map.set(url, hit);
  }

  _storeDecoded(url, grid) {
    if (this.cache.has(url)) return;
    let bytes = grid.arrays.reduce((s, a) => s + a.byteLength, 0);
    if (grid._groundView) {
      bytes += grid._groundView.arrays.reduce((s, a) => s + a.byteLength, 0);
    }
    this.cache.set(url, { grid, bytes });
    this.totalBytes += bytes;
    while (this.totalBytes > this.maxBytes && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value;
      if (oldest === url) break; // never evict the entry we just added
      this.totalBytes -= this.cache.get(oldest).bytes;
      this.cache.delete(oldest);
    }
  }

  _storeRaw(url, buffer) {
    if (!buffer || this.rawCache.has(url)) return;
    const bytes = buffer.byteLength;
    this.rawCache.set(url, { buffer, bytes });
    this.totalRawBytes += bytes;
    while (this.totalRawBytes > this.maxRawBytes && this.rawCache.size > 1) {
      const oldest = this.rawCache.keys().next().value;
      if (oldest === url) break;
      this.totalRawBytes -= this.rawCache.get(oldest).bytes;
      this.rawCache.delete(oldest);
    }
  }

  _storeNegative(url, status) {
    this._negative.set(url, PERMANENT_STATUSES.has(status) ? Infinity : Date.now() + TRANSIENT_NEG_TTL_MS);
  }

  _pump() {
    if (!this._queue.length) return;
    this._queue.sort((a, b) => a.priority - b.priority);
    while (this._queue.length) {
      // Urgent requests may overflow the pool by 2 so a scrub tick never
      // waits behind five in-flight background prefetches.
      const limit = this._queue[0].priority < 0 ? this.concurrency + 2 : this.concurrency;
      if (this._inFlight >= limit) break;
      const job = this._queue.shift();
      job.started = true;
      this._inFlight++;
      this._run(job);
    }
  }

  _run(job) {
    const finish = (grid, { status = 0, aborted = false, raw = null } = {}) => {
      this._inFlight--;
      this._pending.delete(job.url);
      if (grid) {
        if (raw) this._storeRaw(job.url, raw);
        this._storeDecoded(job.url, grid);
      } else if (!aborted) {
        this._storeNegative(job.url, status);
      }
      job.resolve(grid || null);
      this._pump();
    };
    job.finish = finish;

    const worker = this._ensureWorker();
    const raw = this.rawCache.get(job.url);

    if (worker) {
      job.workerId = this._nextId++;
      this._workerJobs.set(job.workerId, job);
      if (raw) {
        // Already fetched — background re-decode from the raw tier.
        // Copy (not transfer) so the raw tier keeps its buffer.
        this._touch(this.rawCache, job.url, raw);
        worker.postMessage({ type: 'decode', id: job.workerId, buffer: raw.buffer });
      } else {
        worker.postMessage({ type: 'load', id: job.workerId, url: job.url });
      }
      return;
    }

    // No worker support: fetch/decode on the main thread.
    if (raw) {
      this._touch(this.rawCache, job.url, raw);
      try {
        finish(parseBinary(raw.buffer));
      } catch (err) {
        finish(null, { status: 0 });
      }
      return;
    }
    fetch(job.url)
      .then(async resp => {
        if (!resp.ok) return finish(null, { status: resp.status });
        const buf = await resp.arrayBuffer();
        finish(parseBinary(buf), { raw: buf });
      })
      .catch(() => finish(null, { status: 0 }));
  }

  _ensureWorker() {
    if (this._worker !== null) return this._worker;
    try {
      this._worker = new Worker(this._workerUrl, { type: 'module' });
    } catch (e) {
      console.warn('GridStore: Worker unavailable, decoding on main thread', e);
      this._worker = false;
      return this._worker;
    }
    this._worker.onmessage = (e) => {
      const { id, ok, header, buffers, ground, raw, status, aborted } = e.data;
      const job = this._workerJobs.get(id);
      if (!job) return;
      this._workerJobs.delete(id);
      if (ok) {
        const grid = new Grid(header, buffers.map(b => new Float32Array(b)));
        if (ground) {
          grid._groundView = new Grid(header, ground.map(b => new Float32Array(b)));
        }
        job.finish(grid, { raw: raw || null });
      } else {
        job.finish(null, { status: status || 0, aborted: !!aborted });
      }
    };
    this._worker.onerror = (e) => {
      // Worker failed to boot (e.g. module workers unsupported). Fall back
      // to main-thread fetch/decode for outstanding and future loads.
      console.warn('GridStore: worker error, falling back to main thread', e.message || e);
      const jobs = [...this._workerJobs.values()];
      this._workerJobs.clear();
      try { this._worker.terminate(); } catch {}
      this._worker = false;
      for (const job of jobs) {
        loadGrid(job.url)
          .then(grid => job.finish(grid))
          .catch(err => job.finish(null, { status: err && err.status ? err.status : 0 }));
      }
    };
    return this._worker;
  }
}
