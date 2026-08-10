import { haversineKm } from './util.js';
import { fetchNetworkStations } from './sources/iemgauge.js';
import { fetchKsStations } from './sources/ksmesonet.js';
import { upsertStation, setFieldStations } from './db.js';

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
    if (!Number.isFinite(of.lat) || !Number.isFinite(of.lon)) {
      log('  ONFARM: enabled but lat/lon are unset in config.json — skipped');
    } else {
      pools.push({
        kind: 'weatherlink', network: 'ONFARM', cfg: { ...of, maxStations: 1 },
        stations: [{ id: of.stationId, network: 'ONFARM', name: of.name, lat: of.lat, lon: of.lon,
                     elev_m: of.elev_ft ? Math.round(of.elev_ft * 0.3048) : null }],
      });
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
}
