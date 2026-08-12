import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './util.js';
import { getMeta, setMeta } from './db.js';

const run = promisify(execFile);

/**
 * Update the installation from git, if it came from git.
 *
 * Everything here is optional and fails soft. A copy downloaded as a zip has no
 * .git, a machine may not have git installed, and a farm office loses its
 * internet regularly — none of which is a reason for the dashboard to show an
 * error. Updates are simply unavailable, with one sentence saying why.
 *
 * The update itself is deliberately timid: fast-forward only, refused outright
 * if there are local edits. Resolving a merge conflict is exactly the situation
 * this whole feature exists to keep people out of.
 */
async function git(args, timeoutMs = 30_000) {
  const { stdout } = await run('git', args, {
    cwd: ROOT, timeout: timeoutMs, windowsHide: true, maxBuffer: 4e6,
  });
  return stdout.trim();
}

const COMMIT_FMT = '%h%x1f%ad%x1f%s';
const parseCommits = out => out.split('\n').filter(Boolean).map(line => {
  const [sha, date, subject] = line.split('\x1f');
  return { sha, date, subject };
});

/**
 * The exact commit this copy is running, or null if it did not come from git.
 *
 * The full sha rather than the short one: this is what a restore compares
 * against to decide whether a backup's database rows mean the same thing here
 * as they did on the machine that wrote them.
 */
export async function headCommit() {
  try {
    const [sha, date, subject] = (await git(['log', '-1', '--format=%H%x1f%ad%x1f%s', '--date=short'], 5000)).split('\x1f');
    if (!sha) return null;
    let branch = null;
    try { branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], 5000); } catch { /* detached, or no HEAD yet */ }
    return { sha, date, subject, branch };
  } catch {
    return null;
  }
}

/** What kind of installation is this, and can it be updated at all? */
export async function repoInfo() {
  try {
    await git(['--version'], 5000);
  } catch {
    return { updatable: false, reason: 'Git is not installed on this computer, so updates cannot be downloaded.' };
  }
  try {
    if ((await git(['rev-parse', '--is-inside-work-tree'], 5000)) !== 'true') throw new Error('not a work tree');
  } catch {
    return { updatable: false, reason: 'This copy was not installed with git, so there is nothing to update from.' };
  }

  const info = { updatable: true };
  try {
    info.branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
    const [sha, date, subject] = (await git(['log', '-1', `--format=${COMMIT_FMT}`, '--date=short'], 5000)).split('\x1f');
    info.current = { sha, date, subject };
  } catch { /* an empty repository has no HEAD yet */ }

  if (info.branch === 'HEAD')
    return { ...info, updatable: false, reason: 'This copy is not on a branch, so it cannot be updated automatically.' };

  try {
    info.upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 5000);
  } catch {
    return { ...info, updatable: false, reason: `The "${info.branch}" branch is not tracking anywhere to update from.` };
  }
  return info;
}

/**
 * Tracked files that differ from HEAD. Refusing to update over them is the
 * whole point.
 *
 * `diff --name-only` rather than `status --porcelain`: porcelain's leading
 * status column is significant whitespace, and this module trims command
 * output, so the first filename came back with a character bitten off it.
 * Untracked files are ignored on purpose — config.json and data/ are not
 * tracked, and neither obstructs a fast-forward.
 */
async function localEdits() {
  try {
    return (await git(['diff', '--name-only', 'HEAD'], 10_000)).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function createUpdates(db, getCfg) {
  let state = { checking: false, checkedAt: null, available: false, behind: 0, ahead: 0, commits: [], error: null };
  let applying = null;

  async function check({ force = false } = {}) {
    if (state.checking) return status();
    const cfg = getCfg();
    if (cfg.updates?.enabled === false) return status();

    const repo = await repoInfo();
    if (!repo.updatable) {
      state = { ...state, checking: false, available: false, repo, error: null };
      return status();
    }

    state.checking = true;
    try {
      // Fetch, then compare against what was fetched. `git pull` would do both
      // in one step, but that step also merges — the whole design here is that
      // looking is separate from changing.
      await git(['fetch', '--quiet', '--prune']);
      const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
      const [ahead, behind] = counts.split(/\s+/).map(Number);
      const commits = behind
        ? parseCommits(await git(['log', `--format=${COMMIT_FMT}`, '--date=short', '-n', '25', 'HEAD..@{u}']))
        : [];
      state = {
        checking: false, checkedAt: new Date().toISOString(), error: null,
        available: behind > 0, behind, ahead, commits, repo,
        edits: behind > 0 ? await localEdits() : [],
      };
      setMeta(db, 'updateCheckedAt', state.checkedAt);
    } catch (e) {
      // Offline is the common case, and it is not worth alarming anyone about.
      state = { ...state, checking: false, checkedAt: new Date().toISOString(), error: e.message, repo };
      setMeta(db, 'updateCheckedAt', state.checkedAt);
    }
    return status();
  }

  async function apply() {
    if (applying) return applying;
    applying = (async () => {
      const repo = await repoInfo();
      if (!repo.updatable) throw new Error(repo.reason);

      const edits = await localEdits();
      if (edits.length)
        throw new Error(`This copy has local changes to ${edits.slice(0, 3).join(', ')}`
          + `${edits.length > 3 ? ` and ${edits.length - 3} more` : ''}. `
          + 'Updating would overwrite them, so it has been stopped.');

      await git(['fetch', '--quiet', '--prune']);
      const [ahead, behind] = (await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']))
        .split(/\s+/).map(Number);
      if (!behind) return { updated: false, message: 'Already up to date.' };
      if (ahead)
        throw new Error(`This copy has ${ahead} change(s) of its own that are not published, `
          + 'so it cannot be fast-forwarded. Update it by hand with git.');

      // --ff-only, so a surprise can only ever be "it refused", never a merge
      // conflict left in the working tree of a machine nobody wants to debug.
      await git(['merge', '--ff-only', '@{u}']);
      const [sha, date, subject] = (await git(['log', '-1', `--format=${COMMIT_FMT}`, '--date=short'])).split('\x1f');
      state = { ...state, available: false, behind: 0, commits: [] };
      return { updated: true, count: behind, current: { sha, date, subject } };
    })().finally(() => { applying = null; });
    return applying;
  }

  /**
   * Status with the local repo details filled in. Reading which commit this is
   * costs a couple of local git calls and no network, so a dashboard opened
   * right after a restart can still say what version it is running instead of
   * going blank until the next daily check.
   */
  async function describe() {
    if (!state.repo) state.repo = await repoInfo();
    return status();
  }

  const status = () => ({
    ...state,
    lastCheckedAt: state.checkedAt ?? getMeta(db, 'updateCheckedAt'),
    intervalHours: Number(getCfg().updates?.checkIntervalHours) || 24,
    enabled: getCfg().updates?.enabled !== false,
  });

  /**
   * Checked on the same 15-minute tick as everything else, but only acted on
   * once the interval has genuinely elapsed — the timestamp lives in the
   * database, so restarting the dashboard ten times does not mean ten fetches.
   */
  function startScheduler(log = console.log) {
    const cfg = getCfg();
    if (cfg.updates?.enabled === false) return log('Update checking is off (updates.enabled is false in config.json)');

    const due = () => {
      const t = getMeta(db, 'updateCheckedAt');
      if (!t) return true;
      const hours = Number(getCfg().updates?.checkIntervalHours) || 24;
      return Date.now() - Date.parse(t) > hours * 3600e3;
    };
    const tick = () => { if (due()) check().catch(() => {}); };

    setTimeout(tick, 45_000);
    setInterval(tick, 15 * 60_000).unref?.();
    log(`Update checking on: at most once every ${Number(cfg.updates?.checkIntervalHours) || 24}h`);
  }

  return { check, apply, status, describe, startScheduler };
}
