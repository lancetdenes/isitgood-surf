/**
 * grid-worker.js — fetch + decode SRF2 grids off the main thread.
 *
 * The int16→Float32 decode of a real 1440×721 grid allocates 8–12 MB and
 * burns a few ms of CPU per file; during timeline scrubbing / prefetching
 * that work used to land on the main thread. This module worker does the
 * fetch AND the decode, then transfers the decoded ArrayBuffers back
 * (zero-copy) so the main thread only wraps them in a Grid. The raw file
 * bytes are transferred back too — the store keeps them as a compact
 * second cache tier (int16 is half the size of Float32).
 *
 * Protocol (postMessage):
 *   in:  { type: 'load',   id, url }          fetch + decode
 *   in:  { type: 'decode', id, buffer }       decode already-fetched bytes
 *   in:  { type: 'abort',  id }
 *   out: { id, ok: true,  header: {nx,ny,lo1,la1,dx,dy}, buffers: ArrayBuffer[], raw?: ArrayBuffer }
 *   out: { id, ok: false, status?: number, aborted?: boolean, error?: string }
 */

import { parseBinary } from './grid.js';

const controllers = new Map(); // id -> AbortController

function decodeAndPost(id, buf, includeRaw) {
  const grid = parseBinary(buf);
  const header = { nx: grid.nx, ny: grid.ny, lo1: grid.lo1, la1: grid.la1, dx: grid.dx, dy: grid.dy };
  const buffers = grid.arrays.map(a => a.buffer);
  if (includeRaw) {
    self.postMessage({ id, ok: true, header, buffers, raw: buf }, [...buffers, buf]);
  } else {
    self.postMessage({ id, ok: true, header, buffers }, buffers);
  }
}

self.onmessage = async (e) => {
  const { type, id, url, buffer } = e.data;

  if (type === 'abort') {
    const ctrl = controllers.get(id);
    if (ctrl) ctrl.abort();
    return;
  }

  if (type === 'decode') {
    try {
      decodeAndPost(id, buffer, false);
    } catch (err) {
      self.postMessage({ id, ok: false, status: 0, error: String(err) });
    }
    return;
  }

  if (type !== 'load') return;

  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      self.postMessage({ id, ok: false, status: resp.status });
      return;
    }
    const buf = await resp.arrayBuffer();
    decodeAndPost(id, buf, true);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      self.postMessage({ id, ok: false, aborted: true });
    } else {
      self.postMessage({ id, ok: false, status: 0, error: String(err) });
    }
  } finally {
    controllers.delete(id);
  }
};
