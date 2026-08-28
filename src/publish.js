/**
 * Build a read-only static copy of the dashboard.
 *
 * The target is a web host that can serve files and nothing else — no Node, no
 * PHP, no database. That is a lower bar than it sounds, because web/app.js
 * already draws every chart in the browser from four JSON payloads. So there is
 * no renderer here and no template engine: this writes those same payloads to
 * disk, cuts the admin half out of the page, and lets the identical app.js draw
 * the identical charts against files instead of an API.
 *
 * What it is *not*: a second implementation of the numbers. Every value comes
 * from src/views.js, the same module the dashboard answers from, so a published
 * page and the machine it came from cannot disagree about what a field's
 * rainfall was. A separate query here would be a second place to forget an
 * exclusion.
 *
 * Privacy is a first-class setting rather than an afterthought, because these
 * files sit somewhere anyone can fetch them. See `redactField`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, today, historyStart, SOURCES } from './util.js';
import { createViews, GAUGE_SLOTS } from './views.js';
import { calibration } from './calibration.js';
import { getMeta, setMeta } from './db.js';
import { createFtp } from './ftp.js';

const WEB = join(ROOT, 'web');
const read = name => readFileSync(join(WEB, name), 'utf8');

/** Bumped only if the layout of the published tree changes in a way an older
 *  static.js could not read. It travels in meta.json so a stale index.html
 *  cached in somebody's browser can say so rather than draw nonsense. */
export const PUBLISH_FORMAT = 'rainmonitor-publish/1';

/**
 * Cut the admin half out of index.html and point it at the shim.
 *
 * Split on the `<!-- publish:admin start/end -->` markers rather than matched
 * against the markup: a regex over HTML would go wrong the first time a card
 * gained a nested `</section>`, and moving a card from one half to the other
 * should be an edit to index.html and nothing else.
 *
 * The controls are removed, not disabled. A form that posts into the void is a
 * worse answer than a page that never offered it.
 */
export function buildIndexHtml(html = read('index.html')) {
  const START = '<!-- publish:admin start';
  const END = '<!-- publish:admin end -->';
  let out = '', rest = html;
  for (;;) {
    const i = rest.indexOf(START);
    if (i < 0) break;
    const j = rest.indexOf(END, i);
    if (j < 0) throw new Error('index.html has a publish:admin start with no matching end');
    out += rest.slice(0, i);
    rest = rest.slice(j + END.length);
  }
  out += rest;
  if (out.includes(START)) throw new Error('index.html still has an unstripped admin marker');

  // static.js must run before app.js, and both are modules: module scripts
  // execute in document order, so placing it above is the whole mechanism.
  const tag = '<!-- publish:static -->';
  if (!out.includes(tag)) throw new Error('index.html is missing the publish:static marker');
  out = out.replace(tag, '<script type="module" src="static.js"></script>\n');

  // The CSV button is the one control left in the viewing half, and it is a
  // link to an endpoint that will not exist.
  out = out.replace(/\s*<a id="csvBtn"[^>]*>.*?<\/a>/s, '');
  return out;
}

/**
 * What a field looks like to a stranger.
 *
 * With coordinates off, latitude, longitude and every gauge distance are left
 * out. Names and acreage stay: the page is useless without a way to tell one
 * field from another, and the reader it exists for already knows the names.
 *
 * `stations` and `exclude` go regardless of the setting — they only feed the
 * exclusion editor, which is not on the published page at all, and `stations`
 * carries a distance to every gauge whether or not the field's own coordinates
 * were withheld.
 */
function redactField(f, coords) {
  const { stations, exclude, lat, lon, ...rest } = f;
  return coords ? { ...rest, lat, lon } : rest;
}

/**
 * One field's rows as parallel arrays.
 *
 * Measured on the farm's own database, forty-five years of one field is 2.1 MB
 * as the API shapes it and about 620 KB like this. Two things account for the
 * difference: the key names are not repeated 16,664 times, and
 * `gauge_src`/`manual_src` — which no chart, tile or table in web/app.js ever
 * reads — are dropped. That second one is also the only place a gauge's
 * distance would have leaked into a published file as free text.
 *
 * Values are written at the precision they are stored, and deliberately not
 * rounded to the two decimals the page prints. Rounding here looked free and
 * was not: `cleanPrecipIn` stores three decimals, and MRMS reported 0.185 in
 * on 2026-08-11, which `Math.round(v * 100) / 100` turns into 0.19 while the
 * page's own `toFixed(2)` prints 0.18. It also shifted every cumulative and
 * season total, because those are summed from the raw values and rounded once
 * at the end. Two decimals would have saved 3% of the file and made the
 * published page quietly disagree with the machine it came from.
 *
 * Dates become day offsets from `from` rather than being assumed contiguous:
 * they are, for a field backfilled in one go, and they are not for a field
 * added last spring.
 */
function chunk(rows, from, to, gaugeKeys) {
  const keys = [...SOURCES, ...gaugeKeys];
  const cols = Object.fromEntries(keys.map(k => [k, []]));
  const days = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  for (const r of rows) {
    days.push(Math.round((Date.parse(`${r.date}T00:00:00Z`) - start) / 86400000));
    // `?? null` rather than the raw value: a row synthesised from station_obs
    // has no key for a gridded source at all, and an absent key would come back
    // as `undefined` in the array and serialise as JSON `null` anyway — say so
    // here instead of relying on that.
    for (const k of keys) cols[k].push(r[k] ?? null);
  }
  return { from, to, keys, days, cols };
}

/**
 * Split the history at the turn of the year.
 *
 * Not an aesthetic choice — it is what keeps the daily upload small. Everything
 * before January 1st is 590 KB that changes only when a backfill or a new
 * exclusion rewrites the past, and the content hash notices when it does;
 * this year to date is 15 KB and is rewritten every day. Splitting by era
 * rather than by resolution keeps every row at true daily detail, so the charts
 * on the remote are the same charts, not a summary of them.
 */
function chunksFor(views, fieldId, from, to, gaugeKeys) {
  const cut = `${to.slice(0, 4)}-01-01`;
  const spans = from < cut
    ? [['history.json', from, `${Number(to.slice(0, 4)) - 1}-12-31`], ['current.json', cut, to]]
    : [['current.json', from, to]];
  const out = [];
  for (const [file, a, b] of spans) {
    const rows = views.series(fieldId, a, b);
    if (!rows.length) continue;
    out.push({ file, from: a, to: b, body: chunk(rows, a, b, gaugeKeys) });
  }
  return out;
}

/**
 * Every file the published copy is made of, as relative path -> string.
 *
 * Returned rather than written so the caller decides where it goes: `--out` for
 * a folder you can check by eye, or straight into the uploader with nothing
 * touching the disk in between.
 */
export function buildArtifacts(db, cfg) {
  const views = createViews(db, () => cfg);
  const pub = cfg.publish ?? {};
  const coords = pub.coordinates === true;
  const wanted = Array.isArray(pub.fields) && pub.fields.length
    ? cfg.fields.filter(f => pub.fields.includes(f.id))
    : cfg.fields;
  if (!wanted.length) throw new Error('publish.fields names no field that exists in this config');

  const from = historyStart(cfg);
  const to = today();
  const files = new Map();
  const series = {};

  for (const f of wanted) {
    const all = views.fieldGauges(f.id);
    const charted = all.slice(0, GAUGE_SLOTS);
    const parts = chunksFor(views, f.id, from, to, charted.map(g => g.key));
    for (const p of parts) {
      files.set(`data/series/${f.id}/${p.file}`, JSON.stringify(p.body));
    }
    series[f.id] = {
      // dist_km is what the legend prints as "4.2 mi". Withheld with the
      // coordinates, because a named field plus a named gauge plus a distance
      // is a location whether or not a latitude was published.
      gauges: charted.map(g => (coords ? g : { ...g, dist_km: null })),
      uncharted: all.slice(GAUGE_SLOTS).map(g => g.name),
      years: views.yearsWithData(f.id),
      chunks: parts.map(p => ({ file: p.file, from: p.from, to: p.to })),
    };
  }

  const m = views.meta();
  files.set('data/meta.json', JSON.stringify({
    ...m,
    fields: wanted.map(f => redactField(m.fields.find(x => x.id === f.id), coords)),
    farms: [...new Set(wanted.map(f => f.farm).filter(Boolean))],
    // The on-farm station names a place and gives its coordinates. It only
    // feeds the station editor and the calibration card, neither of which is
    // published unless asked for.
    station: null,
    publish: {
      format: PUBLISH_FORMAT,
      generatedAt: `${to} ${new Date().toTimeString().slice(0, 8)}`,
      calibration: pub.calibration === true,
      series,
    },
  }));

  // Year totals for every published field, in the same file the tiles come from.
  // A few hundred numbers per field for forty-five years — small enough that the
  // remote can draw a year-against-year comparison of the whole farm without
  // fetching anybody's daily history.
  const totals = views.yearTotals();
  files.set('data/summary.json', JSON.stringify({
    summaries: wanted.map(f => {
      const s = views.summary(f.id);
      return coords ? s : { ...s, gauges: s.gauges.map(g => ({ ...g, dist_km: null })) };
    }),
    yearTotals: Object.fromEntries(wanted.filter(f => totals[f.id]).map(f => [f.id, totals[f.id]])),
  }));

  if (pub.calibration === true) {
    files.set('data/calibration.json', JSON.stringify(calibration(db, cfg) ?? {}));
  }

  files.set('index.html', buildIndexHtml());
  files.set('app.js', read('app.js'));
  files.set('static.js', read('static.js'));
  files.set('style.css', read('style.css'));
  return files;
}

/* ---------- sending it ---------- */

const MANIFEST = 'publishManifest';
const hashOf = body => createHash('sha256').update(body).digest('hex').slice(0, 16);

/**
 * What is already on the far end, as far as we know.
 *
 * Kept here rather than fetched from the remote because FTP has no usable
 * checksum: a listing gives a size and a timestamp in the server's own
 * timezone, and two JSON files of the same length are not the same file.
 *
 * The target directory is part of the record. Point `publish.ftp.dir` somewhere
 * new and every file is unknown again, which is right — the old directory's
 * contents say nothing about what is in the new one.
 */
function readManifest(db, dir) {
  try {
    const m = JSON.parse(getMeta(db, MANIFEST) ?? '{}');
    return m.dir === dir && m.files ? m.files : {};
  } catch {
    return {};                              // unreadable is the same as unknown
  }
}

/**
 * Send the built copy, skipping what is already there.
 *
 * The manifest is written after **each** file lands, not once at the end. An
 * upload over a farm connection gets cut off partway more often than not, and a
 * manifest saved only on success would either claim nothing arrived — re-sending
 * 4.7 MB of unchanged history — or claim everything did. Recording each file as
 * it is confirmed means the next run picks up exactly where this one stopped.
 */
export async function uploadArtifacts(db, cfg, files, { log = () => {}, full = false } = {}) {
  const ftp = cfg.publish?.ftp ?? {};
  const dir = ftp.dir ?? '.';
  const known = full ? {} : readManifest(db, dir);
  const wanted = Object.fromEntries([...files].map(([rel, body]) => [rel, hashOf(body)]));

  const send = [...files.keys()].filter(rel => known[rel] !== wanted[rel]);
  const skipped = files.size - send.length;
  const bytes = send.reduce((n, rel) => n + Buffer.byteLength(files.get(rel)), 0);
  if (!send.length) {
    log(`Nothing to send — all ${files.size} files on ${ftp.host} are already current.`);
    return { sent: 0, skipped, bytes: 0 };
  }
  log(`Sending ${send.length} of ${files.size} files (${Math.round(bytes / 1024)} KB) to ${ftp.host}${dir}`
    + (skipped ? `; ${skipped} unchanged.` : '.'));

  const client = createFtp(ftp);
  const done = { ...known };
  let sent = 0;
  await client.connect();
  try {
    const s = client.status();
    log(`  connected: ${s.secure ? `FTPS ${s.protocol ?? ''}`.trim() : 'plain FTP, password sent in the clear'}`
      + `, ${s.passive}${s.secure ? `, session ${s.sessionReady ? 'ready' : 'MISSING'}` : ''}`);
    for (const rel of send) {
      await client.upload(rel, files.get(rel));
      done[rel] = wanted[rel];
      sent++;
      // Written per file on purpose — see above. Cheap: one row in app_meta.
      setMeta(db, MANIFEST, JSON.stringify({ dir, files: done, at: new Date().toISOString() }));
      log(`  sent ${rel}`);
    }
  } finally {
    await client.close();
  }
  // Files that are no longer built stay on the remote rather than being deleted:
  // a field removed from publish.fields leaves its old JSON behind, which nothing
  // links to. Deleting on a guess is how a publish run wipes somebody's site.
  const stale = Object.keys(done).filter(rel => !files.has(rel));
  if (stale.length) log(`  ${stale.length} file(s) on the remote are no longer built; left in place.`);
  return { sent, skipped, bytes };
}
