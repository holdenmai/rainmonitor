import { fetchWithRetry, cleanPrecipIn } from '../util.js';

/**
 * NWS River Forecast Center QPE, via the public ArcGIS MapServer that backs
 * NOAA's own precipitation viewer (and, rebranded, iWeatherNet's rainfall map).
 *
 * WHY IT IS HERE: ~4 km grid, versus the ~12 km IEMRE feed — three times finer,
 * and it needs no GRIB toolchain, just JSON over HTTP. That resolution is the
 * whole reason it is worth the extra requests: fields on one operation often sit
 * within a few km of each other, and summer convection routinely hits one
 * quarter section and misses the next.
 *
 * NOT square-mile. The service states "approximate 4km x 4km grid cell scale",
 * and its own native pixel size (5370 m in Web Mercator) works out to 4187 m of
 * ground at this latitude — 2.6 mi per side, ~6.8 sq mi per cell. Maps drawn
 * from it look finer only because the raster is resampled smoothly at any zoom.
 * Genuine ~1 sq mi means native 1 km MRMS, which is the GRIB2 path.
 *
 * NO ARCHIVE. The service exposes rolling windows only (timeInfo: none) — there
 * is no way to ask it for a past date. Daily values therefore only accumulate
 * from the first run forward, and a missed run loses that day permanently. The
 * window snapshots below exist to make such a gap visible and recoverable.
 */

const BASE = 'https://mapservices.weather.noaa.gov/raster/rest/services/obs/rfc_qpe/MapServer/identify';

/**
 * Image sublayer ids. Each group layer in the service holds its raster at
 * group_id + 3; verified against the service 2026-08-07.
 */
export const LAYERS = {
  day1:   32,  // "Today's Analysis" — fixed 24h total ending 12Z
  last24: 28,  // rolling 24h from query time
  last7:  56,
  last30: 68,
  ytd:    96,
};

export async function identifyPoint(lon, lat, layer) {
  const p = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    sr: '4326',
    layers: `all:${layer}`,
    tolerance: '1',
    // A small box around the point; identify needs an extent + display size to
    // resolve its pixel, but the returned value is the raster cell, not a mean.
    mapExtent: `${lon - 0.05},${lat - 0.05},${lon + 0.05},${lat + 0.05}`,
    imageDisplay: '400,400,96',
    returnGeometry: 'false',
  });

  const payload = await fetchWithRetry(`${BASE}?${p}`, { accept: 'json', tries: 3 });
  const attrs = payload?.results?.[0]?.attributes;
  if (!attrs) return null;

  const raw = attrs['Classify.Pixel Value'] ?? attrs['Service Pixel Value'];
  // Outside the mosaic, or a NoData cell, comes back as a non-numeric marker.
  if (raw === undefined || raw === null || raw === '' || /nodata/i.test(String(raw))) return null;
  return cleanPrecipIn(raw);
}
