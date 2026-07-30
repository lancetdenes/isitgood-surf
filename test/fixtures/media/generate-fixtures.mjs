#!/usr/bin/env node
/**
 * generate-fixtures.mjs — regenerates the checked-in media fixtures:
 *
 *   placeholder-1.png … placeholder-6.png  — small "surf photo" placeholder
 *     images (rendered from SVG via @resvg/resvg-js) used by the local mock
 *     media backend (server-media-mock.js) to seed the map with photos.
 *
 *   gps-higgins.jpg — a tiny valid baseline JPEG carrying a real EXIF APP1
 *     segment with GPS coordinates ~200 m off Higgins Beach, ME and a
 *     DateTimeOriginal of "now" (generation time). Used to exercise the
 *     auto-assign (EXIF → spot snap) upload flow end-to-end without needing
 *     exiftool or a phone photo.
 *
 * Run: node test/fixtures/media/generate-fixtures.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ── 1. Placeholder photos ──────────────────────────────────────────────

const SCENES = [
  { top: '#0b1d3a', mid: '#14507a', bot: '#2b7fae', sun: '#f5d78f', label: 'dawn glass' },
  { top: '#12324f', mid: '#1e6a96', bot: '#54a8c7', sun: '#fdf3d0', label: 'morning' },
  { top: '#1a4a6e', mid: '#2e86ab', bot: '#7cc4dd', sun: '#ffffff', label: 'midday' },
  { top: '#243b55', mid: '#3a6b8a', bot: '#6795ad', sun: '#f0c987', label: 'afternoon' },
  { top: '#3d2b52', mid: '#6e4a6f', bot: '#c98a6d', sun: '#f7a35c', label: 'sunset' },
  { top: '#0d1526', mid: '#1a2c47', bot: '#31517a', sun: '#cdd8ec', label: 'dusk' },
];

function sceneSvg({ top, mid, bot, sun, label }, i) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${mid}"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${mid}"/><stop offset="1" stop-color="${bot}"/>
    </linearGradient>
  </defs>
  <rect width="320" height="130" fill="url(#sky)"/>
  <circle cx="${60 + i * 40}" cy="78" r="16" fill="${sun}" opacity="0.85"/>
  <rect y="130" width="320" height="110" fill="url(#sea)"/>
  <path d="M0 150 Q40 138 80 150 T160 150 T240 150 T320 150 V240 H0 Z" fill="${mid}" opacity="0.55"/>
  <path d="M0 175 Q53 160 106 175 T212 175 T320 175 V240 H0 Z" fill="#ffffff" opacity="0.16"/>
  <path d="M0 205 Q64 192 128 205 T256 205 T320 202 V240 H0 Z" fill="#ffffff" opacity="0.10"/>
  <text x="12" y="228" font-family="Helvetica, Arial, sans-serif" font-size="13"
        fill="#ffffff" opacity="0.75">${label} · fixture ${i + 1}</text>
</svg>`;
}

SCENES.forEach((scene, i) => {
  const png = new Resvg(sceneSvg(scene, i), { fitTo: { mode: 'width', value: 320 } }).render().asPng();
  writeFileSync(path.join(DIR, `placeholder-${i + 1}.png`), png);
  console.log(`placeholder-${i + 1}.png  ${png.length} bytes`);
});

// ── 2. Minimal JPEG with GPS EXIF ─────────────────────────────────────
// A hand-built 8x8 solid-gray baseline JPEG (custom 1-symbol Huffman
// tables; every coefficient zero) with an EXIF APP1 segment containing
// DateTimeOriginal + GPS. Standards-compliant: browsers decode it and
// exifr parses the metadata.

const LAT = 43.5622, LNG = -70.2312;             // ~250 m off Higgins Beach, ME

function u16(v) { return [(v >> 8) & 0xff, v & 0xff]; }        // big-endian (JPEG markers)
function le16(v) { return [v & 0xff, (v >> 8) & 0xff]; }        // little-endian (TIFF II)
function le32(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }

function ifdEntry(tag, type, count, valueOrOffset, inlineBytes = null) {
  // inlineBytes: value fits in the 4-byte field (padded); else valueOrOffset is an offset.
  const out = [...le16(tag), ...le16(type), ...le32(count)];
  if (inlineBytes) {
    const v = [...inlineBytes];
    while (v.length < 4) v.push(0);
    out.push(...v);
  } else {
    out.push(...le32(valueOrOffset));
  }
  return out;
}

function rational(num, den) { return [...le32(num), ...le32(den)]; }

function dmsRationals(deg) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60 * 1000);              // seconds ×1000
  return [...rational(d, 1), ...rational(m, 1), ...rational(s, 1000)];
}

function buildExifApp1(lat, lng, dateStr) {
  // Layout (offsets relative to TIFF header start):
  //   8: IFD0 (2 entries) → ExifIFD ptr, GPSIFD ptr
  //   then ExifIFD (1 entry: DateTimeOriginal), GPSIFD (4 entries), data area.
  const ifd0Off = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const exifIfdOff = ifd0Off + ifd0Size;
  const exifIfdSize = 2 + 1 * 12 + 4;
  const gpsIfdOff = exifIfdOff + exifIfdSize;
  const gpsIfdSize = 2 + 4 * 12 + 4;
  let dataOff = gpsIfdOff + gpsIfdSize;

  const data = [];
  const push = (bytes) => { const at = dataOff; data.push(...bytes); dataOff += bytes.length; return at; };

  const dateBytes = [...Buffer.from(dateStr, 'ascii'), 0];      // "YYYY:MM:DD HH:MM:SS\0" = 20 bytes
  const dateAt = push(dateBytes);
  const latAt = push(dmsRationals(lat));
  const lngAt = push(dmsRationals(lng));

  const ifd0 = [
    ...le16(2),
    ...ifdEntry(0x8769, 4, 1, exifIfdOff),                      // ExifIFDPointer LONG
    ...ifdEntry(0x8825, 4, 1, gpsIfdOff),                       // GPSIFDPointer LONG
    ...le32(0),
  ];
  const exifIfd = [
    ...le16(1),
    ...ifdEntry(0x9003, 2, dateBytes.length, dateAt),           // DateTimeOriginal ASCII
    ...le32(0),
  ];
  const gpsIfd = [
    ...le16(4),
    ...ifdEntry(0x0001, 2, 2, 0, [...Buffer.from(lat >= 0 ? 'N' : 'S', 'ascii'), 0]),
    ...ifdEntry(0x0002, 5, 3, latAt),                           // GPSLatitude RATIONAL×3
    ...ifdEntry(0x0003, 2, 2, 0, [...Buffer.from(lng >= 0 ? 'E' : 'W', 'ascii'), 0]),
    ...ifdEntry(0x0004, 5, 3, lngAt),                           // GPSLongitude RATIONAL×3
    ...le32(0),
  ];

  const tiff = [
    0x49, 0x49, 0x2a, 0x00, ...le32(ifd0Off),                   // "II*\0" + IFD0 offset
    ...ifd0, ...exifIfd, ...gpsIfd, ...data,
  ];
  const payload = [...Buffer.from('Exif\0\0', 'ascii'), ...tiff];
  return [0xff, 0xe1, ...u16(payload.length + 2), ...payload];
}

function buildJpeg(app1) {
  const dqt = [0xff, 0xdb, ...u16(2 + 1 + 64), 0x00, ...new Array(64).fill(8)];
  const sof0 = [0xff, 0xc0, ...u16(11), 8, ...u16(8), ...u16(8), 1, 0x01, 0x11, 0x00];
  // Custom trivial Huffman tables: one 1-bit code for symbol 0 (DC cat 0 / AC EOB).
  const counts = [1, ...new Array(15).fill(0)];
  const dhtDc = [0xff, 0xc4, ...u16(2 + 1 + 16 + 1), 0x00, ...counts, 0x00];
  const dhtAc = [0xff, 0xc4, ...u16(2 + 1 + 16 + 1), 0x10, ...counts, 0x00];
  const sos = [0xff, 0xda, ...u16(8), 1, 0x01, 0x00, 0x00, 0x3f, 0x00];
  const scan = [0x3f];                                          // bits "00" + 1-padding
  return Buffer.from([0xff, 0xd8, ...app1, ...dqt, ...sof0, ...dhtDc, ...dhtAc, ...sos, ...scan, 0xff, 0xd9]);
}

const now = new Date();
const p2 = (v) => String(v).padStart(2, '0');
const exifDate = `${now.getFullYear()}:${p2(now.getMonth() + 1)}:${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;

const jpeg = buildJpeg(buildExifApp1(LAT, LNG, exifDate));
writeFileSync(path.join(DIR, 'gps-higgins.jpg'), jpeg);
console.log(`gps-higgins.jpg  ${jpeg.length} bytes  (${LAT}, ${LNG}) @ ${exifDate}`);

// Self-check: exifr must read back what we wrote.
const { default: exifr } = await import('exifr');
const parsed = await exifr.parse(jpeg, { exif: ['DateTimeOriginal'], gps: true });
if (!parsed || Math.abs(parsed.latitude - LAT) > 0.001 || Math.abs(parsed.longitude - LNG) > 0.001) {
  console.error('SELF-CHECK FAILED:', parsed);
  process.exit(1);
}
console.log('self-check ok:', parsed.latitude.toFixed(4), parsed.longitude.toFixed(4), parsed.DateTimeOriginal);
