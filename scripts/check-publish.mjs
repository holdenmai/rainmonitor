/**
 * Does the published copy still say what this machine says?
 *
 * `npm run check` is the regression test that matters for ingest; this is the
 * one that matters for publishing. It builds the static copy in memory, decodes
 * it exactly the way web/static.js does in the browser, and compares every
 * value against src/views.js — the same module the dashboard answers from.
 *
 * It is deliberately a *decoder*, not a call into publish.js. Re-using the
 * encoder to check the encoder would pass no matter what either of them did.
 * The loop below is a second implementation of web/static.js:rowsOf, and if the
 * two ever drift apart this is what notices.
 *
 * It also asserts the privacy settings, because "we meant to strip that" is not
 * something anyone can see by looking at a chart. Run it after touching
 * src/publish.js, src/views.js, web/static.js or the redaction settings.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { loadConfig, ROOT, SOURCES } from '../src/util.js';
import { createViews, GAUGE_SLOTS } from '../src/views.js';
import { buildArtifacts } from '../src/publish.js';

const cfg = loadConfig();
const db = new DatabaseSync(join(ROOT, 'data', 'rain.db'), { readOnly: true });
const views = createViews(db, () => cfg);

const files = buildArtifacts(db, cfg);
const jf = rel => {
  const body = files.get(rel);
  if (body === undefined) throw new Error(`the build produced no ${rel}`);
  return JSON.parse(body);
};
const meta = jf('data/meta.json');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failed++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

/** web/static.js:rowsOf, written again on purpose. UTC on both ends because
 *  this counts days between two calendar labels; see the note there. */
function rowsOf(chunk, from, to) {
  const start = Date.parse(`${chunk.from}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < chunk.days.length; i++) {
    const d = new Date(start + chunk.days[i] * 86400000).toISOString().slice(0, 10);
    if (d < from || d > to) continue;
    const row = { date: d };
    for (const k of chunk.keys) row[k] = chunk.cols[k][i];
    out.push(row);
  }
  return out;
}
function decode(fieldId, from, to) {
  const rows = meta.publish.series[fieldId].chunks
    .filter(c => c.from <= to && c.to >= from)
    .flatMap(c => rowsOf(jf(`data/series/${fieldId}/${c.file}`), from, to));
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

const published = Object.keys(meta.publish.series);
console.log(`Checking ${published.length} published field(s) against this machine's own answers.\n`);

console.log('Privacy');
const coords = cfg.publish?.coordinates === true;
check('the on-farm station is not published', meta.station === null || cfg.publish?.calibration === true);
for (const f of meta.fields) {
  check(`${f.id} keeps a name to tell it apart by`, !!f.name);
  if (!coords) {
    check(`${f.id} publishes no coordinates`, f.lat === undefined && f.lon === undefined);
    check(`${f.id} publishes no gauge distances`,
      (meta.publish.series[f.id]?.gauges ?? []).every(g => g.dist_km === null));
  }
  check(`${f.id} publishes no exclusion settings`, f.exclude === undefined && f.stations === undefined);
}
for (const [rel, body] of files) {
  if (!rel.endsWith('.json')) continue;
  check(`${rel} carries no gauge detail strings`, !body.includes('_src'));
  if (!coords) check(`${rel} carries no distance text`, !/\d\s?mi"/.test(body));
}

console.log('Values');
const RANGES = (() => {
  const to = meta.publish.series[published[0]].chunks.at(-1).to;
  const y = Number(to.slice(0, 4));
  return [
    [`${y}-01-01`, to],                       // this year, current.json alone
    [`${y - 1}-12-20`, `${y}-01-10`],         // across the history/current seam
    [`${y - 1}-01-01`, `${y - 1}-12-31`],     // last year, history.json alone
    [meta.history.sdate, to],                 // everything there is
  ];
})();
for (const id of published) {
  const keys = [...SOURCES, ...views.fieldGauges(id).slice(0, GAUGE_SLOTS).map(g => g.key)];
  for (const [from, to] of RANGES) {
    const mine = decode(id, from, to);
    const truth = views.series(id, from, to);
    check(`${id} ${from}..${to} has every day`, mine.length === truth.length,
      `${mine.length} published vs ${truth.length} stored`);
    let wrong = 0, first = '';
    for (let i = 0; i < Math.min(mine.length, truth.length); i++) {
      if (mine[i].date !== truth[i].date) {
        wrong++; first ||= `row ${i}: ${mine[i].date} vs ${truth[i].date}`; continue;
      }
      for (const k of keys) {
        // Exact, not rounded. Publishing at display precision changes numbers:
        // 0.185 in becomes 0.19 through Math.round and 0.18 through toFixed.
        const a = mine[i][k] ?? null, b = truth[i][k] ?? null;
        if (a !== b) { wrong++; first ||= `${truth[i].date} ${k}: ${a} vs ${b}`; }
      }
    }
    check(`${id} ${from}..${to} matches value for value`, wrong === 0, `${wrong} cells, first ${first}`);
  }
}

console.log('Page');
const html = files.get('index.html');
check('index.html loads the static shim before app.js',
  html.indexOf('static.js') > 0 && html.indexOf('static.js') < html.indexOf('src="app.js"'));
check('index.html has no admin markup left',
  !['addField', 'addGauge', 'jobCard', 'stationForm', 'restoreForm', 'updateBanner', 'csvBtn']
    .some(id => html.includes(id)));
check('index.html asks for nothing from the site root', !/(src|href)="\//.test(html));
for (const rel of ['app.js', 'static.js', 'style.css', 'data/summary.json']) {
  check(`${rel} is in the build`, files.has(rel));
}

const kb = n => `${Math.round(n / 1024)} KB`;
const size = rels => rels.reduce((n, r) => n + Buffer.byteLength(files.get(r)), 0);
const all = [...files.keys()];
// What a second run has to send: this year's rows, the tiles, and the index.
// Everything else — the frozen history, and app.js/style.css — is byte for byte
// what it was yesterday, which is the whole reason the split is where it is.
const daily = all.filter(r => r.endsWith('current.json') || r === 'data/meta.json' || r === 'data/summary.json');
console.log(`\n${files.size} files, ${kb(size(all))} in all.`);
console.log(`Of that, ${kb(size(daily))} in ${daily.length} files is what changes day to day; `
  + `${kb(size(all.filter(r => r.endsWith('history.json'))))} of frozen history only moves when the past does.`);
console.log(failed ? `\n${failed} check(s) failed.` : '\nEverything the published copy says, this machine says too.');
process.exitCode = failed ? 1 : 0;
db.close();
