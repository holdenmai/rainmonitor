/**
 * The published copy's stand-in for the dashboard's API.
 *
 * Loaded ahead of app.js, and only in the static build, this sets
 * window.RM_STATIC so app.js's `apiGet` reads pre-generated files instead of
 * talking to a server. Nothing here draws anything: the charts are already pure
 * functions of the rows, so the only thing a file host changes is where the
 * rows come from.
 *
 * Two things it deliberately does *not* do. It does not patch window.fetch —
 * a monkey-patched global is invisible at the call site and would also swallow
 * the fetches this module makes itself. And it does not answer the mutating
 * endpoints, or the job and update polls: that half of app.js is never wired in
 * the static build, so anything reaching this shim for `/api/config/...` is a
 * bug worth hearing about rather than quietly absorbing.
 */

/**
 * Every path is resolved against this module's own URL, never against the
 * site root. The published copy commonly lands in a subdirectory of somebody
 * else's web host — `example.com/rain/` — where a leading slash would reach for
 * that host's document root and 404.
 */
const BASE = new URL('.', import.meta.url);

/** One fetch per file per page load, no matter how many callers want it: the
 *  promise is cached, not the result, so two overlapping requests for the same
 *  chunk share a single round trip rather than racing. */
const cache = new Map();
function file(rel) {
  if (!cache.has(rel)) {
    cache.set(rel, fetch(new URL(rel, BASE)).then(r => {
      // A file host answers a missing file with an HTML error page, and
      // r.json() on that fails with a parse error naming a character position,
      // which says nothing about what went wrong. Say what was missing.
      if (!r.ok) throw new Error(`${rel} is missing from the published copy (HTTP ${r.status})`);
      return r.json();
    }));
  }
  return cache.get(rel);
}

const meta = () => file('data/meta.json');

/**
 * Columnar back to rows.
 *
 * A chunk stores one array per source rather than one object per day, because
 * the key names are the bulk of the JSON otherwise: forty-five years of
 * `{"date":"1981-04-07","gauge":null,...}` is about three times the size of the
 * same numbers in parallel arrays, and the difference is uploaded over FTP from
 * a farm office.
 *
 * Dates are day offsets from the chunk's own `from` for the same reason — an
 * integer instead of an eleven-byte string — and stored explicitly rather than
 * assumed contiguous, because a field only starts having rows on the day it was
 * added and a source outage leaves real gaps.
 */
function rowsOf(chunk, from, to) {
  // UTC on both ends on purpose, and the one place in this codebase where that
  // is right: this is counting days between two calendar labels, not deciding
  // which day an observation fell on. Walking it in local time would drop or
  // repeat a day at each spring and autumn clock change, because adding 24
  // hours to a local midnight does not always land on the next midnight.
  const start = Date.parse(`${chunk.from}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < chunk.days.length; i++) {
    const d = new Date(start + chunk.days[i] * 86400000).toISOString().slice(0, 10);
    if (d < from || d > to) continue;
    const row = { date: d };
    for (const k of chunk.keys) row[k] = chunk.cols[k][i];
    out.push(row);
  }
  return out;
}

async function seriesFor(fieldId, from, to) {
  const m = await meta();
  const s = m.publish?.series?.[fieldId];
  // A field the reader can pick but that was never published would otherwise
  // draw an empty chart that reads as "no rain here".
  if (!s) throw new Error(`${fieldId} is not part of this published copy`);
  const wanted = s.chunks.filter(c => c.from <= to && c.to >= from);
  const chunks = await Promise.all(wanted.map(c => file(`data/series/${fieldId}/${c.file}`)));
  const rows = chunks.flatMap(c => rowsOf(c, from, to));
  // Chunks arrive in published order, which is chronological, but a chunk list
  // is config-shaped and one day may not be — sort rather than trust it.
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    from, to, rows,
    // Which gauges a field has, which of them are past the four colour slots,
    // and which years it has any data for are all properties of the field
    // rather than of the window, so they are published once in meta.json
    // instead of repeated in every chunk.
    gauges: s.gauges ?? [],
    uncharted: s.uncharted ?? [],
    years: s.years ?? [],
  };
}

window.RM_STATIC = {
  async get(path) {
    const url = new URL(path, 'http://x');   // parse-only origin; nothing is sent
    const q = url.searchParams;
    switch (url.pathname) {
      case '/api/fields': return meta();
      case '/api/summary': return file('data/summary.json');
      // Published only when publish.calibration is on. Empty is not a failure —
      // it is the same answer the dashboard gives when there is no on-farm
      // station, and app.js already hides the card on it.
      case '/api/calibration':
        return (await meta()).publish?.calibration ? file('data/calibration.json') : {};
      case '/api/series':
        return seriesFor(q.get('field'), q.get('from'), q.get('to'));
      default:
        throw new Error(`${url.pathname} has no static equivalent — this page is read-only`);
    }
  },
};
