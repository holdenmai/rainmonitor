import { fetchWithRetry, iemRows, cleanPrecipIn } from '../util.js';

const NETWORK_URL = n => `https://mesonet.agron.iastate.edu/api/1/network/${n}.geojson`;
const DAILY_URL = 'https://mesonet.agron.iastate.edu/api/1/daily.json';

/** All online stations in an IEM network, with coordinates. */
export async function fetchNetworkStations(network) {
  const gj = await fetchWithRetry(NETWORK_URL(network), { accept: 'json' });
  return (gj.features || [])
    .filter(f => f.properties?.online && Array.isArray(f.geometry?.coordinates))
    .map(f => ({
      id: f.properties.id,
      network,
      name: f.properties.name,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      elev_m: f.properties.elevation ?? null,
    }));
}

/**
 * Daily observations for one station for one calendar year.
 * Fetching a whole year per request keeps backfill to ~1 request/station/year
 * instead of one per day. IEM reports precip already in inches.
 */
export async function fetchStationYear(network, station, year) {
  const url = `${DAILY_URL}?network=${encodeURIComponent(network)}&station=${encodeURIComponent(station)}&year=${year}`;
  const rows = iemRows(await fetchWithRetry(url, { accept: 'json' }));
  return rows
    .map(r => ({ date: String(r.date).slice(0, 10), precip_in: cleanPrecipIn(r.precip) }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}
