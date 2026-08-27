/**
 * The read side, shared between the dashboard and the static publisher.
 *
 * These functions were the top of src/server.js until the published mirror
 * needed the same answers with no HTTP anywhere in the picture: `npm run
 * publish` writes the same payloads the dashboard fetches, so the two views
 * cannot drift into disagreeing about what a field's rainfall was. Keeping one
 * copy of `series()` is the whole point — a second implementation for the
 * export would be a second place for an exclusion to be forgotten.
 *
 * A factory over (db, getCfg) rather than a module of plain functions, matching
 * createJobs and createUpdates: config is read through a getter because
 * server.js rebinds `cfg` whenever config.json is written, and a captured value
 * would leave every view answering from the config as it was at startup.
 */
import { today, addDays, SOURCES, historyStart, HISTORY_FLOOR_YEAR } from './util.js';
import { manualGauges, onFarmStation, farmsOf } from './setup.js';

/**
 * The gauges that count for a field, nearest first, as chartable series.
 *
 * Capped at GAUGE_SLOTS because each one needs a colour of its own and the
 * palette has that many that stay distinguishable beside the three gridded
 * hues, in both themes, at every count from one to four. Anything past that is
 * still counted in the derived `gauge` figure — it just does not get a line.
 */
export const GAUGE_SLOTS = 4;

export function createViews(db, getCfg) {
  const cfg = () => getCfg();

  const seasonStart = () => {
    const y = new Date().getFullYear();
    return cfg().season?.mode === 'water'
      ? (today() >= `${y}-10-01` ? `${y}-10-01` : `${y - 1}-10-01`)
      : `${y}-01-01`;
  };
  const growStart = () => `${new Date().getFullYear()}-${cfg().season?.growingSeasonStart ?? '04-01'}`;

  const excludedSources = fieldId =>
    new Set(cfg().fields.find(f => f.id === fieldId)?.exclude?.sources ?? []);

  function fieldGauges(fieldId) {
    const ex = excludedSources(fieldId);
    return db.prepare(`SELECT fs.network, fs.station_id, fs.dist_km, s.name
      FROM field_station fs LEFT JOIN station s ON s.id = fs.station_id AND s.network = fs.network
      WHERE fs.field_id = ? AND fs.excluded = 0 ORDER BY fs.dist_km`).all(fieldId)
      .filter(g => !ex.has(g.network === 'MANUAL' ? 'manual' : 'gauge'))
      .map(g => ({
        key: `g:${g.network}|${g.station_id}`,
        station_id: g.station_id, network: g.network,
        name: g.name ?? g.station_id, dist_km: g.dist_km,
        manual: g.network === 'MANUAL',
      }));
  }

  /** The ones that get a line and a column. The rest still count towards the
   *  derived `gauge` figure; they just have no colour left. */
  const chartGauges = fieldId => fieldGauges(fieldId).slice(0, GAUGE_SLOTS);

  /**
   * Wide rows: one per field-date, a column per source and one per gauge.
   *
   * The per-gauge columns come straight from `station_obs` — raw, not derived —
   * because the point of showing them separately is that they disagree. The
   * derived `gauge` column is still here beside them; it is the same readings
   * collapsed to nearest-that-reported, which is what a single number per field
   * has to be.
   *
   * Excluded sources are blanked here rather than filtered in SQL, so every
   * downstream view — KPI tiles, charts, table, CSV — honours the exclusion from
   * one place, and the underlying rows stay intact for when it is turned back on.
   */
  function series(fieldId, since, until = '9999-12-31') {
    const rows = db.prepare(`
      SELECT date,
        MAX(CASE WHEN source='gauge'  THEN precip_in END) gauge,
        MAX(CASE WHEN source='manual' THEN precip_in END) manual,
        MAX(CASE WHEN source='rfcqpe' THEN precip_in END) rfcqpe,
        MAX(CASE WHEN source='mrms'   THEN precip_in END) mrms,
        MAX(CASE WHEN source='prism'  THEN precip_in END) prism,
        MAX(CASE WHEN source='iemre'  THEN precip_in END) iemre,
        MAX(CASE WHEN source='gauge'  THEN detail    END) gauge_src,
        MAX(CASE WHEN source='manual' THEN detail    END) manual_src
      FROM obs WHERE field_id = ? AND date BETWEEN ? AND ?
      GROUP BY date ORDER BY date`).all(fieldId, since, until);

    const ex = excludedSources(fieldId);
    if (ex.size) for (const r of rows) {
      for (const s of ex) r[s] = null;
      if (ex.has('gauge')) r.gauge_src = null;
      if (ex.has('manual')) r.manual_src = null;
    }

    // One column per counting gauge. A station can have a reading on a date with
    // no obs row of its own — an excluded source still derives, but a field whose
    // only gauge went quiet has gridded rows and nothing else — so dates are
    // added rather than assumed to be there already.
    const gauges = chartGauges(fieldId);
    if (gauges.length) {
      const want = new Set(gauges.map(g => `${g.network}|${g.station_id}`));
      const byDate = new Map(rows.map(r => [r.date, r]));
      let added = false;
      for (const v of db.prepare(`SELECT so.network, so.station_id, so.date, so.precip_in
        FROM station_obs so
        JOIN field_station fs ON fs.network = so.network AND fs.station_id = so.station_id
        WHERE fs.field_id = ? AND fs.excluded = 0 AND so.date BETWEEN ? AND ?
          AND so.precip_in IS NOT NULL`)
        .all(fieldId, since, until)) {
        const id = `${v.network}|${v.station_id}`;
        if (!want.has(id)) continue;
        let r = byDate.get(v.date);
        if (!r) { r = { date: v.date }; byDate.set(v.date, r); rows.push(r); added = true; }
        r[`g:${id}`] = v.precip_in;
      }
      if (added) rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    return rows;
  }

  const sum = (rows, k) => {
    const vals = rows.map(r => r[k]).filter(v => v !== null && v !== undefined);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  };

  function summary(fieldId) {
    const end = today();
    const rows = series(fieldId, seasonStart());
    const gauges = chartGauges(fieldId);
    const keys = [...SOURCES, ...gauges.map(g => g.key)];
    const win = n => rows.filter(r => r.date > addDays(end, -n));
    const out = { field_id: fieldId, gauges };
    for (const [label, subset] of [['d1', win(1)], ['d7', win(7)], ['d30', win(30)],
                                   ['season', rows], ['growing', rows.filter(r => r.date >= growStart())]]) {
      out[label] = Object.fromEntries(keys.map(s => [s, sum(subset, s)]));
    }
    // Days since the last measurable rain (>= 0.01 in) on any source.
    let dry = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (keys.some(s => (rows[i][s] ?? 0) >= 0.01)) {
        dry = Math.max(0, Math.round((new Date(end) - new Date(rows[i].date)) / 86400000));
        break;
      }
    }
    out.days_since_rain = dry;
    out.last_date = rows.at(-1)?.date ?? null;
    return out;
  }

  const csvq = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  function csv(fields, from, to) {
    const names = Object.fromEntries(cfg().fields.map(f => [f.id, f.name]));
    const farms = Object.fromEntries(cfg().fields.map(f => [f.id, f.farm ?? '']));
    const lines = ['field_id,field_name,farm,date,gauge_in,manual_in,rfcqpe_4km_in,mrms_in,prism_in,iemre_in,gauge_station,manual_gauge'];
    for (const id of fields) {
      for (const r of series(id, from, to)) {
        const q = v => (v === null || v === undefined ? '' : v);
        lines.push([id, csvq(names[id]), csvq(farms[id]), r.date,
          q(r.gauge), q(r.manual), q(r.rfcqpe), q(r.mrms), q(r.prism), q(r.iemre),
          csvq(r.gauge_src), csvq(r.manual_src)].join(','));
      }
    }
    return lines.join('\n');
  }

  /** Everything the page needs before it has picked a field — the `/api/fields`
   *  payload, and the same object the published mirror redacts and writes out. */
  function meta() {
    // Ordered by distance, not rank: rank only orders within a network, and
    // manual gauges are linked separately from the fetched ones.
    const stations = db.prepare(`SELECT fs.field_id, fs.station_id, fs.network, fs.dist_km, fs.excluded, s.name
      FROM field_station fs LEFT JOIN station s ON s.id=fs.station_id AND s.network=fs.network
      ORDER BY fs.field_id, fs.dist_km`).all();
    return {
      fields: cfg().fields.map(f => ({ ...f, stations: stations.filter(s => s.field_id === f.id) })),
      sources: SOURCES,
      gauges: manualGauges(cfg()),
      station: onFarmStation(cfg()),
      farms: farmsOf(cfg().fields),
      seasonStart: seasonStart(), growingStart: growStart(),
      // How deep history is pulled, and what the earliest stored day actually
      // is — the setting and the reality, because they differ until the pull
      // has been run and that difference is the thing worth showing.
      history: {
        fromYear: cfg().ingest?.historyFromYear ?? null,
        sdate: historyStart(cfg()),
        floorYear: HISTORY_FLOOR_YEAR,
        earliest: db.prepare('SELECT MIN(date) d FROM obs').get()?.d ?? null,
      },
      lastIngest: db.prepare('SELECT MAX(ts) t FROM ingest_log').get()?.t ?? null,
      // Whether this machine keeps a read-only copy on a web host. The flag
      // only decides whether the dashboard offers a "Publish now" button; the
      // host and password stay here and never reach the browser.
      publishing: cfg().publish?.enabled === true,
    };
  }

  /** Which years the year and comparison pickers can offer for this field.
   *  Offering a year with nothing in it would draw an empty overlay and leave
   *  the reader deciding whether that means "dry" or "not collecting yet". */
  const yearsWithData = fieldId => db.prepare(`SELECT DISTINCT substr(date, 1, 4) y FROM obs
    WHERE field_id = ? ORDER BY y DESC`).all(fieldId).map(r => r.y);

  /**
   * Every field's rainfall by calendar year, for the all-fields bars when two
   * years are being compared.
   *
   * Calendar years rather than the window the charts above use, and that is a
   * deliberate limit rather than an oversight: the published copy answers
   * `/api/summary` out of one pre-built file, and an arbitrary window for
   * *every* field would mean shipping every field's daily history to the
   * browser to draw one bar apiece. A year is the unit this question gets asked
   * in anyway.
   *
   * Both figures are kept because one of the two years is usually this one, and
   * this one is not finished. `ytd` stops at today's month-day in every year, so
   * a whole 1996 is never set against eight months of 2026; `total` is the
   * honest figure when both years are over.
   *
   * The source falls back the same way the chart's own headline does — radar,
   * then the field's gauge figure, then PRISM — resolved per year, because a
   * forty-year window crosses the day radar starts existing. `src` travels with
   * the number: a year measured by PRISM beside a year measured by radar has to
   * say so.
   *
   * **`years` is not an optimisation, it is the difference between this being
   * usable and not.** Grouping every stored year cannot use an index — the
   * grouping key is computed — so it is a full scan of `obs`, which is 390,000
   * rows and 22 MB here: 270 ms against a fresh copy of the file, 1.5–2.8 s
   * through a connection sharing the running dashboard's WAL, and over 50 s as
   * it actually landed in the browser. That is far too slow to sit behind a
   * picker, and the chart it feeds draws two years, not forty-six. Naming the
   * years turns it into an indexed range scan on `obs_date_idx` over the couple
   * of thousand rows those years actually hold.
   *
   * A covering index on `(source, field_id, date, precip_in)` was tried and is
   * *slower* — three separate index searches still need the temp b-tree for the
   * GROUP BY, and it costs 13 MB. Don't add it back.
   *
   * No argument means every year, which is what `src/publish.js` wants: it
   * builds one file a day and the reader on the far end may pick any year.
   */
  function yearTotals(years = null) {
    const want = (years ?? []).map(String).filter(y => /^\d{4}$/.test(y));
    const span = want.length
      ? ` AND (${want.map(() => 'date BETWEEN ? AND ?').join(' OR ')})` : '';
    // `?` binds in the order it appears in the text, and the SELECT list comes
    // before the WHERE clause — today's month-day is the first parameter.
    const rows = db.prepare(`SELECT field_id, substr(date, 1, 4) y, source,
        SUM(precip_in) total,
        SUM(CASE WHEN substr(date, 6) <= ? THEN precip_in END) ytd
      FROM obs WHERE source IN ('mrms', 'gauge', 'prism') AND precip_in IS NOT NULL${span}
      GROUP BY field_id, y, source`)
      .all(today().slice(5), ...want.flatMap(y => [`${y}-01-01`, `${y}-12-31`]));

    const by = new Map();
    for (const r of rows) {
      const k = `${r.field_id}|${r.y}`;
      if (!by.has(k)) by.set(k, { field_id: r.field_id, y: r.y });
      by.get(k)[r.source] = r;
    }
    const round = v => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
    const ex = new Map();                     // one config lookup per field, not per year
    const out = {};
    for (const e of by.values()) {
      if (!ex.has(e.field_id)) ex.set(e.field_id, excludedSources(e.field_id));
      const src = ['mrms', 'gauge', 'prism'].find(s => !ex.get(e.field_id).has(s) && e[s]);
      if (!src) continue;
      (out[e.field_id] ??= []).push({ y: e.y, src, total: round(e[src].total), ytd: round(e[src].ytd) });
    }
    for (const list of Object.values(out)) list.sort((a, b) => (a.y < b.y ? -1 : 1));
    return out;
  }

  return {
    seasonStart, growStart, fieldGauges, chartGauges,
    series, summary, csv, meta, yearsWithData, yearTotals,
  };
}
