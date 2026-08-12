# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Per-field rainfall tracking for farms. Pulls several independent weather sources
daily, stores everything in local SQLite, serves a loopback dashboard.

**Zero npm dependencies, deliberately.** There is no `node_modules`, no build
step, no bundler, no test framework and no linter. Adding a dependency is a
design change, not a convenience — the target machine is a farm office computer
where `npm install` failing is a dead end. It relies on built-in `node:sqlite`,
so **Node >= 22.5** is a hard requirement.

All source is ESM (`"type": "module"`), plain `.js`, no TypeScript.

## Commands

```bash
npm run init            # copy config.example.json -> config.json, detect region
npm run serve           # dashboard + API + in-process scheduler on 127.0.0.1:8787
npm run discover        # map each field to nearby gauges (network round trips)
npm run ingest          # pull the last `ingest.revisitDays` (default 10)
npm run backfill 400    # pull N days of history
npm run check [field]   # date-alignment diagnostic: cross-correlate vs MRMS at lags -2..+2
npm run calibrate       # on-farm gauge vs MRMS/PRISM, split warm/cold season
npm run fields | add-field | update-field | remove-field | export | import
npm run backup          # config.json + every table, one file
npm run restore -- --file f.json   # REPLACES everything; same commit required
```

`Setup.cmd` (Windows, double-click) runs `scripts/setup.ps1`: Node version gate,
config creation, login autostart, desktop `.url` shortcut. `Setup.cmd -Remove`
undoes it; `-IngestTask` registers a daily scheduled ingest for logged-out
machines.

**There is no test suite.** Verify changes by running the affected CLI command
against the real config, or by opening the dashboard. `npm run check` is the
regression test that matters for ingest correctness — it catches a source
silently changing its date convention, which no unit test or API response would
show. Re-run it after touching any `src/sources/*` parsing.

## Architecture

### config.json is the source of truth; the DB is a cache of it

`config.json` (gitignored) holds fields, manual gauges, per-field exclusions,
region and source settings. `data/rain.db` holds observations. The `field` table
is *synced from config* by `syncFields()`, which **prunes** fields no longer in
config along with their `obs` and `field_station` rows.

Any code path that writes config must follow this order:

```js
const live = readConfig();   // re-read from disk, don't mutate the in-memory cfg
mutate(live);                // addField / setExclusions / upsertManualGauge ...
writeConfig(live);
cfg = live;                  // server.js holds cfg in a module-level binding
syncFields(db, cfg.fields);  // + linkManualGauges / deriveField as applicable
```

`src/server.js` caches `cfg` at startup and hands `() => cfg` to `jobs` and
`updates`, so forgetting the reassignment leaves background work running against
a stale config.

### Raw vs derived is the central invariant

- **Raw**, fetched: `station_obs` (per-station daily), `station_monthly`,
  and the gridded rows in `obs` (`mrms`, `prism`, `iemre`, `rfcqpe`).
- **Derived**, computed: the `gauge` and `manual` rows in `obs`. `src/derive.js`
  rebuilds them from `station_obs` — nearest linked, non-excluded station that
  actually reported that day.

`deriveField()` **deletes and re-inserts** rather than upserting, inside one
transaction, because an exclusion has to be able to *remove* a day's value.
This is why excluding a gauge changes the past as well as the future, and why
most feeds never need refetching to correct a number.

Never export, import or trust a derived row from elsewhere: `src/sync.js` ships
raw rows only and calls `rederiveAfterImport()`, because the receiving machine
may rank or exclude gauges differently.

### Two transfer paths, and they must not be conflated

- `src/sync.js` — **merge** a date range between machines that are both
  collecting. Raw rows only, never destructive, re-derives on arrival.
- `src/backup.js` — **replace** everything: `config.json` plus every table, for
  standing a new machine up as a copy of another. Derived rows travel too,
  because the whole config travels with them, so the answer to "which gauge
  counts here" is the same one.

A backup writes rows straight back into the tables they came from, so source and
target must be on the **same commit** (`headCommit()` in `src/update.js`, checked
by `versionProblem()`). Column names are re-checked against `PRAGMA table_info`
even so, because `--force` exists for zip installs with no version to compare.
`writeSafetyCopy()` dumps the current state to `data/backups/` before anything is
overwritten. When a restored `config.json` moves `server.port`, the response says
so — otherwise the page waiting on the restart waits forever.

### Exclusions live in two places on purpose

- `field.exclude.stations` → `field_station.excluded` → applied at **derive**
  time (`setStationExclusions` + `deriveField`). Excluding a station promotes the
  next in range, which needs the full station catalogues — hence the background
  `discover` job.
- `field.exclude.sources` → applied at **read** time in `server.js:series()`,
  which blanks the column so every downstream view (tiles, charts, CSV) honours
  it from one place and the rows survive for when it is turned back on.

### `null` is not `0`

`cleanPrecipIn()` in `src/util.js` is load-bearing: `Number(null)` and
`Number('')` are both `0`, so a gauge that did not report would otherwise become
a confident "0.00 in". Missing must stay missing everywhere — parsers, the manual
reading endpoint (blank deletes the row rather than storing zero), and imports.

### Every source module documents an upstream trap

`src/sources/*` comments record verified upstream misbehaviour, with dates and
correlation figures. Read them before changing a parser; each one turns a
confident wrong number into an error or a missing value:

| Module | Trap |
|---|---|
| `iemre.js` | a range crossing a calendar year returns HTTP 200 and **one** row — requests are split at year boundaries |
| `ksmesonet.js` | reports **millimetres** and ignores `units=`; answers bad station names with HTTP 200 + `Error:` text; stamps a day's total at the **end** of the window (shifted −1 day) |
| `rfcqpe.js` | **no archive** — rolling windows only, so a missed day is permanently lost; window snapshots go to `field_window` to keep the gap visible |
| `weatherlink.js` | `NOAAMO.txt` holds only the current month and is overwritten at month roll; `NOAAYR.txt` monthly totals are the series that backfills |
| `iemgauge.js` | IEM returns `null` for a station that did not report |

A short/empty response is logged as a failure (`ingest_log`) rather than allowed
to become a dry year. `discoverStations()` similarly carries over the prior links
of any network whose catalogue fetch failed, so one timeout cannot silently
unlink a network from every field.

### Scheduling is catch-up, not clock-based

`src/jobs.js` runs jobs **in the dashboard process** (they are mostly waiting on
HTTP, and a child process would be a second SQLite writer). Every 15 minutes it
checks whether the last `ingest_log` entry is older than `ingest.intervalHours`
and pulls if so — a fixed daily task on a machine that is off at that hour never
runs. Identical pending jobs collapse instead of stacking.

`src/update.js` is git-based self-update: fetch-then-compare (never `git pull`),
`merge --ff-only`, refuses outright if `git diff --name-only HEAD` is non-empty,
then `server.js:restart()` spawns a detached fresh process and the old one exits.
Everything about it fails soft — no git, no upstream, or offline means "updates
unavailable" plus one sentence, not an error.

### HTTP layer

`src/server.js` is one `createServer` handler with a path `if`-chain, a static
file server for `web/`, and no framework. Every mutating endpoint is gated on
`isLocal(req)` even though the default bind is loopback, because `server.host` is
user-editable. Static paths are traversal-guarded with `startsWith(WEB)`.

`web/` is vanilla JS with hand-built inline SVG charts (`web/app.js`), no
framework and no bundler — it is served as-is.

## Conventions worth keeping

- **Dates are local-calendar ISO strings** (`YYYY-MM-DD`) end to end. Use the
  `today` / `addDays` / `daysBetween` / `isoDate` helpers in `src/util.js`; they
  build `Date` objects with local components on purpose. Don't switch to UTC
  arithmetic — a 6pm storm would land on the wrong day.
- **`SOURCES` in `src/util.js` is the registry** of per-field daily series, and
  its order is display order. Adding a source means: a module in `src/sources/`,
  wiring in `src/ingest.js`, an entry in `SOURCES`, a section in
  `config.example.json`, and — if it should be charted — `ALL_SERIES` in
  `web/app.js` plus a `--series-*` colour in `web/style.css`. (`iemre` is stored
  and exportable but intentionally not charted.)
- **Migrations are idempotent and run on every `openDb()`**: `CREATE TABLE IF
  NOT EXISTS` plus `addColumn()` in `src/db.js:migrate()`. There is no migration
  runner and no version number; whichever process opens the db first upgrades it.
- **Never call `process.exit()` in `src/cli.js`.** Exiting while an HTTP
  keep-alive socket is closing trips a libuv assertion on Windows and turns a
  successful run into exit code 9. Set `process.exitCode` and return.
- **Comments explain *why*, especially where the obvious code is wrong.** The
  codebase is dense with load-bearing rationale about upstream behaviour and
  farm-office constraints. Match that: when fixing something subtle, leave the
  reason behind, not just the fix.
- **Linking a station you own is arithmetic, not discovery.** `discoverStations()`
  downloads three catalogues and rewrites every link; `linkManualGauges()` and
  `linkOnFarmStation()` touch one network each using coordinates already in
  `config.json`, so adding a gauge or a weather station from the dashboard cannot
  be blocked by a timeout. Both also handle the *unlinking* case — an empty list
  clears that network's rows — so removing one takes effect without a rediscovery.
- **There is one on-farm station, not a list** (`sources.weatherlink`). It is the
  reference `src/calibration.js` measures the grid against, and a second one
  would raise "which is the reference". Its `stationId` is derived once from the
  name and never changes on a rename: it is what every `station_obs` row and
  every `exclude.stations` entry is filed under.
- Sources stay separate rows in `obs`; **the disagreement between them is the
  product**. Do not add anything that averages them into one number.
