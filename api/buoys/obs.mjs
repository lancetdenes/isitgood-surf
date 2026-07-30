import { route, json, HttpError } from '../_lib/http.mjs';
import {
  fetchNdbcText, normalizeStationId,
  parseStdmet, latestStdmetObs, parseSpec, latestSpecSummary,
} from '../_lib/ndbc.mjs';

/**
 * GET /api/buoys/obs?station=46042
 * Latest standard-met observation (.txt) merged with the spectral wave
 * summary (.spec) for one NDBC station. Either feed may be absent.
 */
export default route(async (req, res) => {
  const station = normalizeStationId(req.query.station);
  if (!station) throw new HttpError(400, 'bad_station');

  const [txtRes, specRes] = await Promise.allSettled([
    fetchNdbcText(`/data/realtime2/${station}.txt`, 5 * 60 * 1000),
    fetchNdbcText(`/data/realtime2/${station}.spec`, 5 * 60 * 1000),
  ]);

  const obs = txtRes.status === 'fulfilled'
    ? latestStdmetObs(parseStdmet(txtRes.value)) : null;
  const spec = specRes.status === 'fulfilled'
    ? latestSpecSummary(parseSpec(specRes.value)) : null;

  if (!obs && !spec) throw new HttpError(404, 'no_data');

  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=600');
  json(res, 200, { station, obs, spec });
});
