import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
}

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export const MM_TO_IN = 1 / 25.4;

/** ISO date (YYYY-MM-DD) helpers, all in local calendar terms. */
export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function today() { return isoDate(new Date()); }
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return isoDate(dt);
}
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
}

/**
 * fetch with retry + timeout. NOAA/IEM/K-State endpoints intermittently 5xx or
 * hang; a farm data pull should survive that rather than lose the day's record.
 */
export async function fetchWithRetry(url, { tries = 4, timeoutMs = 45000, accept = 'text' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'rainmonitor/1.0 (local farm rainfall tracking)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      return accept === 'json' ? JSON.parse(body) : body;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 1500 * 2 ** i));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url} failed after ${tries} tries: ${lastErr?.message}`);
}

/** IEM returns pandas "table" JSON: {schema:{fields:[...]}, data:[{...}]}. */
export function iemRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

/**
 * Treat non-finite / negative / absurd values as missing rather than storing junk.
 *
 * The null check is load-bearing: Number(null) and Number('') are both 0, so
 * without it a gauge that simply did not report becomes a confident "0.00 in"
 * — which reads as "no rain fell on this field" instead of "we don't know".
 * Many COOP gauges are volunteer-read and go silent for weeks at a time.
 */
export function cleanPrecipIn(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 30) return null;
  return Math.round(n * 1000) / 1000;
}
