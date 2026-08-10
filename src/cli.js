import { readFileSync, writeFileSync } from 'node:fs';
import { openDb, syncFields } from './db.js';
import { today, addDays } from './util.js';
import { discoverStations, linkManualGauges } from './stations.js';
import { ingest } from './ingest.js';
import { buildExport, applyImport, rederiveAfterImport } from './sync.js';
import {
  ensureConfig, readConfig, writeConfig, autoDetectRegion,
  addField, updateField, removeField, CONFIG_PATH,
} from './setup.js';

const [, , cmd, ...rest] = process.argv;

/** --name "North 80" --lat 39.4 --lon -101.0 --acres 160 --farm "Home Place" */
function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

const usage = () => console.log(`rainmonitor

  npm run init                 create config.json and detect your region
  npm run discover             map each field to its nearest rain gauges
  npm run ingest               pull recent days (what the scheduled task runs)
  npm run backfill [days]      pull history (default 400 days)
  npm run serve                start the local dashboard

  npm run fields                                       list your fields
  npm run add-field -- --name "North 80" --lat 39.4 --lon -101.05 [--acres 160] [--farm "Home Place"]
  npm run update-field -- --id north-80 --acres 155 --farm "Home Place"
  npm run remove-field -- --id north-80

  npm run export -- --days 14 [--from D] [--to D] [--sources rfcqpe] [--out file.json]
  npm run import -- --file file.json [--create-fields]

Fields are easiest to manage from the dashboard: npm run serve, then "Fields".`);

/**
 * Everything runs inside main() and returns rather than calling process.exit().
 * Exiting abruptly while an HTTP keep-alive socket is still closing trips a
 * libuv assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`), which
 * turns a successful run into a crash with exit code 9.
 */
async function main() {
  if (cmd === 'init') {
    const created = ensureConfig();
    const cfg = readConfig();
    console.log(created ? 'Detecting your region from the example fields...'
                        : 'config.json exists — refreshing region detection...');
    await autoDetectRegion(cfg);
    writeConfig(cfg);
    console.log(`\nWrote ${CONFIG_PATH}`);
    console.log(created
      ? '\nNext: replace the example fields with your own —\n'
        + '  npm run serve   (then use the Fields panel)\n'
        + '  or: npm run add-field -- --name "North 80" --lat 39.4 --lon -101.05'
      : '\nNext: npm run discover');
    return;
  }

  // Every other command needs a config; create one rather than crash on a
  // fresh clone.
  if (ensureConfig()) console.log('(run `npm run init` to detect your region)\n');
  const cfg = readConfig();

  if (cmd === 'fields') {
    if (!cfg.fields.length) {
      console.log('No fields yet. Add one with: npm run add-field -- --name "..." --lat .. --lon ..');
      return;
    }
    for (const f of cfg.fields)
      console.log(`  ${f.id.padEnd(18)} ${String(f.name).padEnd(20)} ${String(f.farm ?? '—').padEnd(16)} `
        + `${f.lat}, ${f.lon}${f.acres ? `  ${f.acres} ac` : ''}`);
    return;
  }

  if (cmd === 'add-field' || cmd === 'remove-field' || cmd === 'update-field') {
    const a = flags(rest);
    try {
      if (cmd === 'add-field') {
        const f = addField(cfg, a);
        await autoDetectRegion(cfg);
        writeConfig(cfg);
        console.log(`Added "${f.name}" (${f.id}). Now run: npm run discover && npm run backfill`);
      } else if (cmd === 'update-field') {
        const f = updateField(cfg, a.id, a);
        writeConfig(cfg);
        console.log(`Updated ${f.id}. Now run: npm run discover`);
      } else {
        const f = removeField(cfg, a.id);
        writeConfig(cfg);
        console.log(`Removed "${f.name}". Its stored observations are dropped on the next discover/ingest.`);
      }
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  // Export/import move a date range between machines. With more than one
  // computer running this, a scheduled export to a shared folder plus an import
  // on each of the others keeps them level without any of them being a server.
  if (cmd === 'export' || cmd === 'import') {
    const a = flags(rest);
    const db = openDb();
    try {
      if (cmd === 'export') {
        const to = a.to ?? today();
        const from = a.from ?? addDays(to, -Number(a.days || 14));
        const split = s => (s ? String(s).split(',').map(x => x.trim()).filter(Boolean) : []);
        const bundle = buildExport(db, cfg, { from, to, sources: split(a.sources), fields: split(a.fields) });
        const out = a.out ?? `rainmonitor_${from}_to_${to}.json`;
        writeFileSync(out, JSON.stringify(bundle, null, 1));
        console.log(`Wrote ${out}: ${bundle.obs.length} observations, ${bundle.stationObs.length} station readings, `
          + `${from} -> ${to}, ${bundle.fields.length} fields.`);
      } else {
        if (!a.file) throw new Error('need --file <export.json>');
        const bundle = JSON.parse(readFileSync(a.file, 'utf8'));
        let r;
        db.exec('BEGIN');
        try {
          r = applyImport(db, cfg, bundle, { createMissingFields: a['create-fields'] === 'true' });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        writeConfig(cfg);
        syncFields(db, cfg.fields);
        linkManualGauges(db, cfg);
        rederiveAfterImport(db, cfg);
        console.log(`Merged ${a.file}: ${r.obs} new, ${r.obsUpdated} revised, ${r.readings} new station readings, `
          + `${r.skipped} already current.`);
        if (r.addedFields.length) console.log(`  created ${r.addedFields.length} field(s) — run: npm run discover`);
        if (r.unknownFields.length)
          console.log(`  skipped data for fields this machine does not have: ${r.unknownFields.join(', ')}`
            + ' (re-run with --create-fields to add them)');
      }
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
    return;
  }

  if (!['discover', 'ingest', 'backfill'].includes(cmd)) return usage();

  const db = openDb();
  try {
    if (cmd === 'discover') {
      console.log('Discovering gauges near each field...');
      const before = JSON.stringify([cfg.region, cfg.sources?.iem_gauge?.networks]);
      await autoDetectRegion(cfg);
      if (JSON.stringify([cfg.region, cfg.sources?.iem_gauge?.networks]) !== before) writeConfig(cfg);
      for (const r of syncFields(db, cfg.fields))
        console.log(`  [prune] removed field "${r.name}" — no longer in config.json`);
      await discoverStations(db, cfg);
    } else if (cmd === 'ingest') {
      await ingest(db, cfg);
    } else {
      const days = Number(rest[0]) || cfg.ingest?.backfillDays || 400;
      await ingest(db, cfg, { sdate: addDays(today(), -days) });
    }
  } finally {
    db.close();
  }
}

await main();
