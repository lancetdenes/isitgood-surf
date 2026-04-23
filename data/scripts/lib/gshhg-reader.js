/**
 * Generator yielding GSHHG polygons from a Node Buffer.
 *
 * Format (from gshhs.h):
 *   Per polygon:
 *     11 × int32 BE header (id, n, flag, w, e, s, n, area, area_full, container, ancestor)
 *     n × (int32 lon, int32 lat) BE, in microdegrees
 *
 *   `level` is bits 0-7 of `flag`:
 *     1 = land, 2 = lake, 3 = island in lake, 4 = pond in island in lake, 5 = Antarctica ice
 *
 * @param {Buffer} buf
 * @yields {{ id: number, level: number, points: Array<[number, number]> }}
 */
export function* readGshhg(buf) {
  let offset = 0;
  while (offset + 44 <= buf.length) {
    const id = buf.readInt32BE(offset + 0);
    const n = buf.readInt32BE(offset + 4);
    const flag = buf.readInt32BE(offset + 8);
    const level = flag & 0xff;
    offset += 44;

    const points = new Array(n);
    for (let i = 0; i < n; i++) {
      const lon = buf.readInt32BE(offset) / 1e6;
      const lat = buf.readInt32BE(offset + 4) / 1e6;
      points[i] = [lon, lat];
      offset += 8;
    }
    yield { id, level, points };
  }
}
