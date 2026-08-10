import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { openDb, syncFields, setStationExclusions, upsertStationObs, deleteStationObs } from './db.js';
import { loadConfig, ROOT, today, addDays, isIsoDate, cleanPrecipIn, SOURCES } from './util.js';
import { calibration } from './calibration.js';
import {
  readConfig, writeConfig, autoDetectRegion,
  addField, updateField, removeField, setExclusions, farmsOf,
  manualGauges, upsertManualGauge, removeManualGauge,
} from './setup.js';
import { discoverStations, linkManualGauges } from './stations.js';
import { deriveField } from './derive.js';

let cfg = loadConfig();
const db = openDb();
const WEB = join(ROOT, 'web');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const seasonStart = () => {
  const y = new Date().getFullYear();
  return cfg.season?.mode === 'water'
    ? (today() >= `${y}-10-01` ? `${y}-10-01` : `${y - 1}-10-01`)
    : `${y}-01-01`;
};
const growStart = () => `${new Date().getFullYear()}-${cfg.season?.growingSeasonStart ?? '04-01'}`;

const excludedSources = fieldId =>
  new Set(cfg.fields.find(f => f.id === fieldId)?.exclude?.sources ?? []);

/**
 * Wide rows: one per field-date, one column per source.
 *
 * Excluded sources are blanked here rather than filtered in SQL, so every
 * downstream view — KPI tiles, charts, table, CSV — honours the exclusion from
 * one place, and the underlying rows stay intact for when it is turned back on.
 */
function series(fieldId, since) {
  const rows = db.prepare(`
    SELECT date,
      MAX(CASE WHEN source='gauge'  THEN precip_in END) gauge,
      MAX(CASE WHEN source='manual' THEN precip_in END) manual,
      MAX(CASE WHEN source='rfcqpe' THEN precip_in END) rfcqpe,
      MAX(CASE WHEN source='mrms'   THEN precip_in END) mrms,
      MAX(CASE WHEN source='prism'  THEN precip_in END) prism,
      MAX(CASE WHEN source='iemre'  THEN precip_in END) iemre,
      MAX(CASE WHEN source='gauge'  THEN detail    END) gauge_src,
      MAX(CASE WHEN source='manual' THEN detail    END) manual_src
    FROM obs WHERE field_id = ? AND date >= ?
    GROUP BY date ORDER BY date`).all(fieldId, since);

  const ex = excludedSources(fieldId);
  if (ex.size) for (const r of rows) {
    for (const s of ex) r[s] = null;
    if (ex.has('gauge')) r.gauge_src = null;
    if (ex.has('manual')) r.manual_src = null;
  }
  return rows;
}

const sum = (rows, k) => {
  const vals = rows.map(r => r[k]).filter(v => v !== null && v !== undefined);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
};

function summary(fieldId) {
  const end = today();
  const rows = series(fieldId, seasonStart());
  const win = n => rows.filter(r => r.date > addDays(end, -n));
  const out = { field_id: fieldId };
  for (const [label, subset] of [['d1', win(1)], ['d7', win(7)], ['d30', win(30)],
                                 ['season', rows], ['growing', rows.filter(r => r.date >= growStart())]]) {
    out[label] = Object.fromEntries(SOURCES.map(s => [s, sum(subset, s)]));
  }
  // Days since the last measurable rain (>= 0.01 in) on any source.
  let dry = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (SOURCES.some(s => (rows[i][s] ?? 0) >= 0.01)) {
      dry = Math.max(0, Math.round((new Date(end) - new Date(rows[i].date)) / 86400000));
      break;
    }
  }
  out.days_since_rain = dry;
  out.last_date = rows.at(-1)?.date ?? null;
  return out;
}

function csv(fieldId, since) {
  const fields = fieldId ? [fieldId] : cfg.fields.map(f => f.id);
  const names = Object.fromEntries(cfg.fields.map(f => [f.id, f.name]));
  const farms = Object.fromEntries(cfg.fields.map(f => [f.id, f.farm ?? '']));
  const lines = ['field_id,field_name,farm,date,gauge_in,manual_in,rfcqpe_4km_in,mrms_in,prism_in,iemre_in,gauge_station,manual_gauge'];
  for (const id of fields) {
    for (const r of series(id, since)) {
      const q = v => (v === null || v === undefined ? '' : v);
      lines.push([id, csvq(names[id]), csvq(farms[id]), r.date,
        q(r.gauge), q(r.manual), q(r.rfcqpe), q(r.mrms), q(r.prism), q(r.iemre),
        csvq(r.gauge_src), csvq(r.manual_src)].join(','));
    }
  }
  return lines.join('\n');
}
const csvq = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};
const json = (res, obj) => send(res, 200, 'application/json', JSON.stringify(obj));

const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('invalid JSON body')); } });
  req.on('error', reject);
});

/**
 * The field editor writes config.json, so it is restricted to loopback even if
 * someone changes server.host to bind wider. Read-only views stay available.
 */
const isLocal = req => {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // --- Field management (writes config.json) ---
    if (p === '/api/config/fields') {
      if (req.method === 'GET') return json(res, { fields: cfg.fields, farms: farmsOf(cfg.fields), region: cfg.region ?? {} });
      if (req.method === 'POST' || req.method === 'DELETE') {
        if (!isLocal(req)) return send(res, 403, 'text/plain', 'field editing is restricted to localhost');
        const body = await readBody(req);
        const live = readConfig();
        // Only a moved, added or removed field changes which gauges apply. An
        // acres or farm edit does not, and remapping there would spend several
        // seconds of network calls to rewrite the same rows.
        const before = live.fields.find(f => f.id === body.id);
        let remap = true;
        try {
          if (req.method === 'DELETE') removeField(live, body.id);
          else if (body.id) {
            const after = updateField(live, body.id, body);
            remap = !before || before.lat !== after.lat || before.lon !== after.lon;
          } else addField(live, body);
        } catch (e) {
          return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
        }
        await autoDetectRegion(live, () => {});
        writeConfig(live);
        cfg = live;
        // Remap gauges for the changed field set, and drop any pruned rows.
        syncFields(db, cfg.fields);
        if (remap) await discoverStations(db, cfg, () => {});
        return json(res, { ok: true, fields: cfg.fields, farms: farmsOf(cfg.fields), region: cfg.region ?? {} });
      }
      return send(res, 405, 'text/plain', 'method not allowed');
    }

    // --- Manual gauges: stations nothing fetches, read by hand ---
    if (p === '/api/config/gauges') {
      if (req.method === 'GET') return json(res, { gauges: manualGauges(cfg) });
      if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'gauge editing is restricted to localhost');
      const body = await readBody(req);
      const live = readConfig();
      let removed = null;
      try {
        if (req.method === 'DELETE') removed = removeManualGauge(live, body.id);
        else upsertManualGauge(live, body);
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
      }
      writeConfig(live);
      cfg = live;
      // Pure arithmetic on coordinates — no station catalogues to refetch.
      linkManualGauges(db, cfg);
      for (const f of cfg.fields) deriveField(db, f.id, 'manual');
      const kept = removed ? db.prepare('SELECT COUNT(*) n FROM station_obs WHERE network=? AND station_id=?')
        .get('MANUAL', removed.id).n : 0;
      return json(res, { ok: true, gauges: manualGauges(cfg), keptReadings: kept });
    }

    if (p === '/api/readings') {
      if (req.method === 'GET') {
        const days = Math.min(Number(url.searchParams.get('days')) || 120, 5000);
        const gauge = url.searchParams.get('gauge');
        const rows = db.prepare(`SELECT station_id, date, precip_in, updated_at FROM station_obs
          WHERE network='MANUAL' AND date >= ? ${gauge ? 'AND station_id = ?' : ''}
          ORDER BY date DESC, station_id`).all(...[addDays(today(), -days), ...(gauge ? [gauge] : [])]);
        return json(res, { readings: rows });
      }
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'readings are restricted to localhost');
      const body = await readBody(req);
      const gauge = manualGauges(cfg).find(g => g.id === body.gauge);
      const bad = !gauge ? `no manual gauge with id "${body.gauge}"`
        : !isIsoDate(body.date) ? 'date must be YYYY-MM-DD'
        : body.date > today() ? 'that date has not happened yet'
        : null;
      if (bad) return send(res, 400, 'application/json', JSON.stringify({ error: bad }));

      // An empty value deletes the reading. "I typed that on the wrong day" and
      // "it did not rain" have to stay distinguishable — a blank must not become
      // a confident 0.00.
      const blank = body.precip_in === '' || body.precip_in === null || body.precip_in === undefined;
      const v = blank ? null : cleanPrecipIn(body.precip_in);
      if (!blank && v === null)
        return send(res, 400, 'application/json', JSON.stringify({ error: 'inches must be between 0 and 30' }));
      if (blank) deleteStationObs(db, 'MANUAL', gauge.id, body.date);
      else upsertStationObs(db, 'MANUAL', gauge.id, body.date, v);

      for (const f of cfg.fields) deriveField(db, f.id, 'manual');
      return json(res, { ok: true, gauge: gauge.id, date: body.date, precip_in: v });
    }

    // --- Per-field exclusions: which sources and gauges count here ---
    if (p === '/api/config/exclusions') {
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'editing is restricted to localhost');
      const body = await readBody(req);
      const live = readConfig();
      try {
        setExclusions(live, body.id, body);
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
      }
      writeConfig(live);
      cfg = live;
      // Flip the flags in place and re-derive now, so the change is visible on
      // this reload. Promoting the next station in range needs the full station
      // lists, which is a `npm run discover` away.
      const f = cfg.fields.find(x => x.id === body.id);
      setStationExclusions(db, body.id, f.exclude?.stations ?? []);
      deriveField(db, body.id, 'gauge');
      deriveField(db, body.id, 'manual');
      return json(res, { ok: true, exclude: f.exclude ?? {} });
    }

    if (p === '/api/fields') {
      // Ordered by distance, not rank: rank only orders within a network, and
      // manual gauges are linked separately from the fetched ones.
      const stations = db.prepare(`SELECT fs.field_id, fs.station_id, fs.network, fs.dist_km, fs.excluded, s.name
        FROM field_station fs LEFT JOIN station s ON s.id=fs.station_id AND s.network=fs.network
        ORDER BY fs.field_id, fs.dist_km`).all();
      return json(res, {
        fields: cfg.fields.map(f => ({ ...f, stations: stations.filter(s => s.field_id === f.id) })),
        sources: SOURCES,
        gauges: manualGauges(cfg),
        farms: farmsOf(cfg.fields),
        seasonStart: seasonStart(), growingStart: growStart(),
        lastIngest: db.prepare('SELECT MAX(ts) t FROM ingest_log').get()?.t ?? null,
      });
    }
    if (p === '/api/series') {
      const days = Math.min(Number(url.searchParams.get('days')) || 60, 3000);
      return json(res, { rows: series(url.searchParams.get('field'), addDays(today(), -days)) });
    }
    if (p === '/api/summary') return json(res, { summaries: cfg.fields.map(f => summary(f.id)) });
    if (p === '/api/calibration') return json(res, calibration(db, cfg) ?? {});
    if (p === '/api/export.csv') {
      const days = Math.min(Number(url.searchParams.get('days')) || 400, 5000);
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="rainfall_${today()}.csv"`,
      });
      return res.end(csv(url.searchParams.get('field') || null, addDays(today(), -days)));
    }

    // Static files, path-traversal guarded.
    const rel = p === '/' ? 'index.html' : normalize(p).replace(/^([/\\])+/, '');
    const file = join(WEB, rel);
    if (!file.startsWith(WEB)) return send(res, 403, 'text/plain', 'forbidden');
    return send(res, 200, MIME[extname(file)] ?? 'application/octet-stream', await readFile(file));
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'text/plain', 'not found');
    return send(res, 500, 'text/plain', String(e.message));
  }
});

const { port = 8787, host = '127.0.0.1' } = cfg.server ?? {};
server.listen(port, host, () => console.log(`rainmonitor -> http://${host}:${port}`));
