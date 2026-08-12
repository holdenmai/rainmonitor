import { haversineKm } from './util.js';
import { fetchNetworkStations } from './sources/iemgauge.js';
import { fetchKsStations } from './sources/ksmesonet.js';
import { upsertStation, setFieldStations, setFieldStationsForNetwork } from './db.js';
import { manualGauges } from './setup.js';

/**
 * Map hand-read gauges to fields by distance.
 *
 * Kept separate from `discoverStations` and touching only the MANUAL rows,
 * because adding a gauge you read yourself should not depend on the internet.
 * A full rediscovery would fetch three station catalogues to answer a question
 * that is pure arithmetic on coordinates already in `config.json`.
 */
export function linkManualGauges(db, cfg, log = () => {}) {
  const sec = cfg.sources?.manual;
  const gauges = sec?.enabled === false ? [] : manualGauges(cfg);
  for (const g of gauges) upsertStation(db, { ...g, network: 'MANUAL' });

  for (const f of cfg.fields) {
    const excluded = new Set(f.exclude?.stations ?? []);
    const near = gauges
      .filter(g => Number.isFinite(g.lat) && Number.isFinite(g.lon))
      .map(g => ({ station_id: g.id, dist_km: haversineKm(f.lat, f.lon, g.lat, g.lon), range: g.maxDistanceKm }))
      .filter(g => g.dist_km <= (g.range ?? sec?.maxDistanceKm ?? 25))
      .sort((a, b) => a.dist_km - b.dist_km)
      .slice(0, sec?.maxStations ?? 2)
      .map(g => ({ ...g, excluded: excluded.has(`MANUAL|${g.station_id}`) ? 1 : 0 }));
    setFieldStationsForNetwork(db, f.id, 'MANUAL', near);
    if (near.length) log(`  ${f.name}: manual ${near.map(g => `${g.station_id} @ ${g.dist_km.toFixed(1)} km`).join(', ')}`);
  }
}

/** The one-station "pool" an on-farm station forms, or null if it is unusable. */
export function onFarmStationRow(of) {
  if (!of?.enabled || !Number.isFinite(of.lat) || !Number.isFinite(of.lon)) return null;
  return {
    id: of.stationId, network: 'ONFARM', name: of.name, lat: of.lat, lon: of.lon,
    elev_m: Number.isFinite(Number(of.elev_ft)) ? Math.round(Number(of.elev_ft) * 0.3048) : null,
  };
}

/**
 * Map the on-farm station to fields by distance.
 *
 * Split out of `discoverStations` for the same reason `linkManualGauges` is:
 * the station's position is already in config.json, so which fields it reaches
 * is arithmetic. Adding one from the dashboard should not wait on three station
 * catalogues downloading, and should not fail because one of them timed out.
 */
export function linkOnFarmStation(db, cfg, log = () => {}) {
  const of = cfg.sources?.weatherlink;
  const row = onFarmStationRow(of);
  if (row) upsertStation(db, row);

  for (const f of cfg.fields) {
    const excluded = new Set(f.exclude?.stations ?? []);
    const links = [];
    if (row) {
      const dist_km = haversineKm(f.lat, f.lon, row.lat, row.lon);
      if (dist_km <= (of.maxDistanceKm ?? 30))
        links.push({ station_id: row.id, dist_km, excluded: excluded.has(`ONFARM|${row.id}`) ? 1 : 0 });
    }
    // Also the path that unlinks it: an empty list clears the ONFARM rows, so
    // switching the station off stops it counting without a rediscovery.
    setFieldStationsForNetwork(db, f.id, 'ONFARM', links);
    if (links.length) log(`  ${f.name}: on-farm station @ ${links[0].dist_km.toFixed(1)} km`);
  }
}

/**
 * Build the field -> nearby-gauge mapping. Run this once, and again whenever
 * you edit the field list in config.json.
 */
export async function discoverStations(db, cfg, log = console.log) {
  const pools = [];
  // Networks whose station list could not be fetched this run. Their existing
  // links are carried over instead of being rewritten away: this function
  // replaces the whole mapping, so without it one timed-out request quietly
  // unlinks that network from every field until the next successful discover,
  // and the daily gauge figure silently falls back to a station miles further out.
  const failed = new Set();

  if (cfg.sources.iem_gauge?.enabled) {
    const nets = cfg.sources.iem_gauge.networks ?? [];
    if (!nets.length) log('  iem_gauge: no networks resolved — set region.states in config.json');
    for (const net of nets) {
      try {
        const st = await fetchNetworkStations(net);
        pools.push({ kind: 'iem', network: net, stations: st, cfg: cfg.sources.iem_gauge });
        log(`  ${net}: ${st.length} online stations`);
      } catch (e) { failed.add(net); log(`  ${net}: FAILED (${e.message}) — keeping the links it already had`); }
    }
  }

  // A personal weather station is a pool of one. It ranks by distance like any
  // other gauge, so it naturally wins for nearby fields without special-casing.
  const of = cfg.sources.weatherlink;
  if (of?.enabled) {
    const row = onFarmStationRow(of);
    if (!row) {
      log('  ONFARM: enabled but lat/lon are unset — set them in the dashboard, under "Your own weather station"');
    } else {
      pools.push({ kind: 'weatherlink', network: 'ONFARM', cfg: { ...of, maxStations: 1 }, stations: [row] });
      log(`  ONFARM: 1 station (${of.name})`);
    }
  }

  if (cfg.sources.ksmesonet?.enabled) {
    try {
      const st = await fetchKsStations();
      pools.push({ kind: 'ks', network: 'KS_MESONET', stations: st, cfg: cfg.sources.ksmesonet });
      log(`  KS_MESONET: ${st.length} stations`);
    } catch (e) { failed.add('KS_MESONET'); log(`  KS_MESONET: FAILED (${e.message}) — keeping the links it already had`); }
  }

  for (const pool of pools) for (const s of pool.stations) upsertStation(db, s);

  const priorLinks = db.prepare('SELECT field_id, network, station_id, dist_km FROM field_station').all();

  for (const f of cfg.fields) {
    const excluded = new Set(f.exclude?.stations ?? []);
    const links = priorLinks.filter(l => l.field_id === f.id && failed.has(l.network))
      .map(l => ({ ...l, excluded: excluded.has(`${l.network}|${l.station_id}`) ? 1 : 0 }));
    for (const pool of pools) {
      const inRange = pool.stations
        .map(s => ({ network: pool.network, station_id: s.id, name: s.name, dist_km: haversineKm(f.lat, f.lon, s.lat, s.lon) }))
        .filter(s => s.dist_km <= (pool.cfg.maxDistanceKm ?? 50))
        .sort((a, b) => a.dist_km - b.dist_km);
      const drop = s => excluded.has(`${s.network}|${s.station_id}`);
      // Excluding a station promotes the next one in range rather than just
      // leaving the field a gauge short — the point of turning off a distant
      // gauge is usually to fall back to a better one, not to go blind.
      links.push(...inRange.filter(s => !drop(s)).slice(0, pool.cfg.maxStations ?? 3));
      links.push(...inRange.filter(drop).map(s => ({ ...s, excluded: 1 })));
    }
    links.sort((a, b) => a.dist_km - b.dist_km);
    setFieldStations(db, f.id, links);
    const counted = links.filter(l => !l.excluded);
    log(`  ${f.name}: ${counted.length} gauges`
        + (links.length > counted.length ? ` (${links.length - counted.length} excluded)` : '')
        + (counted[0] ? ` (nearest ${counted[0].station_id} @ ${counted[0].dist_km.toFixed(1)} km)` : ' — none in range, widen maxDistanceKm'));
  }

  // After the wipe-and-rebuild above, which clears MANUAL links along with the rest.
  linkManualGauges(db, cfg, log);
}
