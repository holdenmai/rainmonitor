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

  if (cfg.sources.iem_gauge?.enabled) {
    const nets = cfg.sources.iem_gauge.networks ?? [];
    if (!nets.length) log('  iem_gauge: no networks resolved — set region.states in config.json');
    for (const net of nets) {
      try {
        const st = await fetchNetworkStations(net);
        pools.push({ kind: 'iem', network: net, stations: st, cfg: cfg.sources.iem_gauge });
        log(`  ${net}: ${st.length} online stations`);
      } catch (e) { log(`  ${net}: FAILED (${e.message})`); }
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
    } catch (e) { log(`  KS_MESONET: FAILED (${e.message})`); }
  }

  for (const pool of pools) for (const s of pool.stations) upsertStation(db, s);

  for (const f of cfg.fields) {
    const links = [];
    for (const pool of pools) {
      const near = pool.stations
        .map(s => ({ network: pool.network, station_id: s.id, name: s.name, dist_km: haversineKm(f.lat, f.lon, s.lat, s.lon) }))
        .filter(s => s.dist_km <= (pool.cfg.maxDistanceKm ?? 50))
        .sort((a, b) => a.dist_km - b.dist_km)
        .slice(0, pool.cfg.maxStations ?? 3);
      links.push(...near);
    }
    links.sort((a, b) => a.dist_km - b.dist_km);
    setFieldStations(db, f.id, links);
    log(`  ${f.name}: ${links.length} gauges` +
        (links[0] ? ` (nearest ${links[0].station_id} @ ${links[0].dist_km.toFixed(1)} km)` : ' — none in range, widen maxDistanceKm'));
  }
}
