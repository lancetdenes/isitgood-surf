/**
 * Writer — builds a Node Buffer for the CST1 custom coastline binary.
 * @param {Array<Array<[number, number]>>} features - each feature is an array of [lon, lat]
 * @returns {Buffer}
 */
export function writeCoastlineBinary(features) {
  const { Buffer } = globalThis; // available in Node; browser will use parseCoastlineBinary
  const nFeatures = features.length;
  const nVertices = features.reduce((s, f) => s + f.length, 0);
  const size = 16 + (nFeatures + 1) * 4 + nVertices * 4 * 2;
  const buf = Buffer.alloc(size);

  // Header
  buf.write('CST1', 0, 4, 'ascii');
  buf.writeUInt32LE(nFeatures, 4);
  buf.writeUInt32LE(nVertices, 8);
  buf.writeUInt32LE(1, 12);

  // Offsets
  const offsetsStart = 16;
  let vIdx = 0;
  for (let f = 0; f < nFeatures; f++) {
    buf.writeUInt32LE(vIdx, offsetsStart + f * 4);
    vIdx += features[f].length;
  }
  buf.writeUInt32LE(vIdx, offsetsStart + nFeatures * 4); // sentinel

  // Vertex data: lons then lats
  const lonStart = offsetsStart + (nFeatures + 1) * 4;
  const latStart = lonStart + nVertices * 4;
  vIdx = 0;
  for (let f = 0; f < nFeatures; f++) {
    for (const [lon, lat] of features[f]) {
      buf.writeFloatLE(lon, lonStart + vIdx * 4);
      buf.writeFloatLE(lat, latStart + vIdx * 4);
      vIdx++;
    }
  }

  return buf;
}

/**
 * Parser — read an ArrayBuffer and return random-access views.
 * Works in both Node and browsers (DataView / Float32Array).
 */
export function parseCoastlineBinary(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'CST1') {
    throw new Error(`Invalid coastline binary: expected magic "CST1", got "${magic}"`);
  }
  const nFeatures = dv.getUint32(4, true);
  const nVertices = dv.getUint32(8, true);
  const version = dv.getUint32(12, true);
  if (version !== 1) {
    throw new Error(`Unsupported coastline binary version ${version}`);
  }

  const offsetsStart = 16;
  const offsets = new Uint32Array(arrayBuffer, offsetsStart, nFeatures + 1);
  const lonStart = offsetsStart + (nFeatures + 1) * 4;
  const lons = new Float32Array(arrayBuffer, lonStart, nVertices);
  const lats = new Float32Array(arrayBuffer, lonStart + nVertices * 4, nVertices);

  return {
    nFeatures,
    nVertices,
    offsets,
    lons,
    lats,
    /** Random-access vertex getter: returns [lon, lat] for feature f, vertex i within it. */
    vertex(f, i) {
      const idx = offsets[f] + i;
      return [lons[idx], lats[idx]];
    },
    /** Length of feature f. */
    featureLength(f) {
      return offsets[f + 1] - offsets[f];
    },
    /** Convenience: return all points of feature f as [[lon, lat], ...]. */
    feature(f) {
      const n = this.featureLength(f);
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = this.vertex(f, i);
      return out;
    },
  };
}
