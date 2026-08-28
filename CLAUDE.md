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
npm run publish [-- --no-upload|--full]   # build the static copy and FTP what changed
npm run check-publish   # does that copy still say what this machine says?
npm run check-ftp       # round-trip src/ftp.js against a loopback FTP server
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
  time (`setStationExclusions` + `deriveField`). Excluding a station does **not**
  promote the next in range: `discoverStations()` links the `gauges.listNearest`
  closest across all fetched networks and that list is fixed by distance, so
  unticking one only ever removes it. No remap is queued.
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

### The published copy is the same page, not a second one

`npm run publish` writes a static mirror for a host that can only serve files.
It works because `web/app.js` already draws every chart in the browser from four
GET payloads, so there is no renderer in `src/publish.js` — it writes those
payloads to disk and lets the *same* `app.js` draw the *same* charts.

- `src/views.js` holds `series`/`summary`/`csv`/`meta`/`yearsWithData` as a
  `createViews(db, getCfg)` factory (the `createJobs`/`createUpdates` idiom).
  Both `server.js` and `publish.js` answer from it, so the published page and
  the machine it came from cannot disagree about a number.
- `web/app.js` runs in both homes: `STATIC = !!window.RM_STATIC` and every
  read goes through `apiGet`. All the mutating wiring is grouped in
  `wireAdmin()` and skipped — not guarded — because the markup it reaches for is
  **cut out** of the published HTML at the `<!-- publish:admin start/end -->`
  markers in `web/index.html`. Move a card between the halves by moving a marker.
- **Values are published at stored precision, never at display precision.**
  Rounding to the two decimals the page prints looks free and is not: MRMS
  reported 0.185 in on 2026-08-11, which `Math.round(v*100)/100` makes 0.19 and
  the page's own `toFixed(2)` makes 0.18 — and every cumulative total shifts,
  because those sum raw values and round once at the end. It saved 3%.
- The series splits at January 1st (`history.json` / `current.json`) so a daily
  upload is 72 KB rather than 4.7 MB. Split by *era*, not by resolution: every
  row stays daily, so the remote charts are the same charts.
- Redaction is a setting, not a habit: `publish.coordinates` drops field lat/lon
  **and** `dist_km`, because a named field plus a named gauge plus "4.2 mi" is a
  location. Dropping `gauge_src`/`manual_src` is free — nothing in `web/app.js`
  reads them — and removes the only free-text distance in the payload.
- `npm run check-publish` is the regression test that matters here, the way
  `npm run check` is for ingest. It decodes the build the way `web/static.js`
  does — a deliberate second implementation, since re-using the encoder to check
  the encoder would pass whatever either of them did.

### `src/ftp.js`, and why the test is on the wire

Zero dependencies means writing the FTP client. It handles four upstream traps,
documented in the module: multiline replies, `EPSV` before `PASV` (and ignoring
PASV's advertised address, which is wrong behind NAT), waiting for **both** the
226 and the data socket's close, and resuming the control connection's TLS
session on the data channel. **SFTP is out of reach** — it is SSH, which cannot
be implemented here without a dependency.

The TLS session is captured two ways on purpose: `getSession()` covers TLS 1.2,
and the `'session'` event covers 1.3, where the ticket only arrives *after* the
handshake and `getSession()` returns null. Read it one way and vsftpd's
`require_ssl_reuse=YES` refuses every transfer with a bare `425`.

`npm run check-ftp` stands a deliberately awkward FTP server up on loopback and
round-trips real files through it. Two things about it are load-bearing:

- **The reuse check reads the ClientHello bytes**, not Node's
  `isSessionReused()`. Two in-process Node TLS servers sharing ticket keys would
  not report a resumption even to themselves, so a test built on that API would
  have passed or failed for reasons unrelated to this client.
- **The legacy session id is not a resumption signal under TLS 1.3.** A 1.3
  client fills it with 32 random bytes on every handshake for middlebox
  compatibility. Treating it as one made the check pass against a client with
  session-passing deliberately deleted — which is how the mistake was caught, and
  why any change there should be re-verified by breaking the client on purpose.

Publishing fails soft, like `src/update.js`: no host, wrong password or a dead
connection is recorded in the job log and never fails the ingest that queued it.

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
  `config.example.json`, and — if it should be charted — `GRID_SERIES` in
  `web/app.js` plus a `--series-*` colour in `web/style.css`. (`iemre` is stored
  and exportable but intentionally not charted.)
- **The charts draw individual gauges, not the derived `gauge` series.**
  `series()` adds a `g:<network>|<station>` column per counting gauge straight
  from `station_obs`; `obs.gauge` stays as the one-number-per-field answer the
  all-fields chart, the calibration and the CSV need. Charted gauges are capped
  at `GAUGE_SLOTS` (4) and the rest are named in the response's `uncharted`, so
  the cap is stated rather than silent.
- **The comparison is encoded by position and stroke, never by hue.** Whichever
  kind it is, the other side is folded onto the same rows as `c:<key>` columns
  (`mergeCompare`), the daily chart mirrors it *below* the baseline on the same
  scale, and the cumulative chart overlays it dashed in the same colour per
  source. One of the readers is colourblind, so a shifted or faded hue is not
  available: shift it far enough to see and the two stop reading as the same
  series. The fade (`CMP_FADE`) is a third signal on top of position, never the
  only one.
- **Which year the window sits in is separate from what it is compared against.**
  The "Year" picker slides the whole range bodily into another year keeping its
  month-days (`rangeWindow(year)`), so a comparison can be 1996 against 1988 with
  neither side being now. Doing the shift on the window rather than inside the
  comparison is what makes both halves the same kind of thing. When a past year
  is on screen the KPI tiles get one extra tile for that year, because every
  other tile is a window ending *today* and always will be.
- **"Compare with" is one picker holding both kinds, `y:1996` or `f:north80`.**
  Two fields *and* two years at once is four lines per source, which is a
  thicket rather than a comparison; a single select is the one control that
  cannot be in both states at once, so the limit needs no rule to enforce it.
  A year comparison matches on month-day and **is disabled above a 366-day
  range** (`overAYear` in `load()`) — month-day stops being a unique key the
  moment a window can hold the same calendar square twice, so that is a
  correctness limit, not a missing feature. A field comparison matches on the
  date itself and has no such limit.
- **Two fields are compared on the derived `gauge` column, not gauge by gauge**
  (`fieldSeries` in `web/app.js`) — the one place that column is charted, and the
  right one: this field's nearest station and that one's are different ground, so
  pairing them by slot would put two stations under one colour and call it the
  same series. Its colours are the palette's validated two-gauge prefix
  (`--series-gauge` *is* `--series-g1`, manual takes g2).
- **The all-fields bars are whole calendar years when two years are compared**,
  from `views.yearTotals()` — `total` and `ytd` per field per year, plus the
  `src` that answered, since radar does not exist before ~2014. Deliberately not
  the window the charts above use: this card is answered from one pre-built file
  so the published copy can draw it too, and an arbitrary window for every field
  would mean shipping every field's daily history to the browser to draw one bar
  apiece. The heading and note say which window it is rather than pretending.
- **`yearTotals()` is asked for by year, and that is a performance requirement,
  not a nicety.** Its GROUP BY key is computed (`substr(date, 1, 4)`), so no
  index can serve it and every year means a full scan of `obs` — 390k rows,
  2.8s through the live connection here and over 50s as it landed in the
  browser. Naming the years turns it into a `MULTI-INDEX OR` range scan on
  `obs_date_idx`: 29ms.
  `/api/summary` is fetched on **every** field, range and comparison change, so
  it passes `?years=` and answers `{}` when nothing on the page needs a total.
  Only `src/publish.js` asks for every year, once per build, where the cost sits
  beside encoding 4.7 MB of history anyway. A covering index on
  `(source, field_id, date, precip_in)` was measured and is *slower* (525ms vs
  270ms) as well as 13 MB — don't add it.
- **The legend is also the chart's controls.** Clicking a series takes it off
  both upper charts (`hiddenSeries` + `renderCharts()`); it is held in memory
  only, so a reload brings it back. That is deliberately *not*
  `exclude.sources`, which is permanent and changes every number on the page and
  in the CSV. A hidden series stays in the legend struck through — it must not
  become indistinguishable from one that has no data to draw.
- **History goes back to 1981, and the sources stop at different depths.**
  Verified 2026-08-15 against the farm's own coordinates: PRISM returns a value
  for every day from 1981; IEMRE reaches at least to 1950; MRMS is modern only
  (~2014). `ingest()` drives `yearChunks()` itself rather than letting
  `fetchIemre` concatenate, so each year is written before the next is asked
  for — a forty-year backfill that dies in 1997 keeps 1981-1996 and re-running
  resumes. Absent sources stay `null`: a `0` before 2014 would be a confident
  claim that a decade was bone dry. Charts bin by span — day / week / calendar
  month / calendar year (`binFor`) — and the cumulative chart spaces points by
  position rather than date, so `load()` names any year with no rows instead of
  drawing the gap closed.
- **How far back to pull is config, not a button, because the new-field path
  needs the same answer.** `ingest.historyFromYear` is set from the Data
  collection card and resolved by `historyStart()` in `src/util.js`; the legacy
  `backfillDays` still reads correctly when the year is unset, so an older
  config keeps its meaning rather than silently becoming 1981. Both the
  `backfill` and `newfield` jobs go through `resolveStart()` — a quarter section
  added to a farm holding forty years should arrive holding forty years, and
  that was the bug before this existed. `resolveStart()` deliberately does not
  clamp to 1981: that floor belongs to the gridded sources, while the same run
  also pulls COOP gauges that predate it.
- **The series palette is validated per prefix, not once.** A field draws a
  different number of gauge series, so `--series-g1..g4` followed by rfcqpe /
  prism / mrms was ordered so that *every* prefix clears the adjacent-pair CVD
  and normal-vision gates in both themes. That is why `SOURCES` has prism before
  mrms — yellow next to orange fails, aqua between them passes. Re-run the
  dataviz validator before touching any `--series-*` value or the display order.
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
- **The default tick state lives in the DB, not in config.** A field that has
  never been mapped gets `excluded = 1` on everything past `gauges.countNearest`,
  and nothing is written to `config.json` for it — so `renderExclusions()` reads
  the ticks from `field.stations[].excluded`, not from `exclude.stations`, and
  the first toggle writes the *whole* state out. Reading config there would draw
  every box ticked while the charts used two. The default is skipped for any
  field that already has `field_station` rows, which is what keeps a re-discover
  on a running install from changing what counts there.
- **Distances are computed in km and displayed in miles, always.** `haversineKm`
  and `field_station.dist_km` stay metric — internal units nobody reads. Every
  user-facing distance goes through `fmtMi()` (`src/util.js`) or `mi()`
  (`web/app.js`), including the `obs.detail` string `deriveField()` writes.
  Config ranges are `maxDistanceMi`; `rangeKm()` still reads a legacy
  `maxDistanceKm` **as kilometres**, because reinterpreting a 60 that meant km
  as 60 miles would widen a field's net by half in silence.
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
