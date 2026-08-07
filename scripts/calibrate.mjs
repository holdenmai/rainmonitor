/**
 * Radar calibration against the on-farm gauge:  node scripts/calibrate.mjs
 *
 * Compares the Davis Vantage Pro on Home 8 against MRMS and PRISM sampled at the
 * nearest field point, month by month. Shares its logic with the dashboard's
 * /api/calibration endpoint so the two can never disagree.
 */
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/util.js';
import { calibration } from '../src/calibration.js';

const cfg = loadConfig();
const db = openDb();
const c = calibration(db, cfg);
if (!c) { console.log('No on-farm monthly data yet. Run: npm run ingest'); process.exit(1); }

console.log(`On-farm gauge: ${c.station} @ ${c.stationLat}, ${c.stationLon}`);
console.log(`Grid sampled at nearest field: ${c.sampledAt}\n`);
console.log('  month     gauge    mrms   prism   g/mrms  g/prism');
console.log('  ' + '-'.repeat(54));
const r = (a, b) => (b > 0.1 ? (a / b).toFixed(2).padStart(6) : '     —');
for (const m of c.months) {
  console.log(`  ${m.month}  ${m.gauge.toFixed(2).padStart(6)}  ${(m.mrms ?? 0).toFixed(2).padStart(6)}  `
    + `${(m.prism ?? 0).toFixed(2).padStart(6)}  ${r(m.gauge, m.mrms)}  ${r(m.gauge, m.prism)}`
    + (m.warm ? '' : '   (cold season)'));
}

const line = (label, b) => console.log(
  `  ${label.padEnd(22)} gauge ${b.gauge.toFixed(2)}"  mrms ${b.mrms.toFixed(2)}"  prism ${b.prism.toFixed(2)}"`
  + `   ->  g/mrms ${b.mrmsFactor ?? '—'}   g/prism ${b.prismFactor ?? '—'}`);
console.log('\n  ' + '-'.repeat(54));
line('Warm season (May-Sep)', c.warm);
line('Cold season (Oct-Apr)', c.cold);
line('All months', c.all);

console.log('\nRecommendation');
if (c.warm.prismFactor !== null && Math.abs(1 - c.warm.prismFactor) <= 0.06) {
  console.log(`  PRISM already tracks your gauge to within ${Math.round(Math.abs(1 - c.warm.prismFactor) * 100)}%`
            + ` (factor ${c.warm.prismFactor}) — it assimilates gauge`);
  console.log('  networks by design, so it has effectively done this correction already.');
  console.log('  Use PRISM as the primary estimate for fields with no nearby gauge; no');
  console.log('  hand-applied factor needed.');
}
if (c.warm.mrmsFactor !== null) {
  console.log(`\n  MRMS warm-season factor: ${c.warm.mrmsFactor} (multiply radar by this).`);
  if (c.cold.mrmsFactor !== null && c.cold.mrmsFactor < c.warm.mrmsFactor - 0.1) {
    console.log(`  The cold-season ratio is ${c.cold.mrmsFactor}, far below it. That gap is the gauge`);
    console.log('  missing snow, not the radar reading high — do NOT apply an annual factor.');
  }
  console.log('  Caveat: an unshielded tipping bucket under-catches wind-driven rain by');
  console.log('  roughly 5-15% on the High Plains, so part of the residual is the gauge.');
  console.log('  True bias sits between this factor and 1.00.');
}
if (c.provisional) console.log(`\n  PROVISIONAL: only ${c.warm.months} warm-season month(s) of overlap. Revisit after a full season.`);
db.close();
