import { upsertObs } from './db.js';

/**
 * A field's daily gauge figure is derived, not fetched: it is whichever linked
 * station actually reported that day, nearest first.
 *
 * Deriving it from `station_obs` rather than from the rows a run happened to
 * fetch is what makes the number correctable. Excluding a gauge, moving a field
 * or entering a manual reading all change the answer for days that were already
 * pulled, and none of them can refetch history — RFC QPE aside, most of these
 * feeds are slow, and the on-farm station has no archive at all.
 */
const KINDS = {
  gauge:  { source: 'gauge',  where: "fs.network <> 'MANUAL'" },
  manual: { source: 'manual', where: "fs.network = 'MANUAL'" },
};

export function deriveField(db, fieldId, kind = 'gauge') {
  const { source, where } = KINDS[kind];
  const rows = db.prepare(`
    SELECT so.date, so.precip_in, fs.network, fs.station_id, fs.dist_km
    FROM field_station fs
    JOIN station_obs so ON so.network = fs.network AND so.station_id = fs.station_id
    WHERE fs.field_id = ? AND fs.excluded = 0 AND ${where} AND so.precip_in IS NOT NULL
    ORDER BY so.date, fs.dist_km`).all(fieldId);

  // Full rebuild, not an upsert pass: an exclusion has to be able to *remove* a
  // day's value. Upserting alone would leave the excluded gauge's old readings
  // sitting in the chart forever, still attributed to a gauge that no longer
  // counts.
  db.prepare('DELETE FROM obs WHERE field_id = ? AND source = ?').run(fieldId, source);

  let last = null, n = 0;
  for (const r of rows) {
    if (r.date === last) continue;   // ordered by distance, so the first row for a date is the nearest
    last = r.date;
    upsertObs(db, fieldId, r.date, source, r.precip_in,
      `${r.station_id} (${r.network}) ${r.dist_km.toFixed(1)} km`);
    n++;
  }
  return n;
}

export function deriveAll(db, fields, kinds = ['gauge', 'manual']) {
  const out = {};
  for (const f of fields) for (const k of kinds) out[k] = (out[k] ?? 0) + deriveField(db, f.id, k);
  return out;
}
