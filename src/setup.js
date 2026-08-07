import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './util.js';
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

export function validateField({ name, lat, lon, acres }) {
  const errors = [];
  if (!name || !String(name).trim()) errors.push('name is required');
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || la < -90 || la > 90) errors.push('lat must be between -90 and 90');
  if (!Number.isFinite(lo) || lo < -180 || lo > 180) errors.push('lon must be between -180 and 180');
  // The single most common setup mistake: a positive longitude in the US puts
  // the field in Asia, where every source silently returns nothing.
  if (Number.isFinite(lo) && lo > 0 && Number.isFinite(la) && la > 20 && la < 72)
    errors.push('lon looks positive — western-hemisphere longitudes must be negative (e.g. -101.05)');
  if (acres !== undefined && acres !== null && acres !== '' && !(Number(acres) > 0))
    errors.push('acres must be a positive number if given');
  return errors;
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

export function addField(cfg, { name, lat, lon, acres }) {
  const errors = validateField({ name, lat, lon, acres });
  if (errors.length) throw new Error(errors.join('; '));
  const id = slugify(name, new Set(cfg.fields.map(f => f.id)));
  const field = { id, name: String(name).trim(), lat: Number(lat), lon: Number(lon) };
  if (acres) field.acres = Number(acres);
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
  return f;
}

export function removeField(cfg, id) {
  const i = cfg.fields.findIndex(x => x.id === id);
  if (i < 0) throw new Error(`no field with id "${id}"`);
  return cfg.fields.splice(i, 1)[0];
}
