import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SOURCES } from './util.js';
import { detectStates, networksFor, mesonetFor, STATE_MESONETS } from './region.js';

export const CONFIG_PATH = join(ROOT, 'config.json');
const EXAMPLE_PATH = join(ROOT, 'config.example.json');

export function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

export function writeConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

export function ensureConfig(log = console.log) {
  if (existsSync(CONFIG_PATH)) return false;
  copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  log(`Created config.json from config.example.json`);
  return true;
}

/** URL-safe id from a field name, unique within the config. */
export function slugify(name, taken = new Set()) {
  const base = String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'field';
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Shared by everything that carries a position: fields, gauges, the station. */
export function validateCoords(lat, lon) {
  const errors = [];
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || la < -90 || la > 90) errors.push('lat must be between -90 and 90');
  if (!Number.isFinite(lo) || lo < -180 || lo > 180) errors.push('lon must be between -180 and 180');
  // The single most common setup mistake: a positive longitude in the US puts
  // the field in Asia, where every source silently returns nothing.
  if (Number.isFinite(lo) && lo > 0 && Number.isFinite(la) && la > 20 && la < 72)
    errors.push('lon looks positive — western-hemisphere longitudes must be negative (e.g. -101.05)');
  return errors;
}

export function validateField({ name, lat, lon, acres, farm }) {
  const errors = [];
  if (!name || !String(name).trim()) errors.push('name is required');
  errors.push(...validateCoords(lat, lon));
  if (acres !== undefined && acres !== null && acres !== '' && !(Number(acres) > 0))
    errors.push('acres must be a positive number if given');
  if (farm !== undefined && farm !== null && String(farm).length > 60)
    errors.push('farm name must be 60 characters or fewer');
  return errors;
}

/**
 * Farms are a plain string on the field, matched case-insensitively but stored
 * as typed. There is no farm registry to keep in sync: a farm exists exactly as
 * long as some field names it, so renaming the last field off a farm retires it.
 * Reusing the existing spelling keeps "Home Place" and "home place" from becoming
 * two entries in the filter.
 */
export function normalizeFarm(cfg, farm) {
  const t = String(farm ?? '').trim();
  if (!t) return null;
  const existing = cfg.fields.find(f => f.farm && f.farm.toLowerCase() === t.toLowerCase());
  return existing ? existing.farm : t;
}

export function farmsOf(fields = []) {
  const seen = new Map();
  for (const f of fields) if (f.farm && !seen.has(f.farm.toLowerCase())) seen.set(f.farm.toLowerCase(), f.farm);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Fill in whatever the user did not have to know: which state the fields are in,
 * which IEM networks cover it, and whether a state mesonet applies. Persisted
 * back to config.json so it is visible and overridable rather than magic.
 */
export async function autoDetectRegion(cfg, log = console.log) {
  if (!cfg.fields?.length) return cfg;
  if (!cfg.region) cfg.region = {};

  // Re-derive whenever the region was auto-detected, not just when it is empty.
  // `init` detects from the EXAMPLE fields, so a new user who then replaces
  // those with their own would otherwise be left pinned to Kansas and querying
  // gauge networks a thousand miles away. Setting region.autoDetected to false
  // (or hand-editing states after clearing the flag) pins it deliberately.
  const auto = cfg.region.autoDetected !== false;
  const stale = !cfg.region.states?.length || auto;

  if (stale) {
    const states = await detectStates(cfg.fields);
    const before = (cfg.region.states ?? []).join(',');
    if (states.length) {
      cfg.region.states = states;
      cfg.region.autoDetected = true;
      if (states.join(',') !== before) log(`  region: detected ${states.join(', ')}`);
    } else if (!before) {
      log('  region: could not auto-detect (offline, or fields outside the US) — set region.states manually');
    }
  }

  const states = cfg.region.states ?? [];
  if (cfg.sources?.iem_gauge && states.length) {
    const want = networksFor(states);
    const have = cfg.sources.iem_gauge.networks ?? [];
    // Only overwrite networks we would have generated ourselves, so a
    // hand-added network (a neighbouring state, say) is never clobbered.
    const generated = have.every(n => /_(COOP|ASOS)$/.test(n));
    if (!have.length || (generated && have.join(',') !== want.join(','))) {
      cfg.sources.iem_gauge.networks = want;
      log(`  gauges: using ${want.join(', ')}`);
    }
  }

  // Switch state mesonets to match the region, both directions — so moving into
  // a covered state turns one on, not just out of one turning it off.
  if (states.length) {
    const applicable = mesonetFor(states);
    for (const [st, key] of Object.entries(STATE_MESONETS)) {
      const src = cfg.sources?.[key];
      if (!src) continue;
      const want = key === applicable;
      if (src.enabled !== want) {
        src.enabled = want;
        log(want ? `  ${key}: enabled (${st} detected)` : `  ${key}: not applicable outside ${st} — disabled`);
      }
    }
  }
  return cfg;
}

export function addField(cfg, { name, lat, lon, acres, farm }) {
  const errors = validateField({ name, lat, lon, acres, farm });
  if (errors.length) throw new Error(errors.join('; '));
  const id = slugify(name, new Set(cfg.fields.map(f => f.id)));
  const field = { id, name: String(name).trim(), lat: Number(lat), lon: Number(lon) };
  if (acres) field.acres = Number(acres);
  const fm = normalizeFarm(cfg, farm);
  if (fm) field.farm = fm;
  cfg.fields.push(field);
  return field;
}

export function updateField(cfg, id, patch) {
  const f = cfg.fields.find(x => x.id === id);
  if (!f) throw new Error(`no field with id "${id}"`);
  const merged = { ...f, ...patch };
  const errors = validateField(merged);
  if (errors.length) throw new Error(errors.join('; '));
  f.name = String(merged.name).trim();
  f.lat = Number(merged.lat);
  f.lon = Number(merged.lon);
  if (merged.acres) f.acres = Number(merged.acres); else delete f.acres;
  // Match against the other fields, so a field cannot normalize against itself
  // and pin its own old spelling when it is the one being renamed.
  const others = { ...cfg, fields: cfg.fields.filter(x => x.id !== id) };
  const fm = normalizeFarm(others, merged.farm);
  if (fm) f.farm = fm; else delete f.farm;
  return f;
}

/* ---------- manual gauges ---------- */

/**
 * A gauge somebody walks out and reads.
 *
 * These are stations like any other — they carry coordinates and rank by
 * distance — so the whole nearest-reporting-station machinery applies without
 * special cases. What is different is that nothing fetches them, so their
 * readings are typed in and never overwritten by an ingest.
 */
export const MANUAL_DEFAULTS = { enabled: true, label: 'Manual gauges', maxStations: 2, maxDistanceKm: 25, gauges: [] };

export function manualGauges(cfg) {
  return cfg.sources?.manual?.gauges ?? [];
}

function manualSection(cfg) {
  if (!cfg.sources) cfg.sources = {};
  if (!cfg.sources.manual) cfg.sources.manual = { ...MANUAL_DEFAULTS };
  if (!Array.isArray(cfg.sources.manual.gauges)) cfg.sources.manual.gauges = [];
  return cfg.sources.manual;
}

export function upsertManualGauge(cfg, { id, name, lat, lon, maxDistanceKm }) {
  const errors = validateField({ name, lat, lon });
  const km = maxDistanceKm === '' || maxDistanceKm === undefined || maxDistanceKm === null
    ? null : Number(maxDistanceKm);
  if (km !== null && !(km > 0)) errors.push('range must be a positive number of km if given');
  if (errors.length) throw new Error(errors.join('; '));

  const sec = manualSection(cfg);
  const g = id ? sec.gauges.find(x => x.id === id) : null;
  if (id && !g) throw new Error(`no manual gauge with id "${id}"`);
  const next = {
    id: g?.id ?? slugify(name, new Set(sec.gauges.map(x => x.id))),
    name: String(name).trim(), lat: Number(lat), lon: Number(lon),
  };
  // Per-gauge range, because these differ in what they are for: the stick gauge
  // by the shop is a check on the home place, a neighbour's gauge speaks for the
  // two fields beside it and for nothing else.
  if (km !== null) next.maxDistanceKm = km;
  if (g) { delete g.maxDistanceKm; Object.assign(g, next); } else sec.gauges.push(next);
  sec.enabled = true;
  return next;
}

/**
 * Adopt a gauge from another instance's export, keeping its id verbatim.
 *
 * The id is what the readings are filed under, so re-slugifying the name here
 * would silently attach a year of hand-read data to the wrong gauge — or to a
 * gauge that does not exist. An id we already use wins: that is our gauge.
 */
export function adoptManualGauge(cfg, g) {
  if (!g?.id || !g.name || !Number.isFinite(Number(g.lat)) || !Number.isFinite(Number(g.lon))) return null;
  const sec = manualSection(cfg);
  if (sec.gauges.some(x => x.id === g.id)) return null;
  const next = { id: String(g.id), name: String(g.name).trim(), lat: Number(g.lat), lon: Number(g.lon) };
  if (Number(g.maxDistanceKm) > 0) next.maxDistanceKm = Number(g.maxDistanceKm);
  sec.gauges.push(next);
  sec.enabled = true;
  return next;
}

export function removeManualGauge(cfg, id) {
  const sec = manualSection(cfg);
  const i = sec.gauges.findIndex(g => g.id === id);
  if (i < 0) throw new Error(`no manual gauge with id "${id}"`);
  return sec.gauges.splice(i, 1)[0];
}

/* ---------- the station on your own ground ---------- */

/**
 * A Davis (or anything else) publishing WeatherLink's NOAA-format reports.
 *
 * There is one of these, not a list: it is the station ON the farm, it is what
 * `npm run calibrate` measures the radar against, and a second one would raise
 * "which is the reference" — a question with no good answer and no UI worth
 * building for it. Any further gauges you own are manual gauges.
 */
export const WEATHERLINK_DEFAULTS = {
  enabled: false,
  label: 'On-farm weather station',
  stationId: 'MYSTATION',
  name: 'My Farm Station',
  lat: null, lon: null, elev_ft: null,
  dailyUrl: '', yearlyUrl: '',
  maxDistanceKm: 30,
};

/** The station that is switched on, or null when there is not one. */
export function onFarmStation(cfg) {
  const of = cfg.sources?.weatherlink;
  return of?.enabled ? of : null;
}

const blank = v => v === '' || v === undefined || v === null;

function httpUrl(errors, v, label, required = false) {
  const s = String(v ?? '').trim();
  if (!s) { if (required) errors.push(`${label} is required`); return ''; }
  let u;
  try { u = new URL(s); } catch { errors.push(`${label} is not a valid address`); return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push(`${label} must start with http:// or https://`);
  return s;
}

/**
 * Add or edit the on-farm station.
 *
 * `stationId` is deliberately not something the form can change. It is what
 * every stored reading and every per-field exclusion is filed under, so letting
 * it move on a rename would orphan a year of history behind an id nothing
 * refers to any more. It is derived once, from the name given the first time.
 */
export function setOnFarmStation(cfg, { name, lat, lon, elev_ft, dailyUrl, yearlyUrl, maxDistanceKm }) {
  const errors = [];
  if (!name || !String(name).trim()) errors.push('station name is required');
  errors.push(...validateCoords(lat, lon));
  const daily = httpUrl(errors, dailyUrl, 'the daily report address (NOAAMO.txt)', true);
  const yearly = httpUrl(errors, yearlyUrl, 'the yearly report address (NOAAYR.txt)');
  if (!blank(elev_ft) && !Number.isFinite(Number(elev_ft))) errors.push('elevation must be a number of feet if given');
  if (!blank(maxDistanceKm) && !(Number(maxDistanceKm) > 0)) errors.push('range must be a positive number of km if given');
  if (errors.length) throw new Error(errors.join('; '));

  if (!cfg.sources) cfg.sources = {};
  const prev = cfg.sources.weatherlink ?? {};
  // A station that was never switched on carries the example's placeholder id,
  // which must not be inherited as though it meant something.
  const keepId = prev.enabled && prev.stationId ? prev.stationId : null;
  const next = {
    ...WEATHERLINK_DEFAULTS, ...prev,
    enabled: true,
    stationId: keepId ?? stationIdFor(name),
    name: String(name).trim(),
    lat: Number(lat), lon: Number(lon),
    elev_ft: blank(elev_ft) ? null : Number(elev_ft),
    dailyUrl: daily,
    yearlyUrl: yearly,
    maxDistanceKm: blank(maxDistanceKm) ? (prev.maxDistanceKm ?? WEATHERLINK_DEFAULTS.maxDistanceKm) : Number(maxDistanceKm),
  };
  cfg.sources.weatherlink = next;
  return next;
}

const stationIdFor = name => slugify(name).replace(/-/g, '_').toUpperCase().slice(0, 24) || 'ONFARM';

/**
 * Switch the station off. Its readings stay in the database, so putting the
 * same station back later picks the history up again rather than starting over
 * — which matters more here than anywhere else, because NOAAMO.txt is
 * overwritten monthly and what is stored is the only copy that exists.
 */
export function removeOnFarmStation(cfg) {
  const of = cfg.sources?.weatherlink;
  if (!of?.enabled) throw new Error('no on-farm station is set up');
  of.enabled = false;
  return of;
}

/**
 * Turn a source or an individual gauge off for one field.
 *
 * Exclusions live on the field rather than on the source because they are a
 * statement about this field: an on-farm gauge that is ground truth for the
 * home quarter is a guess 20 miles out, and the fields it does not describe
 * should not average it in. Nothing is deleted — the readings stay in the
 * database, so the decision is reversible.
 */
export function setExclusions(cfg, id, { sources, stations }) {
  const f = cfg.fields.find(x => x.id === id);
  if (!f) throw new Error(`no field with id "${id}"`);
  const clean = (list, valid) => [...new Set((list ?? []).map(s => String(s).trim()).filter(Boolean))]
    .filter(s => !valid || valid.includes(s)).sort();

  const ex = { ...(f.exclude ?? {}) };
  if (sources !== undefined) ex.sources = clean(sources, SOURCES);
  if (stations !== undefined) ex.stations = clean(stations);
  for (const k of ['sources', 'stations']) if (!ex[k]?.length) delete ex[k];

  if (Object.keys(ex).length) f.exclude = ex; else delete f.exclude;
  return f;
}

export function removeField(cfg, id) {
  const i = cfg.fields.findIndex(x => x.id === id);
  if (i < 0) throw new Error(`no field with id "${id}"`);
  return cfg.fields.splice(i, 1)[0];
}
