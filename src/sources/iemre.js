import { fetchWithRetry, iemRows, cleanPrecipIn } from '../util.js';

const BASE = 'https://mesonet.agron.iastate.edu/api/1/iemre/multiday.json';

/**
 * IEM Reanalysis point extraction. Returns MRMS (radar+gauge QPE), PRISM
 * (4km climatological analysis) and the IEMRE daily analysis for one lat/lon.
 *
 * Grid caveat: IEMRE is a ~0.125 deg (~12 km) grid, coarser than MRMS's native
 * 1 km. Fields within ~7 miles of each other can land in the same cell and
 * report identical numbers. See README "Upgrading to native 1km MRMS".
 */
/**
 * Split a range at calendar-year boundaries.
 *
 * Load-bearing: a request spanning 2025-08-07..2026-08-07 comes back HTTP 200
 * with valid JSON containing exactly ONE row, no error and no warning. Same
 * request inside a single year returns all 219/147/68 days correctly. Verified
 * 2026-08-07. Without this split a year-long backfill silently records ~0.5 in
 * of annual rainfall instead of ~18 in, and nothing anywhere reports a failure.
 */
export function yearChunks(sdate, edate) {
  const out = [];
  let s = sdate;
  while (s <= edate) {
    const yearEnd = `${s.slice(0, 4)}-12-31`;
    const e = yearEnd < edate ? yearEnd : edate;
    out.push([s, e]);
    s = `${Number(s.slice(0, 4)) + 1}-01-01`;
  }
  return out;
}

export async function fetchIemre(lat, lon, sdate, edate) {
  const rows = [];
  for (const [s, e] of yearChunks(sdate, edate)) {
    const url = `${BASE}?lon=${lon}&lat=${lat}&sdate=${s}&edate=${e}`;
    rows.push(...iemRows(await fetchWithRetry(url, { accept: 'json' })));
  }
  return rows.map(r => ({
    date: String(r.date).slice(0, 10),
    mrms: cleanPrecipIn(r.mrms_precip_in),
    prism: cleanPrecipIn(r.prism_precip_in),
    iemre: cleanPrecipIn(r.daily_precip_in),
    high_f: Number.isFinite(r.daily_high_f) ? r.daily_high_f : null,
    low_f: Number.isFinite(r.daily_low_f) ? r.daily_low_f : null,
  }));
}
