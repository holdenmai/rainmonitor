import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './util.js';
import { CONFIG_PATH } from './setup.js';
import { headCommit } from './update.js';
import { transact } from './db.js';

export const BACKUP_FORMAT = 'rainmonitor-backup/1';

/**
 * A whole-machine copy: config.json plus every table, in one file.
 *
 * This is not the same job as src/sync.js, and conflating them would make both
 * worse. Sync MERGES a date range between two machines that are each collecting
 * their own data and each entitled to their own answer about which gauge counts
 * for a field. A backup REPLACES: it is for standing up a second computer, or
 * moving to a new one, and "restore my backup" that quietly left the target's
 * own leftovers in place would not be a restore at all.
 *
 * Because it writes rows straight back into the tables they came from, source
 * and target have to be on the same commit — see `versionProblem`.
 */
export const TABLES = [
  'field', 'station', 'field_station', 'obs', 'station_obs',
  'station_monthly', 'field_window', 'app_meta', 'ingest_log',
];

const columnsOf = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);

export async function buildBackup(db, cfg = null) {
  const config = cfg ?? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const tables = {}, schema = {};
  for (const t of TABLES) {
    schema[t] = columnsOf(db, t);
    tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  return {
    format: BACKUP_FORMAT,
    generatedAt: new Date().toISOString(),
    // Recorded in the file rather than left for somebody to remember, because
    // the restore refuses without it.
    commit: await headCommit(),
    schema, config, tables,
  };
}

export const backupCounts = bundle =>
  Object.fromEntries(TABLES.map(t => [t, bundle.tables?.[t]?.length ?? 0]));

const short = s => String(s).slice(0, 7);

/**
 * Why the versions have to match: a restore writes rows straight into the
 * tables they were read from. Same commit means the same schema and the same
 * meaning for every column — which is the only thing that makes that safe
 * without a migration path between every pair of versions anyone has installed.
 *
 * Returns a sentence describing the problem, or null when it is safe.
 */
export function versionProblem(bundle, here) {
  const there = bundle?.commit ?? null;
  if (!there?.sha && !here?.sha)
    return 'neither this copy nor the backup was installed with git, so their versions cannot be compared';
  if (!there?.sha) return 'the backup does not record which version it was made on';
  if (!here?.sha) return 'this copy was not installed with git, so its version cannot be checked';
  if (there.sha !== here.sha)
    return `the backup was made on version ${short(there.sha)} (${there.date ?? 'unknown date'}) and this copy `
      + `is on ${short(here.sha)}. Update both machines to the same version, then take a fresh backup.`;
  return null;
}

/**
 * Replace every table with the backup's rows. One transaction: a half-restored
 * machine is worse than a refused one, because nothing on screen would say
 * which half landed.
 */
export function applyBackup(db, bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.format !== BACKUP_FORMAT)
    throw new Error(`not a Rain Monitor backup (expected format "${BACKUP_FORMAT}")`);
  if (!bundle.config || typeof bundle.config !== 'object' || !Array.isArray(bundle.config.fields))
    throw new Error('the backup has no config.json in it');

  // Checked rather than trusted. The version check should already guarantee the
  // columns line up; this is what turns the one case it cannot catch — a forced
  // restore — into a clean refusal instead of a mangled database.
  for (const t of TABLES) {
    const rows = bundle.tables?.[t];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error(`the backup's "${t}" section is not a list of rows`);
    const have = new Set(columnsOf(db, t));
    const extra = [...new Set(rows.flatMap(r => Object.keys(r ?? {})))].filter(c => !have.has(c));
    if (extra.length)
      throw new Error(`the backup's "${t}" table has columns this version does not know about: ${extra.join(', ')}`);
  }

  const counts = {};
  transact(db, () => {
    for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
    for (const t of TABLES) {
      const rows = bundle.tables?.[t] ?? [];
      counts[t] = 0;
      if (!rows.length) continue;
      const cols = columnsOf(db, t).filter(c => rows.some(r => r && c in r));
      const ins = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of rows) { ins.run(...cols.map(c => r[c] ?? null)); counts[t]++; }
    }
  });
  return counts;
}

/**
 * Take a backup of what is here before overwriting it.
 *
 * Restoring the wrong file onto the wrong machine is a mistake somebody will
 * make while setting up three computers in an afternoon, and it is otherwise
 * unrecoverable. This costs a second and makes it undoable.
 */
export async function writeSafetyCopy(db, cfg = null) {
  const dir = join(ROOT, 'data', 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(dir, `before-restore-${stamp}.json`);
  writeFileSync(file, JSON.stringify(await buildBackup(db, cfg)));
  return file;
}
