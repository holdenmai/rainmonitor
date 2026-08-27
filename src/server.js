import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname, normalize } from 'node:path';
import { openDb, syncFields, setStationExclusions, upsertStationObs, deleteStationObs } from './db.js';
import { loadConfig, ROOT, today, addDays, isIsoDate, cleanPrecipIn, SOURCES, historyStart, HISTORY_FLOOR_YEAR } from './util.js';
import { calibration } from './calibration.js';
import {
  readConfig, writeConfig, autoDetectRegion,
  addField, updateField, removeField, setExclusions, farmsOf,
  manualGauges, upsertManualGauge, removeManualGauge,
  onFarmStation, setOnFarmStation, removeOnFarmStation,
} from './setup.js';
import { linkManualGauges, linkOnFarmStation } from './stations.js';
import { probeStation } from './sources/weatherlink.js';
import { deriveField } from './derive.js';
import { buildExport, applyImport, rederiveAfterImport } from './sync.js';
import { buildBackup, applyBackup, versionProblem, writeSafetyCopy } from './backup.js';
import { createJobs } from './jobs.js';
import { createUpdates, headCommit } from './update.js';
import { createViews, GAUGE_SLOTS } from './views.js';

let cfg = loadConfig();
const db = openDb();
const WEB = join(ROOT, 'web');
const jobs = createJobs(db, () => cfg);
const updates = createUpdates(db, () => cfg);
// The read side lives in views.js so `npm run publish` answers from the same
// code the dashboard does. Config through a getter for the same reason jobs
// and updates take one: `cfg` is rebound whenever config.json is written.
const {
  fieldGauges, series, summary, csv, meta, yearsWithData, yearTotals,
} = createViews(db, () => cfg);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

/**
 * Shared query parsing for both exports: an explicit from/to window, an
 * optional field list, an optional source list. `days` is still honoured so
 * older bookmarked export links keep working.
 */
function exportRange(url) {
  const q = url.searchParams;
  const list = k => (q.get(k) ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const to = isIsoDate(q.get('to')) ? q.get('to') : today();
  const days = Math.min(Number(q.get('days')) || 400, 5000);
  const from = isIsoDate(q.get('from')) ? q.get('from') : addDays(to, -days);
  const asked = [...list('fields'), ...(q.get('field') ? [q.get('field')] : [])];
  const fields = asked.filter(id => cfg.fields.some(f => f.id === id));
  const sources = list('sources').filter(s => SOURCES.includes(s));
  return {
    from: from <= to ? from : to, to,
    fields: fields.length ? fields : cfg.fields.map(f => f.id),
    sources: sources.length ? sources : SOURCES,
  };
}

const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};
const json = (res, obj) => send(res, 200, 'application/json', JSON.stringify(obj));

// An import bundle is a whole date range of observations, and a restore is a
// whole database, so both need far more headroom than a field edit. Overflow
// rejects with a message rather than destroying the socket, which used to leave
// the request hanging with no reply.
//
// Buffers are concatenated rather than appended to a string: a multi-byte
// character split across two chunks becomes two replacement characters if each
// chunk is decoded on its own, and a backup carries whatever anyone typed into
// a field or farm name.
const readBody = (req, max = 1e6) => new Promise((resolve, reject) => {
  const chunks = [];
  let n = 0, over = false;
  req.on('data', c => {
    if (over) return;
    n += c.length;
    if (n > max) { over = true; reject(new Error(`body larger than ${Math.round(max / 1e6)} MB`)); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) return;
    try { resolve(n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch { reject(new Error('invalid JSON body')); }
  });
  req.on('error', e => { if (!over) reject(e); });
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
        let changed = null;
        try {
          if (req.method === 'DELETE') removeField(live, body.id);
          else if (body.id) {
            const after = updateField(live, body.id, body);
            if (!before || before.lat !== after.lat || before.lon !== after.lon) changed = after;
          } else changed = addField(live, body);
        } catch (e) {
          return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
        }
        await autoDetectRegion(live, () => {});
        writeConfig(live);
        cfg = live;
        syncFields(db, cfg.fields);
        // A new or moved field needs its gauges mapped and its history pulled.
        // That used to be two npm commands the dashboard told you to go and run;
        // it now queues here and reports progress on the page.
        let job = null;
        if (changed) {
          jobs.start('newfield', { opts: { fields: [changed.id] }, note: changed.name });
          job = `Mapping gauges and pulling history for ${changed.name}`;
        }
        return json(res, { ok: true, fields: cfg.fields, farms: farmsOf(cfg.fields), region: cfg.region ?? {}, job });
      }
      return send(res, 405, 'text/plain', 'method not allowed');
    }

    // --- Software updates, pulled from git ---
    if (p === '/api/update') {
      if (req.method === 'GET') {
        // ?check=1 forces a fetch; the plain GET answers from the last one, so
        // opening the page is never blocked on the network.
        if (url.searchParams.get('check')) return json(res, await updates.check({ force: true }));
        return json(res, await updates.describe());
      }
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'updating is restricted to localhost');
      if (jobs.status().running)
        return send(res, 409, 'application/json', JSON.stringify({
          error: 'A rainfall pull is running. Let it finish, then update.' }));
      let result;
      try {
        result = await updates.apply();
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
      }
      // Reply first, restart after: the browser needs this response to know to
      // start waiting for the new process.
      json(res, { ok: true, ...result, restarting: result.updated });
      if (result.updated) setTimeout(restart, 250);
      return;
    }

    // --- Background work: gauge mapping and the rainfall pull ---
    if (p === '/api/jobs') {
      if (req.method === 'GET') return json(res, jobs.status());
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'starting jobs is restricted to localhost');
      const body = await readBody(req);
      try {
        return json(res, jobs.start(body.job, { opts: body, note: body.note ?? 'requested from the dashboard' }));
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
      }
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

    // --- The station on your own ground (Davis / WeatherLink NOAA reports) ---
    if (p === '/api/config/station') {
      if (req.method === 'GET') return json(res, { station: onFarmStation(cfg) });
      if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'station editing is restricted to localhost');
      const body = await readBody(req);
      const live = readConfig();
      let saved = null;
      try {
        if (req.method === 'DELETE') removeOnFarmStation(live);
        else saved = setOnFarmStation(live, body);
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
      }
      writeConfig(live);
      cfg = live;
      // Pure arithmetic on coordinates already in config — no station
      // catalogues to refetch, so this is not a rediscovery.
      linkOnFarmStation(db, cfg);
      for (const f of cfg.fields) deriveField(db, f.id, 'gauge');
      let job = null;
      if (saved) {
        jobs.start('station', { note: saved.name });
        job = `Reading ${saved.name}'s reports`;
      }
      const kept = db.prepare('SELECT COUNT(*) n FROM station_obs WHERE network = ?').get('ONFARM').n;
      return json(res, { ok: true, station: onFarmStation(cfg), job, keptReadings: kept });
    }

    // Fetch both reports and say what is in them, storing nothing. Pointing
    // these at the wrong file otherwise shows up months later as a series that
    // never started.
    if (p === '/api/config/station/test') {
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'testing is restricted to localhost');
      const body = await readBody(req);
      return json(res, await probeStation(body));
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

    // --- How far back history is pulled ---
    //
    // Written to config rather than passed per click, because the same answer
    // has to reach the *new field* path: a quarter section added to a farm
    // holding forty years should arrive holding forty years.
    if (p === '/api/config/history') {
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'editing is restricted to localhost');
      const body = await readBody(req);
      const y = Number(body.historyFromYear);
      const thisYear = new Date().getFullYear();
      if (!Number.isInteger(y) || y < HISTORY_FLOOR_YEAR || y > thisYear)
        return send(res, 400, 'application/json', JSON.stringify({
          error: `year must be between ${HISTORY_FLOOR_YEAR} and ${thisYear} — PRISM, the deepest daily source here, publishes nothing before ${HISTORY_FLOOR_YEAR}`,
        }));

      const live = readConfig();
      live.ingest = { ...(live.ingest ?? {}), historyFromYear: y };
      writeConfig(live);
      cfg = live;
      return json(res, { ok: true, historyFromYear: y, sdate: historyStart(cfg) });
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
      // Flip the flags and re-derive, and that is the whole operation — no
      // remap. Unticking a gauge used to queue a discover to promote the next
      // station into range; it now means only what it says, so the answer is
      // arithmetic on rows already here and the checkbox settles immediately.
      const f = cfg.fields.find(x => x.id === body.id);
      setStationExclusions(db, body.id, f.exclude?.stations ?? []);
      deriveField(db, body.id, 'gauge');
      deriveField(db, body.id, 'manual');
      return json(res, { ok: true, exclude: f.exclude ?? {} });
    }

    if (p === '/api/fields') return json(res, meta());
    if (p === '/api/series') {
      const q = url.searchParams;
      const field = q.get('field');
      // An explicit window, so the same endpoint can serve last year's slice of
      // the calendar for the comparison overlay. `days` still works on its own,
      // which is what "Last 30 days" and any older bookmark ask for.
      const days = Math.min(Number(q.get('days')) || 60, 3000);
      const to = isIsoDate(q.get('to')) ? q.get('to') : today();
      const from = isIsoDate(q.get('from')) ? q.get('from') : addDays(to, -days);
      const all = fieldGauges(field);
      // The cap is reported, not silently applied: a gauge that counts towards
      // the field's figure but has no line of its own has to say so.
      return json(res, {
        from, to,
        rows: from <= to ? series(field, from, to) : [],
        gauges: all.slice(0, GAUGE_SLOTS),
        uncharted: all.slice(GAUGE_SLOTS).map(g => g.name),
        years: yearsWithData(field),
      });
    }
    // `yearTotals` rides along rather than getting an endpoint of its own: the
    // all-fields chart needs both in the same paint, and the published copy has
    // to answer this from a single file either way.
    //
    // Only for the years the page is actually drawing, and never by default.
    // Totalling every stored year is a full scan of `obs` — see the note in
    // views.js — and this endpoint is fetched on every field, range and
    // comparison change, so paying for forty-six years to draw none of them made
    // the whole dashboard crawl.
    if (p === '/api/summary') {
      const want = (url.searchParams.get('years') ?? '').split(',').filter(y => /^\d{4}$/.test(y));
      return json(res, {
        summaries: cfg.fields.map(f => summary(f.id)),
        yearTotals: want.length ? yearTotals(want) : {},
      });
    }
    if (p === '/api/calibration') return json(res, calibration(db, cfg) ?? {});
    if (p === '/api/export.csv') {
      const { from, to, fields } = exportRange(url);
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="rainfall_${from}_to_${to}.csv"`,
      });
      return res.end(csv(fields, from, to));
    }

    // --- Sync between instances ---
    if (p === '/api/export.json') {
      const { from, to, fields, sources } = exportRange(url);
      const bundle = buildExport(db, cfg, { from, to, fields, sources });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="rainmonitor_${from}_to_${to}.json"`,
      });
      return res.end(JSON.stringify(bundle, null, 1));
    }

    if (p === '/api/import') {
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'importing is restricted to localhost');
      const body = await readBody(req, 64e6);
      const live = readConfig();
      let result;
      try {
        // One transaction: a half-applied merge is worse than a rejected one,
        // because nothing on screen would say which half landed.
        db.exec('BEGIN');
        try {
          result = applyImport(db, live, body.bundle ?? body, {
            createMissingFields: !!body.createMissingFields,
            importGauges: body.importGauges !== false,
          });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
      }
      writeConfig(live);
      cfg = live;
      syncFields(db, cfg.fields);
      linkManualGauges(db, cfg);
      // Imported station readings change which gauge is nearest-reporting on a
      // given day, so the per-field figures are recomputed rather than trusted
      // from the sending machine, whose exclusions are not ours.
      const derived = rederiveAfterImport(db, cfg);
      // Station readings only become a field's gauge figure once that field has
      // gauges mapped to it. On an instance that has never run discover they
      // arrive and sit there, which looks like the import silently did nothing.
      const unmapped = cfg.fields
        .filter(f => !db.prepare('SELECT 1 FROM field_station WHERE field_id = ? LIMIT 1').get(f.id))
        .map(f => f.name);
      if (unmapped.length) jobs.start('discover', { note: `mapping gauges for ${unmapped.join(', ')}` });
      return json(res, { ok: true, ...result, derived, unmapped, needsDiscover: unmapped.length > 0 });
    }

    // --- Whole-machine backup and restore ---
    // Distinct from the sync above: that merges a date range, this replaces
    // everything. Localhost only — the file carries the entire config,
    // including the station's address.
    if (p === '/api/backup.json') {
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'backups are restricted to localhost');
      const bundle = await buildBackup(db, cfg);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="rainmonitor-backup_${today()}.json"`,
      });
      return res.end(JSON.stringify(bundle));
    }

    if (p === '/api/restore') {
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
      if (!isLocal(req)) return send(res, 403, 'text/plain', 'restoring is restricted to localhost');
      if (jobs.status().running)
        return send(res, 409, 'application/json', JSON.stringify({
          error: 'A rainfall pull is running. Let it finish, then restore.' }));

      let bundle;
      try {
        // The browser posts the file's own text, so the whole database never
        // has to be parsed and re-serialised on that side just to add a flag.
        bundle = await readBody(req, 256e6);
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message }));
      }
      const problem = versionProblem(bundle, await headCommit());
      if (problem && !url.searchParams.get('force'))
        return send(res, 409, 'application/json', JSON.stringify({
          error: `Restore stopped: ${problem}`, versionProblem: problem }));

      let safety = null, counts;
      try {
        safety = await writeSafetyCopy(db, cfg);
        counts = applyBackup(db, bundle);
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message, safetyCopy: safety }));
      }
      writeConfig(bundle.config);
      cfg = readConfig();
      // The restored config may put the dashboard on a different port, in which
      // case the page waiting for the restart would wait forever. Say where it
      // went instead of coming back silently somewhere else.
      const to = cfg.server ?? {};
      const moved = (to.port ?? 8787) !== port || (to.host ?? '127.0.0.1') !== host
        ? { host: to.host ?? '127.0.0.1', port: to.port ?? 8787 } : null;
      json(res, { ok: true, counts, safetyCopy: safety, forced: !!problem, versionProblem: problem, serverMoved: moved, restarting: true });
      setTimeout(restart, 250);
      return;
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

/**
 * Restarting after an update hands the port from the old process to the new
 * one, and the old socket lingers for a moment after exit. Retrying the bind
 * covers that gap; without it the update would look like it worked and leave
 * nothing listening.
 */
let bindTries = 30;
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  if (bindTries-- <= 0) {
    console.error(`Port ${port} is already in use — another Rain Monitor is probably running.`);
    process.exit(1);
  }
  setTimeout(() => server.listen(port, host), 500);
});

server.listen(port, host, () => {
  console.log(`rainmonitor -> http://${host}:${port}`);
  jobs.startScheduler();
  updates.startScheduler();
});

/** Hand off to a fresh process, which is what actually loads the new code. */
function restart() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });
  child.unref();
  server.close();
  setTimeout(() => process.exit(0), 300).unref?.();
}
