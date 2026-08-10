# Rain Monitor

Per-field rainfall tracking for farms. Pulls from several independent weather
sources every day, stores everything locally in SQLite, and serves a dashboard on
your own machine.

No accounts, no API keys, no subscription, **no npm dependencies** — and the
history is yours, in a file you can back up.

Built for US fields; the gridded sources cover the lower 48.

```bash
git clone <your-fork-url> rainmonitor && cd rainmonitor
npm run init          # creates config.json, detects your state from field coords
npm run serve         # open http://127.0.0.1:8787 and add your fields
npm run discover      # map each field to its nearest rain gauges
npm run backfill 400  # pull a year+ of history
```

After that, `npm run ingest` is the daily job — see [Scheduling](#scheduling).

**Requires Node 22.5 or newer** (it uses the built-in `node:sqlite`). Check with
`node --version`.

## Adding your fields

Two ways, both writing to the same `config.json`:

**From the dashboard** — `npm run serve`, scroll to **Fields**, fill in name /
latitude / longitude. Gauges are remapped the moment you save. **Acres** and
**Farm** are editable in place in that table: click the cell, type, tab out.

**From the CLI:**

```bash
npm run fields                                    # list what you have
npm run add-field -- --name "North 80" --lat 39.4310 --lon -101.0490 --acres 80
npm run update-field -- --id north-80 --acres 78 --farm "Mai Farms"
npm run remove-field -- --id north-80
```

### Farms

Every field can carry an optional **farm** — free-form text, so it can be an
operation, a landlord, or whoever you scout for. The dashboard grows a
multi-select **Farm** filter that narrows the field dropdown and the all-fields
comparison to that farm's ground; fields with no farm set stay reachable under
"No farm set". Useful if you agronomize, custom farm, or custom harvest across
several operations and want to see one of them at a time.

Farm names are matched case-insensitively against the ones already in use, so
`mai farms` typed into a second field joins `Mai Farms` rather than starting a
near-duplicate.

Latitude and longitude are decimal degrees. **Longitude is negative in the
western hemisphere** — `-101.049`, not `101.049`. That is the single most common
setup mistake, so both entry paths reject a positive longitude in US latitudes
rather than silently returning no data forever.

Your state, the gauge networks that cover it, and whether a state mesonet applies
are all detected from your coordinates and written back into `config.json`. To
pin them yourself, edit `region.states` and set `region.autoDetected` to `false`.

A field is a single point, not a polygon. For a quarter section that is well
inside the grid resolution, so it makes no practical difference.

## Choosing what counts for a field

Not every source describes every field. An on-farm gauge is ground truth on the
home quarter and a guess twenty miles out, and a COOP volunteer who reads at 7am
may be the only gauge for one field and irrelevant to another.

The **What counts for this field** panel has a checkbox per source and per
mapped gauge. Untick one and it stops counting for that field — **in the past as
well as going forward**, because the field's daily gauge figure is *derived* from
the stored station readings rather than frozen at fetch time. Nothing is
deleted: tick it back on and the full history reappears.

Excluding a gauge promotes the next station in range for that field, so turning
off a distant gauge falls back to a better one rather than going blind. The
promotion needs the full station lists, so run `npm run discover` after — the
dashboard says so when it applies.

It is stored per field in `config.json`:

```json
{ "id": "river", "name": "River", "lat": 38.94, "lon": -101.80,
  "exclude": { "sources": ["prism"], "stations": ["ONFARM|MAIFARMS"] } }
```

## Where the numbers come from

| Source | What it is | Resolution | Backfills? |
|---|---|---|---|
| **Your own station** | Any Davis/WeatherLink publishing NOAA-format reports | on the field | monthly only |
| **RFC QPE** | NWS multi-sensor (radar + gauges + satellite) | ~4 km | **no** |
| **MRMS** | Multi-Radar Multi-Sensor, gauge-corrected, via IEM | ~12 km | yes |
| **PRISM** | Climate analysis blending gauges + terrain | 4 km | yes |
| **Rain gauge** | Nearest *reporting* NWS COOP/ASOS or state mesonet station | a point | yes |

Each source is stored separately on purpose. **The disagreement between them is
itself the signal** — when the radar says 0.6" and the gauge says 0.00", either
that gauge is clogged, unread, or the storm genuinely missed it by a mile.
Averaging them into one number throws that away.

Flat terrain with a nearby NEXRAD gives noticeably better radar QPE than
mountainous country, where beam blockage is a real problem. Resolution matters
most in summer, when convection can drop an inch on one quarter section and miss
the next — which is exactly what a gauge fifteen miles away cannot resolve.

### Using your own weather station

If you have a station publishing WeatherLink's NOAA reports (`NOAAMO.txt` and
`NOAAYR.txt`), point `sources.weatherlink` at it in `config.json` and set
`enabled` to `true`. Use the **station's** coordinates — its `NOAAMO.txt` header
prints them in degrees/minutes/seconds.

It then ranks as just another gauge, by distance, so it wins automatically for
whichever fields are closest. It also becomes the reference for
[calibration](#calibrating-radar-against-your-own-station).

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

The daily job is `npm run ingest`.

**Windows** — run once from an elevated PowerShell prompt:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
```

**macOS / Linux** — `crontab -e`:

```cron
15 7 * * * cd /path/to/rainmonitor && /usr/bin/node src/cli.js ingest >> ingest.log 2>&1
```

7:15 local is deliberate: COOP observers read at 7am, the RFC QPE daily product
closes at 12Z, and the analyses need a few minutes to publish.

**Do not skip this.** Most sources re-fetch the last 10 days, so a missed run
self-heals. Two do not, because they publish no archive: RFC QPE (a missed *day*
is gone) and the WeatherLink NOAA report (a missed *month* is gone).

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
config.example.json           template; npm run init copies it to config.json
config.json                   YOUR setup — gitignored, never committed
src/cli.js                    init | discover | ingest | backfill | field commands
src/setup.js                  config read/write, field validation
src/region.js                 lat/lon -> state -> gauge networks
src/ingest.js                 pull + per-field derivation
src/sources/                  iemre, rfcqpe, iemgauge, ksmesonet, weatherlink
src/calibration.js            gauge-vs-grid bias (shared by CLI and dashboard)
src/db.js                     SQLite schema
src/server.js                 local HTTP API + static host
web/                          dashboard (vanilla JS, inline SVG charts)
scripts/calibrate.mjs         npm run calibrate
scripts/check-alignment.mjs   npm run check
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
