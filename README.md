# Rain Monitor

Per-field rainfall tracking for farms. Pulls from several independent weather
sources every day, stores everything locally in SQLite, and serves a dashboard on
your own machine.

No accounts, no API keys, no subscription, **no npm dependencies** — and the
history is yours, in a file you can back up.

Built for US fields; the gridded sources cover the lower 48.

**Requires Node.js 22.5 or newer** — a free download from
[nodejs.org](https://nodejs.org) (press the LTS button). It uses the built-in
`node:sqlite`.

## Setting it up

**Windows — double-click `Setup.cmd`.** That is the whole install. It checks
Node, creates your `config.json`, sets the dashboard to start when you log in,
puts a **Rain Monitor** shortcut on your desktop, and opens it.

Then open the dashboard, scroll to **Fields**, and replace the two example
fields with your own. Every field you add maps its own nearby gauges and pulls
its own history by itself — there is nothing to run afterwards.

To undo it all: `Setup.cmd -Remove`. Your data and settings are left alone.

**macOS / Linux** — there is no installer; start the server however your system
starts things, and it takes care of the rest:

```bash
npm run init     # creates config.json
npm run serve    # http://127.0.0.1:8787 — add your fields here
```

A systemd user service keeps it running across reboots:

```ini
# ~/.config/systemd/user/rainmonitor.service
[Service]
ExecStart=/usr/bin/node /path/to/rainmonitor/src/server.js
WorkingDirectory=/path/to/rainmonitor
Restart=always
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now rainmonitor
loginctl enable-linger $USER   # keeps it running when you are not logged in
```

### Staying up to date

If this copy was installed with git and git is on the machine, the dashboard
checks once a day whether newer code has been published. When there is some, a
notice appears at the top of the page with a **What's new** list and an **Update
now** button that downloads it and restarts the dashboard. Your fields,
settings and rainfall history are untouched.

Nothing is ever applied without being asked. The update is fast-forward only and
**refuses outright if the copy has local edits**, because resolving a merge
conflict on a farm office computer is precisely the situation this is meant to
avoid. If you have deliberately changed the code, update it by hand with git.

No git, or installed from a zip? Everything else still works — the panel just
says updates are unavailable and why. Turn the checking off entirely with
`updates.enabled: false` in `config.json`.

### Nothing to schedule

The dashboard collects the rainfall itself. Every 15 minutes it checks whether
the record has gone stale — older than `ingest.intervalHours`, 6 by default —
and pulls if it has.

That is catch-up scheduling rather than clock scheduling, and it is deliberate:
a farm computer is off as often as it is on, and a fixed 7:15 daily task on a
machine that boots at 9 simply never runs. Whenever the dashboard is up, it
brings the record current, including everything missed while the machine was
off. The **Data collection** panel shows what it is doing and has buttons for
the three jobs, so none of it needs a command prompt.

The CLI still does everything, for anyone who prefers it:

```bash
npm run discover      # map each field to its nearest rain gauges
npm run backfill 400  # pull a year+ of history
npm run ingest        # pull recent days
```

## Adding your fields

Two ways, both writing to the same `config.json`:

**From the dashboard** — `npm run serve`, scroll to **Fields**, fill in name /
latitude / longitude. Gauges are remapped the moment you save. **Acres** and
**Farm** are editable in place in that table: click the cell, type, tab out.

**From the CLI:**

```bash
npm run fields                                    # list what you have
npm run add-field -- --name "North 80" --lat 39.4310 --lon -101.0490 --acres 80
npm run update-field -- --id north-80 --acres 78 --farm "Home Place"
npm run remove-field -- --id north-80
```

Latitude and longitude are decimal degrees. **Longitude is negative in the
western hemisphere** — `-101.049`, not `101.049`. That is the single most common
setup mistake, so both entry paths reject a positive longitude in US latitudes
rather than silently returning no data forever.

Paste a **pair** into either coordinate box — `39.4310, -101.0490` straight out
of Google Maps — and both fill in. Decimal, degrees/minutes/seconds and
hemisphere letters all work, in either order, so `101° 02' 56" W 39° 25' 52" N`
lands the right way round. The boxes are numeric, and a numeric box silently
discards a paste containing a comma, so without this you would get an empty box
and no explanation. It works the same in the manual gauge and weather station
forms.

Your state, the gauge networks that cover it, and whether a state mesonet applies
are all detected from your coordinates and written back into `config.json`. To
pin them yourself, edit `region.states` and set `region.autoDetected` to `false`.

A field is a single point, not a polygon. For a quarter section that is well
inside the grid resolution, so it makes no practical difference.

### Miles, not kilometres

Every distance on screen is in **miles** — how far each gauge is, how far a
gauge reaches, the search radius per network. The great-circle maths and the
`dist_km` column stay metric internally because that is not something anybody
reads.

Ranges in `config.json` are `maxDistanceMi`. A config written before this
switch has `maxDistanceKm` and is still read **as kilometres**, so nothing
moves under you; the dashboard converts for display, and rewrites the key in
miles the next time you save that gauge or station from the UI.

### Farms

Every field can carry an optional **farm** — free-form text, so it can be an
operation, a landlord, or whoever you scout for. The dashboard grows a
multi-select **Farm** filter that narrows the field dropdown and the all-fields
comparison to that farm's ground; fields with no farm set stay reachable under
"No farm set". Useful if you agronomize, custom farm, or custom harvest across
several operations and want to see one of them at a time.

Farm names are matched case-insensitively against the ones already in use, so
`home place` typed into a second field joins `Home Place` rather than starting a
near-duplicate.

## Gauges you read yourself

A stick gauge by the weather station, a neighbour's gauge next to two of your
fields — gauges that report to nothing online. Add them in the dashboard's
**Manual gauges** panel with their coordinates, then type readings in as you
collect them.

They behave like any other station: they rank by distance and cover any field
within range. Two things are different.

- **Nothing fetches them**, so an ingest never overwrites a reading you typed.
- **They are charted as their own series**, in magenta, rather than being merged
  into the automatic gauge number. That is the point of a gauge you read as a
  double check — averaging it into the same line would hide exactly the
  disagreement you put it there to see.

Each gauge can carry its own **range** in miles. The default (`maxDistanceMi`
under `sources.manual`) is 15 miles, which is right for a gauge that speaks for
the home place; set a tighter one on a neighbour's gauge so it covers the two
fields beside it and nothing else.

Leaving the amount blank deletes a reading rather than storing `0.00` — "I
haven't read it" and "it stayed dry" have to stay different answers. Removing a
gauge keeps its readings, so adding it back restores them.

## Comparing years, and comparing fields

Four pickers across the top: **Farm**, **Field**, **Year**, **Range**, and
**Compare with**.

**Year** is which year the range is measured back from. Leave it on "This year"
and everything behaves as it always has; set it to 1996 and the whole window
slides onto the same squares of that year's calendar — "Last 30 days" becomes the
same thirty days of 1996. That is what lets a comparison be 1996 against 1988
with neither side being now. While a past year is on screen the tiles get one
extra tile for that year's total, because every other tile is a window ending
*today* and always will be.

**Compare with** offers two things in one list, and they are alternatives rather
than options:

- **Another year** — the same field, the same window, N years back. Matched by
  month and day, so February 29th drops out instead of shunting every later date
  one place. Only offered for a range under a year: a longer window can hold the
  same calendar square twice, and then there is nothing to match on.
- **Another field** — the same days, different ground. Two fields cannot be drawn
  gauge by gauge, because this field's nearest station and that one's are
  measurements of different places; the gauges collapse to one figure per field
  (nearest that reported), and the gridded sources are drawn for both.

Two fields *and* two years at once would be four lines per source, which is a
thicket rather than a comparison, so the one picker holds both.

Either way the second half is drawn **below the baseline** on the daily chart and
**dashed** on the cumulative one, in the same colour per source. The year or the
field is never carried by a second set of hues: one of the people this was built
for is colourblind, and a shifted hue either disappears or stops reading as the
same series. When two years are compared, the **All fields** bars answer for both
years too — those are whole calendar years, cut off at today's date if one of
them is this year, and the card says so, because it is a different window from
the charts above.

Clicking a name in a **legend** takes that series off both upper charts until you
click it back on — useful when seven lines are in the way of the two you are
comparing. It is temporary and lives nowhere: a reload brings everything back.
The permanent version of the same idea is the panel below.

## Choosing what counts for a field

Not every source describes every field. An on-farm gauge is ground truth on the
home quarter and a guess twenty miles out, and a COOP volunteer who reads at 7am
may be the only gauge for one field and irrelevant to another.

The **What counts for this field** panel has a checkbox per source and per
mapped gauge. Untick one and it stops counting for that field — **in the past as
well as going forward**, because the field's daily gauge figure is *derived* from
the stored station readings rather than frozen at fetch time. Nothing is
deleted: tick it back on and the full history reappears.

Each field lists its **nearest six** gauges and counts the **nearest two**.
Unticking one does **not** promote another into its place. A gauge half a mile
from the field and one thirty miles away are measurements of different ground,
and quietly substituting the second for the first changes what the field's
number means while it still reads as the same column. The other four stay
listed, so widening the net is something you do on purpose.

Both numbers are `gauges.listNearest` and `gauges.countNearest` in
`config.json`. They apply to a field the first time it is mapped; a field that
already has gauges keeps whatever is ticked, so changing them — or updating an
existing install — never rewrites decisions already made.

Each gauge you tick gets **its own line on the charts and its own column in the
table**, so you see what each one actually said. The single derived figure —
nearest gauge that reported that day — is still what the all-fields comparison,
the CSV and the calibration use, since those need one number per field.

The **Rain gauges** and **Manual gauges** checkboxes in the toggle row above the
table switch off *all* of them at once for this field; the boxes in the table
are the individual ones.

It is stored per field in `config.json`:

```json
{ "id": "north-quarter", "name": "North Quarter", "lat": 39.3861, "lon": -101.0523,
  "exclude": { "sources": ["prism"], "stations": ["ONFARM|MYSTATION"] } }
```

## Running it on more than one computer

RFC QPE publishes rolling windows and no archive, so a day missed while a
machine was off is gone on that machine — permanently. The same is true of an
on-farm WeatherLink station, whose `NOAAMO.txt` is overwritten at month roll.

Run a copy on two or three computers and their gaps do not line up. The
**Export & import** panel moves a date range from one to the others:

```bash
npm run export -- --days 14 --out //shared/rain/laptop.json
npm run import -- --file //shared/rain/laptop.json
```

Both are also in the dashboard, with pickers for the range, the fields and the
sources.

What travels is the **raw record**, never the derived one. Gridded observations
and individual station readings go in the file; each machine recomputes its own
per-field gauge figures on arrival, because the receiving machine may rank
gauges differently or exclude one, and its answer to "which gauge counts for
this field" has to win over the sender's.

The merge is never destructive:

- A row is written only if it is missing here, or if its `updated_at` is newer
  than ours. Two machines that both revised the same day keep the later revision.
- Re-importing the same file changes nothing, so a scheduled job can run blind.
- Data for a field this machine does not have is skipped and reported by name.
  Tick **Create fields this instance does not have** (or pass `--create-fields`)
  to adopt them, then run `npm run discover` to map their gauges.
- The whole merge is one transaction. A rejected import leaves nothing behind.

For a new machine, run `npm run discover` before importing. Station readings can
only become a field's gauge figure once that field has gauges mapped; the import
says so by name when some field does not.

### Copying a whole machine

Export/import is for two machines that are **both** collecting and need each
other's gaps filled. Setting a *new* machine up is a different job, and the
**Backup & restore** panel does it in one file: `config.json` and every table,
so the target becomes a copy of the source.

```bash
npm run backup                                  # rainmonitor-backup_2026-08-12.json
npm run restore -- --file that-file.json        # replaces everything here
```

Both are in the dashboard too, and restoring there restarts it onto the restored
settings by itself.

- **Restoring replaces, it does not merge.** That is the point — a "restore" that
  left the target's own leftovers behind would not be one. Use export/import to
  combine two machines that are each already collecting.
- **Both machines must be on the same version.** A backup writes rows straight
  back into the tables they came from, and only a matching commit guarantees they
  still mean the same thing. The commit is recorded in the file and checked on
  the way in; a mismatch is refused with both versions named. `--force` (or the
  override box) exists for a copy installed from a zip, which has no version to
  compare — it still refuses if the columns do not line up.
- **What is here now is saved first**, to `data/backups/before-restore-<time>.json`,
  before anything is overwritten. Restoring the wrong file onto the wrong machine
  is a mistake somebody makes while setting up three computers in an afternoon,
  and it would otherwise be unrecoverable.

The backup contains your station's address and all your field coordinates. It is
a local file; treat it the way you treat `config.json`.

### A read-only copy on the web

The dashboard binds to loopback, which is the right default and also means the
rain can only be read from the one computer it runs on. `npm run publish` builds
a **read-only copy of the charts** — a folder of plain `.html`, `.js` and
`.json` files that any web host can serve, with no Node, no database and nothing
to configure at the other end.

```bash
npm run publish                             # build it and send it
npm run publish -- --no-upload              # build only, into data/published
npm run publish -- --full                   # re-send everything, not just what changed
npm run check-publish                       # does the copy still say what this machine says?
```

Once `publish.enabled` is on it goes out **by itself, after every collection
run** — the copy is only ever out of date because the data was, so it follows
the data rather than keeping a clock of its own. There is a **Publish now**
button on the dashboard for when you have changed something and want it up
straight away. A web host that is down, a password that has been changed or a
connection that drops is recorded in the job log and nothing more: the rain is
already saved here, and the mirror catches up on the next run.

It is the same page: the same charts, the same field, year and range pickers, the
same comparisons — another year or another field — and the same clickable
legends, drawn by the same `web/app.js`. What is missing is
every control that would change something. Those cards are **cut out of the
published HTML**, not hidden in it — there is no dashboard at the far end for a
form to post to, and a button that appears to work and silently does not is
worse than one that was never on the page.

Configure it under `publish` in `config.json`:

- **`fields`** — which fields appear, by id. Empty means all of them. A field
  that is not listed is absent from the published copy, not hidden in it.
- **`coordinates`** — off by default. Leaves out field latitude and longitude
  *and* the distance to every gauge, because a named field plus a named gauge
  plus "4.2 mi" is a location whether or not a latitude was published.
- **`calibration`** — off by default. The calibration card names your own
  weather station and says where it stands.

Field names, farm names and acreage are always published; the page cannot tell
one field from another without them. **Assume anyone can read these files** —
that is what a static host is for — and use `--out` to look through the folder
before deciding what goes on it.

Forty-five years of eight fields is about 4.7 MB, and all but 72 KB of that is
history that only changes when a backfill or an exclusion rewrites the past. The
series is split at January 1st for exactly that reason: the frozen half is
uploaded once, and only this year's numbers travel each day. What is already on
the host is remembered here and skipped, so a second run sends nothing at all.

**Getting to the host.** `publish.ftp` takes plain FTP or **explicit FTPS** —
the ordinary port 21, upgraded to TLS with `AUTH TLS` before the password is
sent. Leave `secure` on: with it off the password crosses the internet as
readable text. Use an account that can write that one directory and nothing
else, not the one you sign in to the web host with; the password sits in
`config.json` in the clear, because FTP gives it nowhere else to live.

**SFTP is not supported.** SFTP is a subsystem of SSH, and implementing SSH
would mean taking a dependency, which this project does not do. If the host only
offers SFTP, build with `--no-upload` and send the folder with whatever client
you already use.

Every file lands under a temporary name and is renamed into place, so nobody
can fetch a half-written file — there is no server at the other end to retry
against, and a truncated JSON is a blank page on somebody's phone.

## Where the numbers come from

| Source | What it is | Resolution | Backfills? |
|---|---|---|---|
| **Your own station** | Any Davis/WeatherLink publishing NOAA-format reports | on the field | monthly only |
| **RFC QPE** | NWS multi-sensor (radar + gauges + satellite) | ~4 km | **no** |
| **MRMS** | Multi-Radar Multi-Sensor, gauge-corrected, via IEM | ~12 km | yes |
| **PRISM** | Climate analysis blending gauges + terrain | 4 km | yes |
| **Rain gauge** | Each nearby NWS COOP/ASOS or state mesonet station, on its own | a point | yes |
| **Manual gauge** | A gauge you read by hand and type in yourself | a point | you type it |

Each source is stored separately on purpose. **The disagreement between them is
itself the signal** — when the radar says 0.6" and the gauge says 0.00", either
that gauge is clogged, unread, or the storm genuinely missed it by a mile.
Averaging them into one number throws that away.

That applies to the gauges against each other, not just gauge against radar, so
**every gauge that counts for a field is drawn as its own line**, named, rather
than collapsed into one "rain gauge" figure. Two gauges four miles apart
routinely disagree by half an inch on a summer storm, and the old single figure
hid both the disagreement and which gauge you were reading on the days it fell
through from one to the next.

Up to four gauges are charted per field — that is how many colours stay apart
from each other and from the three gridded sources, in both light and dark. Any
beyond that still count towards the field's totals and the chart says so by
name rather than dropping them quietly.

Flat terrain with a nearby NEXRAD gives noticeably better radar QPE than
mountainous country, where beam blockage is a real problem. Resolution matters
most in summer, when convection can drop an inch on one quarter section and miss
the next — which is exactly what a gauge fifteen miles away cannot resolve.

### Using your own weather station

If you have a station publishing WeatherLink's NOAA reports (`NOAAMO.txt` and
`NOAAYR.txt`) — a Davis, or anything else that emits the same format — add it in
the dashboard's **Your own weather station** panel: a name, the station's
coordinates, and the two report addresses.

**Test the addresses** before saving. It fetches both, says how many days and
months came back and how much rain that is, and **fills the coordinates and
elevation in from the report header** — which prints them in
degrees/minutes/seconds, the one number in this setup that needs a conversion.
Pointing these URLs at the wrong file is the mistake that costs the most,
because a wrong one looks fine and only shows up months later as a series that
never started.

Use the **station's** position, not a field's. Saving links it to every field
within its range immediately — that is arithmetic on coordinates already on the
machine, so it does not wait on the network — and then queues a read of both
reports back to the first of the month.

It ranks as just another gauge, by distance, so it wins automatically for
whichever fields are closest. It also becomes the reference for
[calibration](#calibrating-radar-against-your-own-station).

Removing it keeps its readings, so putting the same station back picks the
history up again. That matters more here than anywhere else: `NOAAMO.txt` is
overwritten every month, so what is stored is the only copy that exists.

There is one station, not a list — it is the one on your own ground, and it is
what the radar is measured against. Other gauges you own are
[manual gauges](#gauges-you-read-yourself).

> `NOAAMO.txt` holds only the **current month** and is overwritten at month roll.
> Miss a month and those daily values are gone permanently. `NOAAYR.txt` keeps
> monthly totals for the year, so the monthly series always backfills.

## Data-quality traps this handles

These are real, verified upstream behaviors, not hypotheticals. Each one is the
kind that produces confident wrong numbers rather than an error:

- **A silent gauge is not a dry gauge.** IEM returns `null` for a COOP station
  that did not report, and `Number(null)` is `0` in JavaScript — so the naive
  parse turns "no report" into a confident `0.00 in`. Many COOP gauges are
  volunteer-read and go quiet for weeks. Missing stays missing, and the field
  falls through to the next-nearest station that actually reported.
- **The gridded feed silently truncates across a calendar-year boundary.** A
  request spanning two years returns HTTP 200, valid JSON, and exactly **one**
  row — no error, no warning. Requests are split at year boundaries, and a short
  response is logged as a failure rather than quietly becoming a dry year.
- **Kansas Mesonet reports millimetres** and ignores any `units=` parameter you
  pass. Storing the raw value inflates every reading 25.4×.
- **That API answers bad station names with HTTP 200** and a plain-text
  `Error: ...` body. Responses without the expected CSV header are rejected
  rather than parsed into a bogus row.
- **Feeds disagree about what "a day" is.** Kansas Mesonet stamps its total at
  the *end* of the window, so the row dated the 10th is the 9th's rain
  (r = 0.985 at lag −1 vs 0.081 at lag 0 — unambiguous). It is shifted on ingest.
- **Some stations 500 permanently.** Those fail soft so one broken station cannot
  stop the day's ingest.
- **Recent days get revised.** Every run re-fetches the last `revisitDays`
  (default 10), so late COOP reports and PRISM revisions land.

`npm run check` cross-correlates every source against radar at lags −2..+2. Each
should peak at lag 0; a sharp peak elsewhere means a feed changed its date
convention and storms are being filed on the wrong day. That check is what caught
the Mesonet offset — re-run it if numbers ever start looking strange.

### What is *not* corrected, on purpose

**PRISM, RFC QPE and COOP straddle local midnight.** PRISM and RFC QPE run a
12Z–12Z day; COOP observers read at 7am. All three cover parts of two local
calendar days, and which lag "wins" varies by location — so any whole-day shift
would fix one field and break another. Compare those over a week or the
cumulative chart, not a single day.

## Calibrating radar against your own station

```bash
npm run calibrate
```

Compares your station against MRMS and PRISM sampled at the same point, month by
month. Example output from a Kansas farm with 8 months of overlap:

| Period | Gauge | MRMS | PRISM | g÷MRMS | g÷PRISM |
|---|---|---|---|---|---|
| Warm (May–Sep) | 9.00" | 10.43" | 9.14" | 0.863 | **0.984** |
| Cold (Oct–Apr) | 1.24" | 2.13" | 1.29" | 0.582 | 0.963 |
| All months | 10.24" | 12.56" | 10.43" | 0.815 | **0.982** |

Two reasons the season split matters, and why the tool refuses to emit a single
annual factor:

- **A low cold-season ratio is usually not radar error.** An unheated tipping
  bucket barely registers snow — flakes land and sublimate. Folding winter into
  one annual number under-reports every summer thunderstorm on every other field.
- **Part of the warm-season gap is the gauge too.** Unshielded buckets
  under-catch wind-driven rain by roughly 5–15% in open country. True radar bias
  sits between the computed factor and 1.00, not at the factor.

In the example above PRISM tracks the gauge to within 2% — it assimilates gauge
networks by design, so it has effectively done the correction already. Your
numbers will differ; run it against your own station before trusting any of it.

## Scheduling

**There is nothing to schedule** — see [Nothing to schedule](#nothing-to-schedule)
above. The dashboard pulls whenever the record is stale, so keeping it running
is the whole job, and `Setup.cmd` makes it start at login.

**Keeping it running matters.** Most sources re-fetch the last 10 days, so a
missed run self-heals. Two do not, because they publish no archive: RFC QPE (a
missed *day* is gone) and the WeatherLink NOAA report (a missed *month* is
gone). Running it on a second computer covers the first one's downtime — see
[Running it on more than one computer](#running-it-on-more-than-one-computer).

If you would rather drive it from the operating system's scheduler, set
`ingest.auto` to `false` in `config.json` and run `npm run ingest` on a timer:

```powershell
Setup.cmd -IngestTask     # Windows: daily at 07:15, logged in or not
```

```cron
15 7 * * * cd /path/to/rainmonitor && /usr/bin/node src/cli.js ingest >> ingest.log 2>&1
```

7:15 local is deliberate: COOP observers read at 7am, the RFC QPE daily product
closes at 12Z, and the analyses need a few minutes to publish.

## Limitations

- **Resolution is coarser than rainfall maps make it look.** RFC QPE is
  ~4 km — 2.6 mi per side, about 6.8 sq mi per cell. Maps drawn from it appear
  finer only because the raster is resampled smoothly at any zoom. Fields closer
  together than ~4 km will share a cell and return identical values.
- **RFC QPE cannot backfill.** It publishes rolling windows only, so its daily
  series starts the day you switch it on. Rolling snapshots (7 / 30 day, year to
  date) are stored in `field_window` so a gap stays visible and the cumulative
  picture is still recoverable.
- **State mesonets:** only Kansas is implemented. Everywhere else falls back to
  COOP/ASOS, which cover the whole country. Adding another is one source module —
  see `src/region.js`.

### Getting to genuine ~1 sq mi

Native MRMS is a 1 km grid (0.39 sq mi), on AWS Open Data with no credentials:

```
s3://noaa-mrms-pds/CONUS/MultiSensor_QPE_24H_Pass2_00.00/<YYYYMMDD>/
```

Hourly files, ~4 MB gzipped GRIB2, archive back to 2020-10-14. `Pass2` is the
gauge-corrected pass. The obstacle is decoding: MRMS GRIB2 uses PNG-compressed
packing that JavaScript GRIB libraries do not handle, so it needs a Python
toolchain (`eccodes` + `cfgrib`, or `wgrib2`). The `obs` table already stores one
row per field/date/source, so adding a `mrms1km` source is purely additive.

## Layout

```
Setup.cmd                     double-click installer (Windows)
scripts/setup.ps1             what it runs: autostart, shortcut, config
config.example.json           template; npm run init copies it to config.json
config.json                   YOUR setup — gitignored, never committed
src/cli.js                    init | discover | ingest | backfill | export | import | backup | restore | publish
src/setup.js                  config read/write, field + gauge + station validation
src/region.js                 lat/lon -> state -> gauge networks
src/ingest.js                 pull the sources
src/derive.js                 station readings -> each field's gauge figure
src/jobs.js                   in-dashboard scheduler + background job runner
src/update.js                 git update check, fast-forward, restart
src/sync.js                   export/import a date range between machines
src/backup.js                 whole-machine backup/restore (config + every table)
src/sources/                  iemre, rfcqpe, iemgauge, ksmesonet, weatherlink
src/calibration.js            gauge-vs-grid bias (shared by CLI and dashboard)
src/db.js                     SQLite schema
src/views.js                  the read side: series, summary, CSV, field list
src/publish.js                build the read-only static copy, and send what changed
src/ftp.js                    minimal FTP / explicit-FTPS client (no dependencies)
src/server.js                 local HTTP API + static host
web/                          dashboard (vanilla JS, inline SVG charts)
web/static.js                 published copy only: serves the API out of files
scripts/calibrate.mjs         npm run calibrate
scripts/check-alignment.mjs   npm run check
scripts/check-publish.mjs     npm run check-publish
scripts/check-ftp.mjs         npm run check-ftp (loopback FTP server, no network)
scripts/register-task.ps1     Windows scheduled task
data/rain.db                  your history — this is the thing worth backing up
```

`config.json` is gitignored so your field coordinates and station URL never end
up in a public repo. Editing the field list and re-running `discover` or `ingest`
also **removes** fields you deleted, along with their observations — otherwise a
dropped field lingers in the dashboard with data that quietly stops updating.

The dashboard's field editor writes `config.json` and is restricted to loopback,
even if you change `server.host`.

## License

MIT — see [LICENSE](LICENSE).

Weather data comes from NOAA/NWS, PRISM Climate Group, and Iowa State's IEM, each
under its own terms. All are public, but check before redistributing bulk data.
