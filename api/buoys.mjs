import { route, json, HttpError } from './_lib/http.mjs';
import {
  fetchNdbcText, buildStationList, normalizeStationId,
  parseStdmet, latestStdmetObs, parseSpec, latestSpecSummary,
  parseDataSpec, parseSwdir, mergeSpectrum,
} from './_lib/ndbc.mjs';

/**
 * GET /api/buoys?kind=stations|obs|spectrum[&station=46042]
 * Single function for all NDBC endpoints — Vercel's Hobby plan caps a
 * deployment at 12 functions, and three separate buoy routes put the
 * project at 13. vercel.json rewrites keep the public URLs
 * (/api/buoys/stations etc.) unchanged.
 */

async function stations(req, res) {
  const [xml, indexHtml] = await Promise.all([
    fetchNdbcText('/activestations.xml', 60 * 60 * 1000),
    fetchNdbcText('/data/realtime2/', 60 * 60 * 1000),
  ]);
  const list = buildStationList(xml, indexHtml);
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
  json(res, 200, { count: list.length, stations: list });
}

async function obs(req, res) {
  const station = normalizeStationId(req.query.station);
  if (!station) throw new HttpError(400, 'bad_station');

  const [txtRes, specRes] = await Promise.allSettled([
    fetchNdbcText(`/data/realtime2/${station}.txt`, 5 * 60 * 1000),
    fetchNdbcText(`/data/realtime2/${station}.spec`, 5 * 60 * 1000),
  ]);

  const latest = txtRes.status === 'fulfilled'
    ? latestStdmetObs(parseStdmet(txtRes.value)) : null;
  const spec = specRes.status === 'fulfilled'
    ? latestSpecSummary(parseSpec(specRes.value)) : null;

  if (!latest && !spec) throw new HttpError(404, 'no_data');

  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=600');
  json(res, 200, { station, obs: latest, spec });
}

async function spectrum(req, res) {
  const station = normalizeStationId(req.query.station);
  if (!station) throw new HttpError(400, 'bad_station');

  const [dsRes, sdRes] = await Promise.allSettled([
    fetchNdbcText(`/data/realtime2/${station}.data_spec`, 15 * 60 * 1000),
    fetchNdbcText(`/data/realtime2/${station}.swdir`, 15 * 60 * 1000),
  ]);

  const dataSpec = dsRes.status === 'fulfilled' ? parseDataSpec(dsRes.value) : null;
  if (!dataSpec) throw new HttpError(404, 'no_spectral_data');
  const swdir = sdRes.status === 'fulfilled' ? parseSwdir(sdRes.value) : null;

  const merged = mergeSpectrum(dataSpec, swdir);
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=1800');
  json(res, 200, { station, ...merged });
}

const kinds = { stations, obs, spectrum };

export default route(async (req, res) => {
  const handler = kinds[req.query.kind];
  if (!handler) throw new HttpError(400, 'bad_kind');
  await handler(req, res);
});
