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

/** `NOAAMO.txt` / `noaayr.txt` — the stem, which of the two it is, the suffix. */
const REPORT_NAME = /^(.*?noaa)(mo|yr)(\.[^.]*)$/i;

/** Swap MO for YR or back, in whatever case it was written in: a host that
 *  serves `noaamo.txt` is not going to have `noaaYR.txt` beside it. */
const swapKind = (name, want) => name.replace(REPORT_NAME, (_, stem, kind, ext) =>
  stem + (kind === kind.toLowerCase() ? want.toLowerCase() : want) + ext);

/**
 * Turn whatever somebody pasted into the pair of addresses to read.
 *
 * The two reports always live beside each other — WeatherLink writes them into
 * the same folder — so asking for both separately asks the same question twice
 * and invites the answer that started this: one install had the *yearly* file
 * in the daily slot and went months collecting no daily rows at all. Give it
 * the folder, or either file, and the other one is derived.
 *
 * Returns candidates in the order worth trying. A folder yields two, because
 * WeatherLink names them in upper case but a case-sensitive host serving them
 * lower is the other thing seen in the wild, and one extra HEAD-sized request
 * at setup time is cheaper than a setting that silently reads nothing.
 */
export function reportPairs(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return [];
  let u;
  try { u = new URL(raw); } catch { return []; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];

  const last = u.pathname.split('/').pop();
  const named = REPORT_NAME.exec(last);
  if (named) {
    const mo = named[2].toLowerCase() === 'mo';
    return [{
      dailyUrl: mo ? raw : new URL(swapKind(last, 'MO'), raw).href,
      yearlyUrl: mo ? new URL(swapKind(last, 'YR'), raw).href : raw,
    }];
  }
  // Some other filename. It can only be the report somebody meant to give, and
  // there is no sibling to derive — the yearly box is still there for that.
  if (last.includes('.')) return [{ dailyUrl: raw, yearlyUrl: null }];

  const dir = raw.endsWith('/') ? raw : `${raw}/`;
  return [
    { dailyUrl: `${dir}NOAAMO.txt`, yearlyUrl: `${dir}NOAAYR.txt` },
    { dailyUrl: `${dir}noaamo.txt`, yearlyUrl: `${dir}noaayr.txt` },
  ];
}

/**
 * The report header, which is where the station's own coordinates live.
 *
 * Worth parsing because it is the one number a person setting this up cannot
 * read off a map: it has to be the STATION's position, not the field's, and
 * WeatherLink prints it in degrees/minutes/seconds. Reading it out of the file
 * removes the only step of this setup that needs a conversion.
 */
export function parseStationHeader(text) {
  const head = String(text ?? '').slice(0, 1500);
  const seg = re => re.exec(head)?.[1]?.trim() || null;
  const elev = seg(/\bELEV(?:ATION)?:\s*(-?[\d.]+)/i);
  return {
    name: seg(/^\s*NAME:\s*(.+?)(?:\s\s+\w+:.*)?$/mi),
    elev_ft: elev !== null && Number.isFinite(Number(elev)) ? Number(elev) : null,
    lat: degrees(seg(/\bLAT(?:ITUDE)?:\s*(.*?)(?=\s+LON|\s*$)/mi), 'NS'),
    lon: degrees(seg(/\bLON(?:GITUDE|G)?:\s*(.*?)\s*$/mi), 'EW'),
  };
}

/**
 * `39° 23' 10" N` / `39.3861 N` / `-101.05` -> signed decimal degrees.
 *
 * Separators are parsed loosely on purpose. The degree sign is latin-1 in some
 * of these exports, so decoding the body as UTF-8 turns it into a replacement
 * character; anything that is not a digit is treated as a separator instead of
 * being matched literally.
 */
function degrees(seg, axis) {
  if (!seg) return null;
  const hemi = new RegExp(`[${axis}]`, 'i').exec(seg)?.[0]?.toUpperCase() ?? null;
  const nums = (seg.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!nums.length || nums.length > 3) return null;
  const [d, m = 0, s = 0] = nums;
  const v = d + m / 60 + s / 3600;
  const neg = seg.trimStart().startsWith('-') || hemi === 'S' || hemi === 'W';
  return Math.round((neg ? -v : v) * 1e6) / 1e6;
}

/** The whole monthly report: which month it covers, its rows, and its header. */
export function parseDailyReport(text) {
  // A file is one report or the other, never both, and this is where that is
  // enforced. It matters because the yearly report's monthly rows match the
  // daily-row pattern below: " 26   7   3.36   0.00  0.92     30    6    6   0"
  // reads as day 26 with 0.00 in of rain. Today only the header check stands
  // between that and a stored, confident dry day per month — exactly the "null
  // is not 0" failure the rest of this codebase is built to prevent — and it
  // stands on a WeatherLink version never printing "SUMMARY for" in an annual
  // report. Verified against the farm's own files: NOAAMO.txt has no
  // PRECIPITATION (in) block, so nothing real is refused here.
  if (parseMonthlyReport(text).length) {
    return { month: null, year: null, period: null, station: parseStationHeader(text), days: [] };
  }
  // "MONTHLY CLIMATOLOGICAL SUMMARY for AUG. 2026"
  const head = text.match(/SUMMARY\s+for\s+([A-Z]{3})\w*\.?\s+(\d{4})/i);
  const month = head ? MONTHS[head[1].toUpperCase()] : null;
  const year = head ? Number(head[2]) : null;
  const days = [];

  if (month) for (const line of text.split(/\r?\n/)) {
    // DAY MEAN HIGH TIME LOW TIME HEAT COOL RAIN AVGWIND HIGH TIME DIR
    const m = line.match(/^\s{0,3}(\d{1,2})\s+(-?[\d.]+)\s+(-?[\d.]+)\s+\S+\s+(-?[\d.]+)\s+\S+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s/);
    if (!m) continue;                       // skips the blank future days and the summary row
    const day = Number(m[1]);
    if (day < 1 || day > 31) continue;
    days.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      precip_in: cleanPrecipIn(m[7]),
      mean_temp_f: Number(m[2]),
    });
  }
  return {
    month, year,
    period: month ? `${year}-${String(month).padStart(2, '0')}` : null,
    station: parseStationHeader(text),
    days,
  };
}

/** Monthly totals for the year — the calibration series. */
export function parseMonthlyReport(text) {
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

export async function fetchDailyReport(url, opts) {
  return parseDailyReport(await fetchWithRetry(url, opts));
}

/** Daily rows for the month the report currently covers. */
export async function fetchOnFarmDaily(url, opts) {
  return (await fetchDailyReport(url, opts)).days;
}

/** Monthly totals for the year — the calibration series. */
export async function fetchOnFarmMonthly(url, opts) {
  return parseMonthlyReport(await fetchWithRetry(url, opts));
}

/**
 * What a fetch actually came back with, in words somebody can act on.
 *
 * "failed after 2 tries: HTTP 403" is true and useless — it is what a folder
 * answers on the farm's own host, and it says nothing about which of the two
 * plausible mistakes was made. A page instead of a report is the other one:
 * that is a web server offering an index or an error, not a station.
 */
function describeBody(text, url) {
  if (/^\s*<(?:!doctype|html|\?xml)/i.test(text)) {
    return `${url} answered with a web page rather than a report — that is the web server talking, not the station`;
  }
  return `${url} is not a NOAA report (no "SUMMARY for <MONTH> <YEAR>" line and no PRECIPITATION block)`;
}

const describeError = (e, url) => {
  const code = /HTTP (\d{3})/.exec(String(e?.message ?? e))?.[1];
  return code ? `${url} answered HTTP ${code}` : String(e?.message ?? e);
};

/**
 * Fetch both reports and describe what came back, without storing anything.
 *
 * Pointing this at the wrong file is the setup mistake that costs the most: the
 * URLs look plausible either way, and a wrong one shows up months later as an
 * on-farm series that never started. Fewer retries than an ingest, because
 * somebody is sitting watching this one.
 *
 * `url` is a single address — the folder or either report — and the pair is
 * resolved from it by `reportPairs`, trying each candidate until one reads.
 * `yearlyUrl` still overrides, for the rare setup that keeps them apart. The
 * addresses that worked come back in `resolved` so the form can keep them,
 * which is what makes "paste the folder" a real answer rather than a guess the
 * user has to confirm by hand.
 */
export async function probeStation({ url, dailyUrl, yearlyUrl } = {}) {
  const opts = { tries: 2, timeoutMs: 20_000 };
  const total = vals => (vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null);
  const candidates = url ? reportPairs(url) : [{ dailyUrl: dailyUrl || null, yearlyUrl: null }];
  const out = { daily: null, yearly: null, resolved: { dailyUrl: null, yearlyUrl: null }, tried: [] };
  if (url && !candidates.length) {
    out.daily = { ok: false, error: `${url} is not a web address — it should start with http:// or https://` };
    return out;
  }

  for (const cand of candidates) {
    if (!cand.dailyUrl) break;
    out.tried.push(cand.dailyUrl);
    try {
      const text = await fetchWithRetry(cand.dailyUrl, opts);
      const r = parseDailyReport(text);
      out.daily = {
        ok: r.days.length > 0,
        error: r.days.length ? null
          : r.period ? 'the report has no daily rows in it yet'
          : describeBody(text, cand.dailyUrl),
        period: r.period, days: r.days.length,
        firstDate: r.days[0]?.date ?? null, lastDate: r.days.at(-1)?.date ?? null,
        total: total(r.days.map(d => d.precip_in).filter(v => v !== null)),
        station: r.station,
      };
    } catch (e) {
      out.daily = { ok: false, error: describeError(e, cand.dailyUrl) };
    }
    // Keep the last thing tried even when nothing worked, so the form shows what
    // was actually asked for rather than leaving the box as the reader typed it.
    out.resolved = { dailyUrl: cand.dailyUrl, yearlyUrl: yearlyUrl || cand.yearlyUrl || null };
    if (out.daily.ok) break;
  }

  const yearly = out.resolved.yearlyUrl;
  if (yearly) {
    try {
      const months = await fetchOnFarmMonthly(yearly, opts);
      out.yearly = {
        ok: months.length > 0,
        error: months.length ? null : `${yearly} is not a NOAA yearly summary (no PRECIPITATION block)`,
        months: months.length,
        firstMonth: months[0]?.month ?? null, lastMonth: months.at(-1)?.month ?? null,
        total: total(months.map(m => m.precip_in).filter(v => v !== null)),
      };
    } catch (e) {
      out.yearly = { ok: false, error: describeError(e, yearly) };
    }
  }
  return out;
}
