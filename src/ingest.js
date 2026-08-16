import { today, addDays, daysBetween } from './util.js';
import { fetchIemre, yearChunks } from './sources/iemre.js';
import { fetchStationYear } from './sources/iemgauge.js';
import { fetchKsStationRange } from './sources/ksmesonet.js';
import { fetchOnFarmDaily, fetchOnFarmMonthly } from './sources/weatherlink.js';
import { identifyPoint, LAYERS } from './sources/rfcqpe.js';
import { upsertObs, upsertStationObs, upsertStationMonthly, upsertFieldWindow, logIngest, syncFields, transact } from './db.js';
import { deriveAll } from './derive.js';

const years = (s, e) => {
  const out = [];
  for (let y = +s.slice(0, 4); y <= +e.slice(0, 4); y++) out.push(y);
  return out;
};

/**
 * `onlyFields` narrows the pull to a few field ids — used when one field is
 * added and needs its history, so a new quarter section costs one field's worth
 * of requests instead of re-pulling a year for the whole farm. The field table
 * is still synced against the whole config, or scoping a run would prune every
 * field it was not looking at.
 */
export async function ingest(db, cfg, { sdate, edate = today(), log = console.log, onlyFields = null } = {}) {
  if (!sdate) sdate = addDays(edate, -(cfg.ingest?.revisitDays ?? 10));
  const removed = syncFields(db, cfg.fields);
  for (const r of removed) log(`  [prune] removed field "${r.name}" — no longer in config.json`);

  const only = onlyFields?.length ? new Set(onlyFields) : null;
  const fields = only ? cfg.fields.filter(f => only.has(f.id)) : cfg.fields;
  if (!fields.length) return log('Nothing to ingest — no matching fields.');
  log(`Ingesting ${sdate} -> ${edate} (${daysBetween(sdate, edate) + 1} days) for ${fields.length} field(s)`);

  // --- Gridded: one request per field ---
  if (cfg.sources.iemre?.enabled) {
    // A year at a time, storing as it goes.
    //
    // `fetchIemre` splits at year boundaries internally and hands back one
    // array, which is right for a ten-day revisit and wrong for a forty-year
    // backfill: one timeout in 1997 would throw away 1981-1996 as well, having
    // already spent two minutes fetching them. Driving the chunks from here
    // means each year is written before the next is asked for, so a failure
    // costs one year and re-running picks up where it stopped.
    //
    // PRISM reaches back to 1981 and IEMRE further still, so this loop is the
    // difference between one season of history and four decades of it.
    for (const f of fields) {
      const chunks = yearChunks(sdate, edate);
      let got = 0, want = 0, failed = 0, firstError = null;
      for (const [s, e] of chunks) {
        const wantChunk = daysBetween(s, e) + 1;
        want += wantChunk;
        try {
          const rows = await fetchIemre(f.lat, f.lon, s, e);
          transact(db, () => {
            for (const r of rows) {
              // Missing stays missing: MRMS does not exist before ~2014 and
              // PRISM not before 1981, and a `0` there would be a confident
              // claim that a decade was bone dry.
              if (r.mrms !== null) upsertObs(db, f.id, r.date, 'mrms', r.mrms);
              if (r.prism !== null) upsertObs(db, f.id, r.date, 'prism', r.prism);
              if (r.iemre !== null) upsertObs(db, f.id, r.date, 'iemre', r.iemre);
            }
          });
          got += rows.length;
          // Guard against silent upstream truncation: these feeds have returned
          // HTTP 200 with a near-empty body rather than an error. A short result
          // is reported loudly instead of quietly becoming a dry year.
          if (rows.length < wantChunk * 0.9) {
            failed++;
            firstError ??= `${s.slice(0, 4)}: got ${rows.length}/${wantChunk} days`;
            log(`  [grid] ${f.name} ${s.slice(0, 4)}: ${rows.length}/${wantChunk} days  <-- WARNING: upstream returned short`);
          } else if (chunks.length > 1) {
            log(`  [grid] ${f.name} ${s.slice(0, 4)}: ${rows.length} days`);
          }
        } catch (err) {
          failed++;
          firstError ??= `${s.slice(0, 4)}: ${err.message}`;
          log(`  [grid] ${f.name} ${s.slice(0, 4)}: FAILED ${err.message}`);
        }
      }
      const note = failed ? `${failed}/${chunks.length} year(s) incomplete — ${firstError}` : null;
      logIngest(db, `iemre:${f.id}`, !failed, got, note);
      log(`  [grid] ${f.name}: ${got}/${want} days across ${chunks.length} year(s)`
          + (failed ? `  <-- ${failed} incomplete, re-run to fill the gaps` : ''));
    }
  }

  // --- RFC QPE (~4km): snapshot-only, so this samples "now" and cannot backfill ---
  const rq = cfg.sources.rfcqpe;
  if (rq?.enabled) {
    // The daily product is a 24h total ending 12Z, which covers roughly 7am
    // local the previous day to 7am local today — so by default it is filed
    // against yesterday. That attribution is an informed guess until there are
    // enough days to measure it: run `npm run check` after ~30 days and adjust
    // dayOffset here if the peak correlation lands off lag 0.
    const stamp = addDays(edate, rq.dayOffset ?? -1);
    let got = 0, missed = 0;
    for (const f of fields) {
      try {
        const v = await identifyPoint(f.lon, f.lat, LAYERS.day1);
        if (v !== null) { upsertObs(db, f.id, stamp, 'rfcqpe', v, `RFC QPE 4km, 24h ending 12Z`); got++; }
        else missed++;
        for (const [win, layer] of [['last7', LAYERS.last7], ['last30', LAYERS.last30], ['ytd', LAYERS.ytd]]) {
          const w = await identifyPoint(f.lon, f.lat, layer);
          if (w !== null) upsertFieldWindow(db, f.id, 'rfcqpe', win, edate, w);
        }
      } catch (e) {
        missed++;
        logIngest(db, `rfcqpe:${f.id}`, false, 0, e.message);
      }
    }
    logIngest(db, 'rfcqpe', missed === 0, got, missed ? `${missed} field(s) returned no value` : null);
    log(`  [rfcqpe] ${got}/${fields.length} fields for ${stamp}` + (missed ? `, ${missed} missing` : ''));
  }

  // --- Gauges: fetch each station once, then map to every field that uses it ---
  // Excluded stations are still fetched. They are only a handful of requests,
  // and it means turning one back on for a field restores its whole history
  // instead of leaving a hole from the day it was switched off.
  const of = cfg.sources.weatherlink;
  const links = db.prepare(`SELECT field_id, network, station_id, dist_km FROM field_station
    WHERE network <> 'MANUAL' ORDER BY field_id, rank`).all()
    .filter(l => !only || only.has(l.field_id));
  const wanted = new Map();
  for (const l of links) wanted.set(`${l.network}|${l.station_id}`, l);
  // A station switched off in the dashboard can still have links until the next
  // remap. Fetching one would dereference a config section that is no longer
  // there, so the link is ignored rather than the whole gauge pass failing.
  if (!of?.enabled || !of.dailyUrl)
    for (const k of [...wanted.keys()]) if (k.startsWith('ONFARM|')) wanted.delete(k);

  // On-farm monthly totals — the calibration series, and the only on-farm
  // history that survives a month roll.
  if (of?.enabled && of.yearlyUrl) {
    try {
      const months = await fetchOnFarmMonthly(of.yearlyUrl);
      for (const m of months) if (m.precip_in !== null)
        upsertStationMonthly(db, 'ONFARM', of.stationId, m.month, m.precip_in, m.max_day_in);
      logIngest(db, 'onfarm:monthly', true, months.length, null);
      log(`  [onfarm] ${months.length} months of totals`);
    } catch (e) {
      logIngest(db, 'onfarm:monthly', false, 0, e.message);
      log(`  [onfarm] monthly FAILED ${e.message}`);
    }
  }

  let pulled = 0;
  for (const [key, l] of wanted) {
    try {
      let rows;
      if (l.network === 'ONFARM') {
        // Current month only; the report has no archive. Anything older that we
        // already captured stays in the table untouched.
        rows = (await fetchOnFarmDaily(of.dailyUrl)).filter(r => r.date >= sdate && r.date <= edate);
      } else if (l.network === 'KS_MESONET') {
        rows = await fetchKsStationRange(l.station_id, sdate, edate);
      } else {
        rows = [];
        for (const y of years(sdate, edate)) rows.push(...await fetchStationYear(l.network, l.station_id, y));
        rows = rows.filter(r => r.date >= sdate && r.date <= edate);
      }
      for (const r of rows) if (r.precip_in !== null) upsertStationObs(db, l.network, l.station_id, r.date, r.precip_in);
      pulled++;
      logIngest(db, `gauge:${key}`, true, rows.length, null);
    } catch (e) {
      logIngest(db, `gauge:${key}`, false, 0, e.message);
      log(`  [gauge] ${key}: FAILED ${e.message}`);
    }
  }
  log(`  [gauge] pulled ${pulled}/${wanted.size} stations`);

  // Derive each field's gauge value from everything stored, not just from what
  // this run fetched — so a station that went quiet keeps the history it already
  // reported, and an excluded gauge drops out of the past as well as the future.
  const counts = deriveAll(db, fields);
  log(`  [derive] ${counts.gauge} gauge days, ${counts.manual} manual days`);

  log('Done.');
}
