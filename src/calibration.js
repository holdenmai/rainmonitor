/**
 * Bias of the gridded products against the on-farm gauge.
 *
 * Split by season on purpose: an unheated tipping bucket records almost nothing
 * for snow, so a cold-month ratio measures the gauge missing frozen precip, not
 * the radar reading high. A single annual factor bakes that in and would
 * under-report every summer storm on every other field.
 */
export const WARM_MONTHS = new Set([5, 6, 7, 8, 9]);

export function calibration(db, cfg) {
  const of = cfg.sources?.weatherlink;
  if (!of?.enabled) return null;

  const gauge = db.prepare(
    'SELECT month, precip_in FROM station_monthly WHERE network=? AND station_id=? ORDER BY month')
    .all('ONFARM', of.stationId);
  if (!gauge.length) return null;

  // Sample the grid at the field closest to the station, so it's like-for-like.
  const home = cfg.fields.reduce((best, f) => {
    const d = (f.lat - of.lat) ** 2 + (f.lon - of.lon) ** 2;
    return !best || d < best.d ? { f, d } : best;
  }, null).f;

  const grid = {};
  for (const src of ['mrms', 'prism']) {
    for (const r of db.prepare(
      'SELECT substr(date,1,7) m, SUM(precip_in) v FROM obs WHERE field_id=? AND source=? GROUP BY m')
      .all(home.id, src)) (grid[r.m] ||= {})[src] = r.v;
  }

  const acc = { warm: { g: 0, m: 0, p: 0, n: 0 }, cold: { g: 0, m: 0, p: 0, n: 0 } };
  const months = [];
  for (const row of gauge) {
    if (row.precip_in === null) continue;
    const g = row.precip_in, gr = grid[row.month] ?? {};
    const warm = WARM_MONTHS.has(Number(row.month.slice(5, 7)));
    const b = warm ? acc.warm : acc.cold;
    b.g += g; b.m += gr.mrms ?? 0; b.p += gr.prism ?? 0; b.n++;
    months.push({ month: row.month, gauge: g, mrms: gr.mrms ?? null, prism: gr.prism ?? null, warm });
  }

  const ratio = (a, b) => (b > 0.1 ? Math.round((a / b) * 1000) / 1000 : null);
  const pack = b => ({
    gauge: Math.round(b.g * 100) / 100, mrms: Math.round(b.m * 100) / 100, prism: Math.round(b.p * 100) / 100,
    months: b.n, mrmsFactor: ratio(b.g, b.m), prismFactor: ratio(b.g, b.p),
  });
  const all = { g: acc.warm.g + acc.cold.g, m: acc.warm.m + acc.cold.m, p: acc.warm.p + acc.cold.p, n: acc.warm.n + acc.cold.n };

  return {
    station: of.name, stationLat: of.lat, stationLon: of.lon, sampledAt: home.name,
    months, warm: pack(acc.warm), cold: pack(acc.cold), all: pack(all),
    provisional: acc.warm.n < 12,
  };
}
