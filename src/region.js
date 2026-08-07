import { fetchWithRetry } from './util.js';

/**
 * Resolve a lat/lon to a US state code, so setup doesn't ask people to know
 * which IEM networks cover them. Uses the Census Bureau geocoder — public,
 * no API key, no rate limit worth worrying about for a handful of fields.
 */
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';

export async function detectState(lat, lon) {
  const url = `${CENSUS}?x=${lon}&y=${lat}&benchmark=Public_AR_Current`
            + '&vintage=Current_Current&layers=States&format=json';
  try {
    const j = await fetchWithRetry(url, { accept: 'json', tries: 2, timeoutMs: 20000 });
    return j?.result?.geographies?.States?.[0]?.STUSAB ?? null;
  } catch {
    return null;   // offline or outside the US — caller falls back to config
  }
}

export async function detectStates(fields) {
  const found = new Set();
  for (const f of fields) {
    const st = await detectState(f.lat, f.lon);
    if (st) found.add(st);
  }
  return [...found];
}

/** IEM publishes COOP and ASOS networks per state, named <ST>_COOP / <ST>_ASOS. */
export function networksFor(states) {
  return states.flatMap(st => [`${st}_COOP`, `${st}_ASOS`]);
}

/**
 * State mesonets with their own APIs. Only Kansas is implemented; the entry
 * exists so adding another is a matter of writing one source module rather
 * than rethinking the config. Everyone else falls back to COOP/ASOS, which
 * cover the whole country.
 */
export const STATE_MESONETS = { KS: 'ksmesonet' };

export function mesonetFor(states) {
  for (const st of states) if (STATE_MESONETS[st]) return STATE_MESONETS[st];
  return null;
}
