import { route, json, HttpError } from '../_lib/http.mjs';
import {
  fetchNdbcText, normalizeStationId,
  parseDataSpec, parseSwdir, mergeSpectrum,
} from '../_lib/ndbc.mjs';

/**
 * GET /api/buoys/spectrum?station=46042
 * Raw spectral energy density (.data_spec) with per-frequency mean wave
 * direction (.swdir) merged in when available:
 *   { station, time, sepFreq, bins: [{freq, period, energy, dir|null}] }
 */
export default route(async (req, res) => {
  const station = normalizeStationId(req.query.station);
  if (!station) throw new HttpError(400, 'bad_station');

  const [dsRes, sdRes] = await Promise.allSettled([
    fetchNdbcText(`/data/realtime2/${station}.data_spec`, 15 * 60 * 1000),
    fetchNdbcText(`/data/realtime2/${station}.swdir`, 15 * 60 * 1000),
  ]);

  const dataSpec = dsRes.status === 'fulfilled' ? parseDataSpec(dsRes.value) : null;
  if (!dataSpec) throw new HttpError(404, 'no_spectral_data');
  const swdir = sdRes.status === 'fulfilled' ? parseSwdir(sdRes.value) : null;

  const spectrum = mergeSpectrum(dataSpec, swdir);
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=1800');
  json(res, 200, { station, ...spectrum });
});
