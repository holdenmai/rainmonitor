import { discoverStations } from './stations.js';
import { ingest } from './ingest.js';
import { today, addDays } from './util.js';

/**
 * The data collection runs inside the dashboard.
 *
 * The alternative — a scheduled task plus `npm run ingest` — asks a farmer to
 * keep a command line healthy to keep the rain record from developing holes,
 * and two of these sources publish no archive, so a hole is permanent. If the
 * dashboard is the thing that opens at login, it should be the thing that keeps
 * itself current.
 *
 * Jobs run in this process rather than a child: they are almost entirely
 * waiting on HTTP, so they interleave with page requests, and there is no
 * second writer to fight over the SQLite lock.
 */
const MAX_LINES = 200;

export function createJobs(db, getCfg) {
  const state = { running: null, queue: [], last: {} };

  const KINDS = {
    discover: {
      label: 'Mapping gauges to fields',
      run: async (log) => {
        const cfg = getCfg();
        await discoverStations(db, cfg, log);
      },
    },
    ingest: {
      label: 'Checking for new rainfall',
      run: async (log, opts) => ingest(db, getCfg(), { log, onlyFields: opts.fields }),
    },
    backfill: {
      label: 'Pulling past rainfall',
      run: async (log, opts) => {
        const cfg = getCfg();
        const days = Number(opts.days) || cfg.ingest?.backfillDays || 400;
        return ingest(db, cfg, { sdate: addDays(today(), -days), log, onlyFields: opts.fields });
      },
    },
    // A newly added on-farm station. Linking it to fields is instant, but its
    // reports still have to be read. Back to the first of the month, because
    // NOAAMO.txt carries the whole current month and is overwritten at month
    // roll — this is the one chance to capture all of it.
    station: {
      label: 'Reading the weather station',
      run: async (log) => ingest(db, getCfg(), { sdate: `${today().slice(0, 7)}-01`, log }),
    },
    // What adding or moving a field used to require two npm commands for.
    newfield: {
      label: 'Setting up the new field',
      run: async (log, opts) => {
        const cfg = getCfg();
        await discoverStations(db, cfg, log);
        const days = Number(opts.days) || cfg.ingest?.backfillDays || 400;
        await ingest(db, cfg, { sdate: addDays(today(), -days), log, onlyFields: opts.fields });
      },
    },
  };

  const push = line => {
    if (!state.running) return;
    state.running.lines.push(String(line));
    if (state.running.lines.length > MAX_LINES) state.running.lines.splice(0, state.running.lines.length - MAX_LINES);
  };

  async function drain() {
    if (state.running || !state.queue.length) return;
    const job = state.queue.shift();
    state.running = { ...job, started: new Date().toISOString(), lines: [] };
    try {
      await KINDS[job.name].run(push, job.opts ?? {});
      state.last[job.name] = { at: new Date().toISOString(), ok: true, note: job.note, lines: state.running.lines };
    } catch (e) {
      push(`FAILED: ${e.message}`);
      state.last[job.name] = { at: new Date().toISOString(), ok: false, note: job.note, error: e.message, lines: state.running.lines };
    } finally {
      state.running = null;
      // Let the loop unwind before the next job, so a queue of them cannot
      // starve the HTTP handlers.
      setTimeout(drain, 0);
    }
  }

  /**
   * Queue a job. Identical pending work collapses rather than stacking up —
   * clicking "update now" three times should mean one update, and two fields
   * added in a row need one remap between them, not two.
   */
  function start(name, { opts = {}, note = null, dedupe = true } = {}) {
    if (!KINDS[name]) throw new Error(`unknown job "${name}"`);
    const same = j => j.name === name && JSON.stringify(j.opts ?? {}) === JSON.stringify(opts);
    // `started` rather than `queued`: status() already has a `queued` list, and
    // spreading it over a boolean of the same name silently loses the answer.
    if (dedupe && (state.queue.some(same) || (state.running && same(state.running))))
      return { started: false, alreadyRunning: true, ...status() };
    state.queue.push({ name, label: KINDS[name].label, opts, note });
    setTimeout(drain, 0);
    return { started: true, ...status() };
  }

  function status() {
    return {
      running: state.running
        ? { name: state.running.name, label: state.running.label, note: state.running.note,
            started: state.running.started, lines: state.running.lines.slice(-40) }
        : null,
      queued: state.queue.map(j => ({ name: j.name, label: j.label, note: j.note })),
      last: state.last,
      lastIngestAt: lastRunAt(),
    };
  }

  const lastRunAt = () => db.prepare('SELECT MAX(ts) t FROM ingest_log').get()?.t ?? null;

  /**
   * Catch-up scheduling, not clock scheduling: run when the record is stale
   * rather than at a fixed hour. A farm computer is off as often as it is on,
   * and a fixed 7:15 task on a machine that boots at 9 simply never runs.
   */
  function startScheduler(log = console.log) {
    const cfg = getCfg();
    if (cfg.ingest?.auto === false) return log('Automatic updates are off (ingest.auto is false in config.json)');
    const hours = Number(cfg.ingest?.intervalHours) || 6;

    const stale = () => {
      const t = lastRunAt();
      if (!t) return true;
      return Date.now() - Date.parse(`${t.replace(' ', 'T')}Z`) > hours * 3600e3;
    };
    const tick = () => { if (stale()) start('ingest', { note: 'scheduled' }); };

    // A short delay at boot so the dashboard is answering requests before a
    // catch-up run starts competing for the network.
    setTimeout(tick, 20_000);
    setInterval(tick, 15 * 60_000).unref?.();
    log(`Automatic updates on: checking every 15 min, pulling when the last run is over ${hours}h old`);
  }

  return { start, status, startScheduler };
}
