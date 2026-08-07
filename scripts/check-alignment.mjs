/**
 * Date-alignment diagnostic:  node scripts/check-alignment.mjs [field_id]
 *
 * Cross-correlates every source against MRMS at lags -2..+2. Each source should
 * peak at lag 0. A peak anywhere else means that feed changed its date
 * convention upstream and the ingest is now recording storms on the wrong day —
 * a failure that is invisible in totals and in every individual API response.
 *
 * This is how the Kansas Mesonet end-of-window timestamp was found (it peaked
 * at lag -1, r=0.985). Re-run it after any upstream change.
 *
 * Expected, as measured 2026-08-07 over 219 days:
 *   gauge  peak lag 0 (r~0.99)   iemre peak lag 0 (r~0.98)
 *   prism  flat across lag -1/0 (r~0.57 both) - inherent 12Z-12Z window, not a bug
 */
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/util.js';

const fieldId = process.argv[2] || loadConfig().fields[0].id;
const db = openDb();
const since = `${new Date().getFullYear()}-01-01`;

const corr = (a, b) => {
  const n = a.length;
  if (n < 30) return NaN;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; dbb += y * y; }
  return num / Math.sqrt(da * dbb);
};
const shift = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const get = src => Object.fromEntries(db.prepare(
  'SELECT date, precip_in v FROM obs WHERE field_id=? AND source=? AND date>=?').all(fieldId, src, since).map(r => [r.date, r.v ?? 0]));

const mrms = get('mrms');
const dates = Object.keys(mrms).sort();
if (!dates.length) { console.log(`No MRMS data for field "${fieldId}". Run: npm run backfill 365`); process.exit(1); }

console.log(`Alignment vs MRMS - field "${fieldId}", ${dates.length} days since ${since}\n`);
let bad = 0;
for (const src of ['gauge', 'prism', 'iemre']) {
  const s = get(src);
  const scores = [-2, -1, 0, 1, 2].map(lag => {
    const A = [], B = [];
    for (const d of dates) { const a = s[d], b = mrms[shift(d, lag)]; if (a == null || b == null) continue; A.push(a); B.push(b); }
    return { lag, r: corr(A, B) };
  });
  const best = scores.reduce((x, y) => (y.r > x.r ? y : x));
  const zero = scores.find(x => x.lag === 0).r;

  // A genuine date-convention bug looks like a SHARP peak off zero: the shifted
  // correlation is strong on its own and leaves lag 0 far behind (Kansas Mesonet
  // scored 0.985 at lag -1 against 0.081 at lag 0).
  //
  // A 12Z-12Z or 7am-7am product instead splits its mass across two local days,
  // so no lag scores especially high and the winner varies by location - PRISM
  // peaks at lag 0 at one field and lag -1 at another. That is the observing
  // window, not a bug, and shifting it would just move the error somewhere else.
  const misaligned = best.lag !== 0 && best.r >= 0.80 && best.r - zero >= 0.15;
  const smeared = best.lag !== 0 && !misaligned;
  if (misaligned) bad++;
  console.log(`  ${src.padEnd(6)} ${scores.map(x => `${x.lag >= 0 ? '+' : ''}${x.lag}:${x.r.toFixed(3)}`).join('  ')}`
            + `   -> peak lag ${best.lag} `
            + (misaligned ? '[MISALIGNED]' : smeared ? '[smeared across 2 days - expected]' : '[ok]'));
}
console.log(bad ? `\n${bad} source(s) misaligned - a feed changed its date convention. Check that source's date handling.`
                : '\nNo source shows a date-convention shift.');
db.close();
