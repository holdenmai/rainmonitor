import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from './util.js';

export function openDb(path = join(ROOT, 'data', 'rain.db')) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS field (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, acres REAL
    );

    CREATE TABLE IF NOT EXISTS station (
      id TEXT NOT NULL, network TEXT NOT NULL, name TEXT,
      lat REAL, lon REAL, elev_m REAL,
      PRIMARY KEY (network, id)
    );

    -- Which stations we pull for which field, and how far away they are.
    CREATE TABLE IF NOT EXISTS field_station (
      field_id TEXT NOT NULL, network TEXT NOT NULL, station_id TEXT NOT NULL,
      dist_km REAL NOT NULL, rank INTEGER NOT NULL,
      PRIMARY KEY (field_id, network, station_id)
    );

    -- One row per field per day per source. Sources stay separate on purpose:
    -- the disagreement between radar and gauge is itself a signal.
    CREATE TABLE IF NOT EXISTS obs (
      field_id TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
      precip_in REAL, detail TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (field_id, date, source)
    );

    -- Raw per-station readings, kept so a field can be re-derived without refetching.
    CREATE TABLE IF NOT EXISTS station_obs (
      network TEXT NOT NULL, station_id TEXT NOT NULL, date TEXT NOT NULL,
      precip_in REAL, updated_at TEXT NOT NULL,
      PRIMARY KEY (network, station_id, date)
    );

    -- Monthly station totals. The on-farm Davis only publishes daily rows for
    -- the current month, but monthly totals for the whole year — so the monthly
    -- series is the one that backfills, and it drives radar calibration.
    CREATE TABLE IF NOT EXISTS station_monthly (
      network TEXT NOT NULL, station_id TEXT NOT NULL, month TEXT NOT NULL,
      precip_in REAL, max_day_in REAL, updated_at TEXT NOT NULL,
      PRIMARY KEY (network, station_id, month)
    );

    -- Rolling-window snapshots (last 7 / 30 days, year to date) for sources that
    -- publish no archive. If a daily run is missed the daily series has a hole
    -- that can never be refilled, but these keep updating — so the gap stays
    -- visible and the cumulative picture is still recoverable.
    CREATE TABLE IF NOT EXISTS field_window (
      field_id TEXT NOT NULL, source TEXT NOT NULL, window TEXT NOT NULL,
      asof TEXT NOT NULL, precip_in REAL, updated_at TEXT NOT NULL,
      PRIMARY KEY (field_id, source, window, asof)
    );

    CREATE TABLE IF NOT EXISTS ingest_log (
      ts TEXT NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL,
      rows INTEGER, detail TEXT
    );

    CREATE INDEX IF NOT EXISTS obs_date_idx ON obs(date);
    CREATE INDEX IF NOT EXISTS obs_field_date_idx ON obs(field_id, date);
    CREATE INDEX IF NOT EXISTS stobs_date_idx ON station_obs(date);
  `);
}

/**
 * Bring the field table in line with config.json, including removals.
 *
 * The prune matters: without it a field deleted from config keeps its rows
 * forever and keeps showing up in the dashboard and CSV exports as though it
 * were still being tracked, with data that quietly stops updating.
 */
export function syncFields(db, fields) {
  const up = db.prepare(`INSERT INTO field (id,name,lat,lon,acres) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lon=excluded.lon, acres=excluded.acres`);
  for (const f of fields) up.run(f.id, f.name, f.lat, f.lon, f.acres ?? null);

  const keep = new Set(fields.map(f => f.id));
  const stale = db.prepare('SELECT id, name FROM field').all().filter(r => !keep.has(r.id));
  for (const s of stale) {
    for (const t of ['obs', 'field_station']) db.prepare(`DELETE FROM ${t} WHERE field_id = ?`).run(s.id);
    db.prepare('DELETE FROM field WHERE id = ?').run(s.id);
  }
  return stale;
}

export function upsertStation(db, s) {
  db.prepare(`INSERT INTO station (id,network,name,lat,lon,elev_m) VALUES (?,?,?,?,?,?)
    ON CONFLICT(network,id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lon=excluded.lon, elev_m=excluded.elev_m`)
    .run(s.id, s.network, s.name ?? null, s.lat ?? null, s.lon ?? null, s.elev_m ?? null);
}

export function setFieldStations(db, fieldId, links) {
  db.prepare('DELETE FROM field_station WHERE field_id = ?').run(fieldId);
  const ins = db.prepare('INSERT INTO field_station (field_id,network,station_id,dist_km,rank) VALUES (?,?,?,?,?)');
  links.forEach((l, i) => ins.run(fieldId, l.network, l.station_id, l.dist_km, i + 1));
}

export function upsertObs(db, fieldId, date, source, precipIn, detail = null) {
  db.prepare(`INSERT INTO obs (field_id,date,source,precip_in,detail,updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(field_id,date,source) DO UPDATE SET
      precip_in=excluded.precip_in, detail=excluded.detail, updated_at=excluded.updated_at`)
    .run(fieldId, date, source, precipIn, detail);
}

export function upsertStationObs(db, network, stationId, date, precipIn) {
  db.prepare(`INSERT INTO station_obs (network,station_id,date,precip_in,updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(network,station_id,date) DO UPDATE SET
      precip_in=excluded.precip_in, updated_at=excluded.updated_at`)
    .run(network, stationId, date, precipIn);
}

export function upsertStationMonthly(db, network, stationId, month, precipIn, maxDayIn) {
  db.prepare(`INSERT INTO station_monthly (network,station_id,month,precip_in,max_day_in,updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(network,station_id,month) DO UPDATE SET
      precip_in=excluded.precip_in, max_day_in=excluded.max_day_in, updated_at=excluded.updated_at`)
    .run(network, stationId, month, precipIn, maxDayIn);
}

export function upsertFieldWindow(db, fieldId, source, window, asof, precipIn) {
  db.prepare(`INSERT INTO field_window (field_id,source,window,asof,precip_in,updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(field_id,source,window,asof) DO UPDATE SET
      precip_in=excluded.precip_in, updated_at=excluded.updated_at`)
    .run(fieldId, source, window, asof, precipIn);
}

export function logIngest(db, source, ok, rows, detail) {
  db.prepare('INSERT INTO ingest_log (ts,source,ok,rows,detail) VALUES (datetime(\'now\'),?,?,?,?)')
    .run(source, ok ? 1 : 0, rows ?? null, detail ?? null);
}
