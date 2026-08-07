import { fetchWithRetry, cleanPrecipIn } from '../util.js';

/**
 * On-farm Davis Vantage Pro, published by WeatherLink as NOAA-format reports.
 *
 * This is the only gauge that sits ON one of the fields, so it is the closest
 * thing to ground truth available — and the reference the radar gets calibrated
 * against (see scripts/calibrate.mjs).
 *
 * HISTORY LIMIT: NOAAMO.txt holds only the CURRENT month's daily rows and is
 * overwritten when the month rolls. The server exposes no archive (probed for
 * NOAAMO<MMYY>, NOAAMO-YYYY-MM and similar — all 404). Daily on-farm history
 * therefore starts accumulating from the first ingest onward; run at least once
 * a month or a month's dailies are lost for good. NOAAYR.txt keeps monthly
 * totals for the whole year, so the monthly series backfills fully.
 */

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** Daily rows for the month the report currently covers. */
export async function fetchOnFarmDaily(url) {
  const text = await fetchWithRetry(url);

  // "MONTHLY CLIMATOLOGICAL SUMMARY for AUG. 2026"
  const head = text.match(/SUMMARY\s+for\s+([A-Z]{3})\w*\.?\s+(\d{4})/i);
  if (!head) return [];
  const month = MONTHS[head[1].toUpperCase()];
  const year = Number(head[2]);
  if (!month) return [];

  const out = [];
  for (const line of text.split(/\r?\n/)) {
    // DAY MEAN HIGH TIME LOW TIME HEAT COOL RAIN AVGWIND HIGH TIME DIR
    const m = line.match(/^\s{0,3}(\d{1,2})\s+(-?[\d.]+)\s+(-?[\d.]+)\s+\S+\s+(-?[\d.]+)\s+\S+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s/);
    if (!m) continue;                       // skips the blank future days and the summary row
    const day = Number(m[1]);
    if (day < 1 || day > 31) continue;
    out.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      precip_in: cleanPrecipIn(m[7]),
      mean_temp_f: Number(m[2]),
    });
  }
  return out;
}

/** Monthly totals for the year — the calibration series. */
export async function fetchOnFarmMonthly(url) {
  const text = await fetchWithRetry(url);
  const precipBlock = text.split(/PRECIPITATION\s*\(in\)/i)[1];
  if (!precipBlock) return [];
  const block = precipBlock.split(/WIND SPEED/i)[0];

  const out = [];
  for (const line of block.split(/\r?\n/)) {
    // " 26  7  3.36   0.00  0.92   30    6    6    0"  -> YR MO TOTAL DEP MAXDAY DATE ...
    const m = line.match(/^\s*(\d{2})\s+(\d{1,2})\s+([\d.]+)\s+([\d.-]+)\s+([\d.]+)\s/);
    if (!m) continue;
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) continue;
    out.push({
      month: `${2000 + Number(m[1])}-${String(mo).padStart(2, '0')}`,
      precip_in: cleanPrecipIn(m[3]),
      max_day_in: cleanPrecipIn(m[5]),
    });
  }
  return out;
}
