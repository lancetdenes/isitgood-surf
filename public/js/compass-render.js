/**
 * Render a compass SVG showing coast snippet, swell arrow, and wind barbs.
 * Pure function — accepts the snippet so it can be reused by the test harness
 * without going through coastline.js/getCoastSnippet().
 *
 * @param {number} size - rendered pixel size
 * @param {object} h - hour data: {swellHeightFt, windSpeedMph, swellDir, windDir}
 * @param {object} coast - {coastBearing}
 * @param {{subpaths: Array<Array<{x:number,y:number}>>, landSide: string}|null} snip
 * @param {boolean} mini
 * @param {string|null} bgColor
 * @returns {string} SVG string
 */
export function renderCompass(size, h, coast, snip, mini = false, bgColor = null) {
  const vb = 200;
  const cx = 100, cy = 100, r = 85;
  const bg = bgColor || 'rgba(15,23,42,0.8)';
  const cb = coast.coastBearing;

  const ht = Math.min(h.swellHeightFt, 8);
  const arrowW = mini ? Math.max(4, 3 + ht) : Math.max(2, 1.5 + ht * 0.5);
  const arrowH = mini ? Math.max(16, 10 + ht * 4) : Math.max(14, 10 + ht * 3);
  const headW = mini ? Math.max(10, 6 + ht * 2) : Math.max(6, 4 + ht * 1.5);
  const headH = mini ? 14 : 10;
  const arrowStart = mini ? -70 : -58;
  const shaftEnd = arrowStart + arrowH;
  const arrowTip = shaftEnd + headH;
  const arrowOp = Math.min(0.95, 0.5 + ht / 10);

  const ws = Math.min(h.windSpeedMph, 30);
  const barbCount = Math.max(1, Math.min(6, Math.ceil(ws / 5)));
  const barbLen = mini ? Math.max(20, 15 + ws) : Math.max(18, 12 + ws * 0.8);
  const barbW = mini ? 4 : 1.4;
  const barbOp = Math.min(0.7, 0.3 + ws / 30);
  const barbSpacing = mini ? 12 : 10;

  const labels = mini ? '' : `
    <text x="100" y="10" text-anchor="middle" fill="#475569" font-size="11" font-weight="600">N</text>
    <text x="194" y="104" text-anchor="middle" fill="#475569" font-size="11" font-weight="600">E</text>
    <text x="100" y="198" text-anchor="middle" fill="#475569" font-size="11" font-weight="600">S</text>
    <text x="6" y="104" text-anchor="middle" fill="#475569" font-size="11" font-weight="600">W</text>
  `;

  let barbs = '';
  const halfSpread = ((barbCount - 1) * barbSpacing) / 2;
  for (let i = 0; i < barbCount; i++) {
    const x = -halfSpread + i * barbSpacing;
    const startY = -(r - 8);
    const endY = startY + barbLen;
    barbs += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${endY}" stroke="white" stroke-width="${barbW}" stroke-dasharray="${mini ? '8,6' : '5,4'}"/>`;
    barbs += `<line x1="${x}" y1="${endY}" x2="${x + (mini ? 10 : 6)}" y2="${endY - (mini ? 10 : 6)}" stroke="white" stroke-width="${barbW}"/>`;
  }

  let coastSvg;
  if (mini) {
    coastSvg = `
      <g transform="translate(${cx},${cy}) rotate(${cb})">
        <path d="M 0,-${r} A ${r} ${r} 0 0 1 0,${r}" fill="rgba(56,189,248,0.04)"/>
        <line x1="0" y1="-${r}" x2="0" y2="${r}" stroke="rgba(148,163,184,0.2)" stroke-width="4"/>
      </g>
    `;
  } else if (snip && snip.subpaths.length) {
    // Adaptive scale: measure the snippet's actual bounding-box radius from
    // its centroid and scale so the bbox fits within 70% of the compass
    // radius. A short straight beach, a tight headland, and a long fjord
    // all end up the same visual size — the local SHAPE is what matters,
    // not the absolute km extent. Also keeps the line from touching the
    // bezel on both sides (which made the compass feel "stretched").
    let cxKm = 0, cyKm = 0, n = 0;
    for (const sub of snip.subpaths) for (const p of sub) { cxKm += p.x; cyKm += p.y; n++; }
    cxKm /= n; cyKm /= n;
    let maxR = 0;
    for (const sub of snip.subpaths) for (const p of sub) {
      const d = Math.hypot(p.x - cxKm, p.y - cyKm);
      if (d > maxR) maxR = d;
    }
    const scale = maxR > 0.5 ? (r * 0.7) / maxR : r * 0.7 / 2; // sane default for tiny snippets
    const paths = snip.subpaths.map(sub => {
      return sub.map((p, i) => {
        const sx = cx + (p.x - cxKm) * scale;
        const sy = cy - (p.y - cyKm) * scale;
        return `${i === 0 ? 'M' : 'L'} ${sx.toFixed(1)},${sy.toFixed(1)}`;
      }).join(' ');
    }).join(' ');
    coastSvg = `<path d="${paths}" stroke="rgba(148,163,184,0.7)" stroke-width="2" fill="none" clip-path="url(#compass-clip)"/>`;
  } else {
    coastSvg = `
      <g transform="translate(${cx},${cy}) rotate(${cb})">
        <line x1="0" y1="-${r}" x2="0" y2="${r}" stroke="rgba(148,163,184,0.2)" stroke-width="2"/>
      </g>
    `;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}">
      <defs>
        <clipPath id="compass-clip"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${bg}" stroke="rgba(148,163,184,0.12)" stroke-width="${mini ? 3 : 1}"/>
      ${coastSvg}
      ${labels}
      <g transform="translate(${cx},${cy}) rotate(${h.swellDir})">
        <rect x="${-arrowW}" y="${arrowStart}" width="${arrowW * 2}" height="${arrowH}" fill="white" opacity="${arrowOp}" rx="${mini ? 2 : 1}"/>
        <polygon points="0,${arrowTip} ${-headW},${shaftEnd} ${headW},${shaftEnd}" fill="white" opacity="${arrowOp}"/>
      </g>
      <g transform="translate(${cx},${cy}) rotate(${h.windDir})" opacity="${barbOp}">
        ${barbs}
      </g>
    </svg>`;
}
