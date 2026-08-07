import { fetchWithRetry, MM_TO_IN, cleanPrecipIn, addDays } from '../util.js';

const NAMES_URL = 'https://mesonet.k-state.edu/rest/stationnames/';
const DATA_URL = 'https://mesonet.k-state.edu/rest/stationdata/';

/**
 * Kansas Mesonet (K-State). High-quality research-grade gauges, denser in KS
 * than the COOP network and reported on a fixed schedule.
 *
 * UNITS: this API returns precipitation in MILLIMETRES and silently ignores any
 * `units=` / `unit=` parameter you pass. Verified 2026-08-07: Colby reported
 * 4.32 for 2026-08-04, which is 0.170 in and matches COOP gauge CBKK1's 0.17 in
 * for the same day. Storing the raw value as inches inflates every reading 25.4x.
 */
/**
 * This API answers bad station names with HTTP 200 and a plain-text body
 * ("Error: X is not a valid station name") rather than a 4xx. Parsed naively
 * that becomes a bogus header row and silently poisons the table, so reject
 * any response that does not carry the expected CSV header.
 */
function parseCsv(text, requiredCol) {
  const body = text.trim();
  if (!body || /^Error:/i.test(body)) return [];
  const lines = body.split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map(s => s.trim().toUpperCase());
  if (requiredCol && !head.includes(requiredCol)) return [];
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

export async function fetchKsStations() {
  const rows = parseCsv(await fetchWithRetry(NAMES_URL), 'LATITUDE');
  return rows
    .map(r => ({
      id: r.NAME,                      // the `stn` query param expects NAME, not ABBR
      network: 'KS_MESONET',
      name: r.NAME,
      lat: Number(r.LATITUDE),
      lon: Number(r.LONGITUDE),
      elev_m: Number(r.ELEVATION) || null,
    }))
    .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.id);
}

const stamp = (iso, tail) => iso.replaceAll('-', '') + tail;

/**
 * DATE CONVENTION: this feed stamps a daily total at the END of its accumulation
 * window, so the row labelled "2026-07-10 00:00:00" is the rain that fell on
 * 2026-07-09. Measured against MRMS at the same point over 219 days of 2026:
 * r = 0.985 at lag -1 versus r = 0.081 at lag 0 — unambiguous. We therefore
 * shift these dates back one day and request one extra day at the top of the
 * range so the caller's window stays fully covered.
 *
 * This shift is specific to Kansas Mesonet. Measured the same way, KS_ASOS is
 * already aligned (r = 0.744 at lag 0) and KS_COOP smears across both days
 * (0.668 at lag 0, 0.480 at lag -1) because its observer window is 7am-to-7am
 * attributed to the reading date — no whole-day shift fixes that one.
 */
export async function fetchKsStationRange(stationName, sdate, edate) {
  const url = `${DATA_URL}?stn=${encodeURIComponent(stationName)}&int=day`
            + `&t_start=${stamp(addDays(sdate, 1), '000000')}&t_end=${stamp(addDays(edate, 1), '000000')}&vars=PRECIP`;
  // A handful of stations (e.g. "Sheridan", verified 2026-08-07) 500 on their
  // side for any date range. Retrying can't fix it, so fail soft with no rows
  // and let the next-nearest gauge cover the field.
  let text;
  try {
    text = await fetchWithRetry(url, { tries: 2 });
  } catch (e) {
    if (/HTTP 5\d\d/.test(e.message)) return [];
    throw e;
  }
  return parseCsv(text, 'PRECIP')
    .map(r => {
      const stamped = (r.TIMESTAMP || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(stamped)) return null;
      const raw = r.PRECIP;
      const mm = raw === '' || raw === undefined ? null : Number(raw);
      return {
        date: addDays(stamped, -1),            // see DATE CONVENTION above
        precip_in: mm === null ? null : cleanPrecipIn(mm * MM_TO_IN),
      };
    })
    .filter(r => r && r.date >= sdate && r.date <= edate);
}
