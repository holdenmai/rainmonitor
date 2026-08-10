import { upsertObs, upsertStation, upsertStationObs, upsertFieldWindow } from './db.js';
import { SOURCES, isIsoDate, cleanPrecipIn } from './util.js';
import { adoptManualGauge, manualGauges } from './setup.js';
import { deriveAll } from './derive.js';

export const FORMAT = 'rainmonitor-export/1';

/**
 * Move a date range between two Rain Monitor instances.
 *
 * The reason this exists is RFC QPE: it publishes rolling windows and no
 * archive, so a day missed while a machine was off is gone for good on that
 * machine — but not on the one that was awake. Run a copy on more than one
 * computer and the gaps do not overlap.
 *
 * What travels is the *raw* record, never the derived one. A field's `gauge`
 * and `manual` figures are recomputed from station readings on arrival, because
 * the receiving instance may rank stations differently or exclude one of them,
 * and its own answer to "which gauge counts here" has to win.
 */
const GRIDDED = SOURCES.filter(s => s !== 'gauge' && s !== 'manual');

export function buildExport(db, cfg, { from, to, sources, fields } = {}) {
  const want = new Set(sources?.length ? sources : SOURCES);
  const ids = fields?.length ? fields.filter(id => cfg.fields.some(f => f.id === id)) : cfg.fields.map(f => f.id);
  const grid = GRIDDED.filter(s => want.has(s));
  const qs = (n, arr) => arr.map(() => '?').join(',') || "''";

  const obs = grid.length && ids.length ? db.prepare(`
    SELECT field_id, date, source, precip_in, detail, updated_at FROM obs
    WHERE date >= ? AND date <= ? AND field_id IN (${qs('f', ids)}) AND source IN (${qs('s', grid)})
    ORDER BY date, field_id, source`).all(from, to, ...ids, ...grid) : [];

  const windows = grid.length && ids.length ? db.prepare(`
    SELECT field_id, source, window, asof, precip_in, updated_at FROM field_window
    WHERE asof >= ? AND asof <= ? AND field_id IN (${qs('f', ids)}) AND source IN (${qs('s', grid)})
    ORDER BY asof`).all(from, to, ...ids, ...grid) : [];

  // Station readings, not the per-field gauge numbers derived from them. Scoped
  // to stations actually linked to the exported fields, so a sync of two fields
  // does not drag along every gauge in the state.
  const nets = [];
  if (want.has('gauge')) nets.push('automatic');
  if (want.has('manual')) nets.push('manual');
  const netFilter = nets.length === 2 ? '' :
    nets[0] === 'manual' ? "AND fs.network = 'MANUAL'" : "AND fs.network <> 'MANUAL'";
  const stationObs = nets.length && ids.length ? db.prepare(`
    SELECT DISTINCT so.network, so.station_id, so.date, so.precip_in, so.updated_at
    FROM station_obs so
    JOIN field_station fs ON fs.network = so.network AND fs.station_id = so.station_id
    WHERE so.date >= ? AND so.date <= ? AND fs.field_id IN (${qs('f', ids)}) ${netFilter}
    ORDER BY so.date, so.network, so.station_id`).all(from, to, ...ids) : [];

  const seen = new Set(stationObs.map(r => `${r.network}|${r.station_id}`));
  const stations = db.prepare('SELECT id, network, name, lat, lon, elev_m FROM station').all()
    .filter(s => seen.has(`${s.network}|${s.id}`));

  return {
    format: FORMAT,
    generatedAt: new Date().toISOString(),
    from, to,
    sources: [...want].filter(s => SOURCES.includes(s)),
    fields: cfg.fields.filter(f => ids.includes(f.id))
      .map(({ id, name, farm, lat, lon, acres }) => ({ id, name, farm, lat, lon, acres })),
    manualGauges: want.has('manual') ? manualGauges(cfg) : [],
    obs, windows, stations, stationObs,
  };
}

const isRow = r => r && typeof r === 'object';
const newer = (incoming, existing) => !existing || String(incoming ?? '') > String(existing);

/**
 * Merge a bundle in. Never destructive: a row is written only when it is
 * missing here, or when its `updated_at` is newer than ours. Two instances that
 * both revised the same day keep the later revision, and a stale export
 * re-imported a second time changes nothing.
 */
export function applyImport(db, cfg, bundle, { createMissingFields = false, importGauges = true } = {}) {
  if (!isRow(bundle) || bundle.format !== FORMAT)
    throw new Error(`not a Rain Monitor export (expected format "${FORMAT}")`);

  const known = new Set(cfg.fields.map(f => f.id));
  const unknown = new Set();
  const added = [];
  const stat = { obs: 0, obsUpdated: 0, readings: 0, readingsUpdated: 0, windows: 0, skipped: 0, gauges: 0 };

  if (createMissingFields) {
    for (const f of bundle.fields ?? []) {
      if (known.has(f.id)) continue;
      if (!f.id || !f.name || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      const next = { id: f.id, name: f.name, lat: f.lat, lon: f.lon };
      if (f.acres) next.acres = f.acres;
      if (f.farm) next.farm = f.farm;
      cfg.fields.push(next);
      known.add(f.id);
      added.push(next);
    }
  }

  if (importGauges) for (const g of bundle.manualGauges ?? []) if (adoptManualGauge(cfg, g)) stat.gauges++;

  const obsAt = db.prepare('SELECT updated_at FROM obs WHERE field_id=? AND date=? AND source=?');
  const stAt = db.prepare('SELECT updated_at FROM station_obs WHERE network=? AND station_id=? AND date=?');
  const winAt = db.prepare('SELECT updated_at FROM field_window WHERE field_id=? AND source=? AND window=? AND asof=?');

  for (const s of bundle.stations ?? []) if (isRow(s) && s.id && s.network) upsertStation(db, s);

  for (const r of bundle.obs ?? []) {
    if (!isRow(r) || !isIsoDate(r.date) || !SOURCES.includes(r.source)) { stat.skipped++; continue; }
    if (!known.has(r.field_id)) { unknown.add(r.field_id); stat.skipped++; continue; }
    const v = cleanPrecipIn(r.precip_in);
    if (v === null) { stat.skipped++; continue; }
    const have = obsAt.get(r.field_id, r.date, r.source)?.updated_at;
    if (!newer(r.updated_at, have)) { stat.skipped++; continue; }
    upsertObs(db, r.field_id, r.date, r.source, v, r.detail ?? null);
    if (have) stat.obsUpdated++; else stat.obs++;
  }

  for (const r of bundle.stationObs ?? []) {
    if (!isRow(r) || !isIsoDate(r.date) || !r.network || !r.station_id) { stat.skipped++; continue; }
    const v = cleanPrecipIn(r.precip_in);
    if (v === null) { stat.skipped++; continue; }
    const have = stAt.get(r.network, r.station_id, r.date)?.updated_at;
    if (!newer(r.updated_at, have)) { stat.skipped++; continue; }
    upsertStationObs(db, r.network, r.station_id, r.date, v);
    if (have) stat.readingsUpdated++; else stat.readings++;
  }

  for (const r of bundle.windows ?? []) {
    if (!isRow(r) || !isIsoDate(r.asof) || !known.has(r.field_id)) { stat.skipped++; continue; }
    const v = cleanPrecipIn(r.precip_in);
    if (v === null) { stat.skipped++; continue; }
    if (!newer(r.updated_at, winAt.get(r.field_id, r.source, r.window, r.asof)?.updated_at)) { stat.skipped++; continue; }
    upsertFieldWindow(db, r.field_id, r.source, r.window, r.asof, v);
    stat.windows++;
  }

  return { ...stat, addedFields: added, unknownFields: [...unknown] };
}

export function rederiveAfterImport(db, cfg) {
  return deriveAll(db, cfg.fields);
}
