import { route, json } from '../_lib/http.mjs';
import { fetchNdbcText, buildStationList } from '../_lib/ndbc.mjs';

/**
 * GET /api/buoys/stations
 * NDBC station list for the buoy map layer: id, name, lat, lng, plus flags
 * for wave summary (.spec) and raw spectral (.data_spec) availability.
 * Filtered to stations whose realtime feed updated within the last 7 days.
 */
export default route(async (req, res) => {
  const [xml, indexHtml] = await Promise.all([
    fetchNdbcText('/activestations.xml', 60 * 60 * 1000),
    fetchNdbcText('/data/realtime2/', 60 * 60 * 1000),
  ]);
  const stations = buildStationList(xml, indexHtml);
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
  json(res, 200, { count: stations.length, stations });
});
