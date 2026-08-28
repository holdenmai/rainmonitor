/**
 * One file, two homes: this same script runs against the dashboard's API and
 * against a published static copy on a web host that can serve nothing but
 * files. `static.js` — loaded ahead of this module, and only in the published
 * build — sets window.RM_STATIC and answers the read-only endpoints out of
 * pre-generated JSON.
 *
 * Forking this file for the static build was the alternative, and it would have
 * meant two copies of every chart drawer drifting apart. The charts are already
 * pure functions of the rows, so the only thing that has to differ is where the
 * rows come from — and which half of the page exists at all.
 */
const STATIC = !!window.RM_STATIC;
const apiGet = path => (STATIC ? window.RM_STATIC.get(path) : fetch(path).then(r => r.json()));

/**
 * The gridded series, in the order the palette was validated for — see the
 * note in style.css. rfcqpe / prism / mrms, not rfcqpe / mrms / prism, because
 * yellow beside orange is the one adjacent pair here that full-colour vision
 * struggles with and aqua between them fixes it.
 */
const GRID_SERIES = [
  { key: 'rfcqpe', label: 'RFC QPE', color: 'var(--series-rfcqpe)', note: 'NWS multi-sensor, ~2.5 mi grid' },
  { key: 'prism',  label: 'PRISM',   color: 'var(--series-prism)',  note: '~2.5 mi climate analysis' },
  { key: 'mrms',   label: 'Radar QPE', color: 'var(--series-mrms)', note: 'MRMS via IEM, ~7 mi grid' },
];

/** What `exclude.sources` can switch off. Gauges are switched off individually,
 *  in the table below the toggles, so these two are the "all of them" case. */
const SOURCE_TOGGLES = [
  { key: 'gauge',  label: 'Rain gauges' },
  { key: 'manual', label: 'Manual gauges' },
  ...GRID_SERIES,
];

/** Every source the export picker offers, matching SOURCES on the server. */
const EXPORT_SOURCES = [
  { key: 'gauge', label: 'Rain gauges' }, { key: 'manual', label: 'Manual gauges' },
  ...GRID_SERIES.map(s => ({ key: s.key, label: s.label })),
  { key: 'iemre', label: 'IEM reanalysis' },
];

/**
 * One line per gauge, nearest first, rather than a single "Rain gauge" that
 * silently switches between them from day to day.
 *
 * Two gauges four miles apart routinely disagree by half an inch on a summer
 * storm, and that disagreement is the reason for having both. Collapsing them
 * to the nearest one that reported hid it — and hid which gauge you were
 * reading, on the days it changed.
 */
const gaugeSeries = gauges => gauges.map((g, i) => ({
  key: g.key,
  label: g.name,
  color: `var(--series-g${i + 1})`,
  // The distance is dropped from the published copy along with the field's
  // coordinates — knowing a gauge is 4.2 miles from a field you can name is
  // most of the way to knowing where the field is. Omitted rather than zeroed:
  // Number(null) is 0, so an unguarded mi() would read "0.0 mi", which is not
  // "withheld", it is a claim that the gauge is standing in the field.
  note: [g.manual ? 'read by hand' : g.network.replace(/_/g, ' '),
    g.dist_km === null || g.dist_km === undefined ? null : mi(g.dist_km)].filter(Boolean).join(', '),
  gauge: g,
}));

/**
 * What two *fields* can be compared on.
 *
 * Not gauge by gauge. This field's nearest COOP station and that one's are
 * different pieces of ground, and pairing them by slot would put two stations
 * under one colour and call it the same series. So this is the one place the
 * derived `gauge` column is charted, and it is the right place for it: that
 * column is by definition the one-number-per-field answer, which is exactly the
 * granularity a field-against-field question is asked at.
 *
 * The colours are the palette's validated two-gauge prefix — `--series-gauge`
 * *is* `--series-g1`, manual takes g2 — so the run into the three gridded hues
 * is one the CVD gates were already cleared for.
 */
const fieldSeries = (rows, other) => [
  { key: 'gauge', label: 'Rain gauges', color: 'var(--series-gauge)' },
  ...([...rows, ...other].some(r => has(r.manual))
    ? [{ key: 'manual', label: 'Manual gauges', color: 'var(--series-g2)' }] : []),
  ...GRID_SERIES,
];

// What is actually drawn, rebuilt per field: which gauges a field has, and how
// many of them count, is a property of the field.
let SERIES = GRID_SERIES;

/**
 * Series switched off on the charts for the moment.
 *
 * Deliberately not `exclude.sources`, which is the permanent answer to "what
 * counts for this field" and changes every number on the page, the CSV and the
 * derived rows behind them. This is the temporary one: seven series over ninety
 * days is a thicket when the question is "did those two gauges agree", and the
 * cure is putting five of them away for a minute, not editing the field.
 *
 * It lives in memory and nowhere else. A reload brings everything back, which is
 * what keeps a glance from quietly becoming a setting — and what keeps a hidden
 * series from ever being mistaken for one that reported nothing.
 */
const hiddenSeries = new Set();
const shownSeries = () => SERIES.filter(s => !hiddenSeries.has(s.key));
const SVG = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, kids = []) => {
  const e = document.createElementNS(SVG, n);
  for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  for (const c of [].concat(kids)) e.append(c);
  return e;
};
const fmt = v => (v === null || v === undefined ? '—' : v.toFixed(2));
// Distances arrive in km — the column and the great-circle maths are metric —
// and are never shown that way. Same constant as src/util.js; there is no
// module shared between the two sides and one multiplication is not worth one.
const MI_PER_KM = 0.621371;
const mi = km => `${(km * MI_PER_KM).toFixed(1)} mi`;
const has = v => v !== null && v !== undefined;
const mdy = d => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}`; };

/* ---------- local-calendar dates, same convention as src/util.js ---------- */
// Built from local components on purpose: a 6pm storm belongs to the day it
// fell on here, not to whatever UTC calls that instant.
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = () => isoLocal(new Date());
const addDaysIso = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return isoLocal(new Date(y, m - 1, d + n));
};
const daysBetweenIso = (a, b) => {
  const [[ya, ma, da], [yb, mb, dbb]] = [a, b].map(s => s.split('-').map(Number));
  return Math.round((new Date(yb, mb - 1, dbb) - new Date(ya, ma - 1, da)) / 86400000);
};
/**
 * Same month and day, n years off — string surgery, not date arithmetic.
 * `new Date` would roll February 29th to March 1st and widen the window by a
 * day without saying so; the last day of February is the honest answer.
 *
 * The clamp is not cosmetic: `isIsoDate()` on the server rejects `2027-02-29`
 * as the non-date it is and quietly falls back to a default window, so a range
 * bound that lands on a leap day would silently compare the wrong dates. It can
 * only happen within a month of February 29th of a leap year, which is exactly
 * the kind of bug that waits four years to be found.
 */
const shiftYears = (iso, n) => {
  const y = Number(iso.slice(0, 4)) + n;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return `${y}-${iso.slice(5) === '02-29' && !leap ? '02-28' : iso.slice(5)}`;
};
/** Alignment key for the overlay: the same square on the calendar. */
const monthDay = iso => iso.slice(5);

/**
 * First year PRISM exists. Verified 2026-08-15 against the farm's own
 * coordinates: 1950 returns rows with a null PRISM column, 1981 and later
 * return real numbers for every day. IEMRE goes back further, but PRISM is the
 * one that tracks this farm's gauge closely enough to be worth reading as
 * history, so it is what "all history" is scaled to.
 */
const PRISM_FROM = 1981;

/** Bar with rounded data-end, square against the baseline. */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0.5) return `M${x} ${y + h} h${w}`;
  const rr = Math.min(r, w / 2, h);
  return `M${x} ${y + h} L${x} ${y + rr} Q${x} ${y} ${x + rr} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h} Z`;
}
/** The mirror of it: grows down from the baseline, rounded at the bottom end. */
function barPathDown(x, y, w, h, r = 4) {
  if (h <= 0.5) return `M${x} ${y} h${w}`;
  const rr = Math.min(r, w / 2, h);
  return `M${x} ${y} L${x} ${y + h - rr} Q${x} ${y + h} ${x + rr} ${y + h} L${x + w - rr} ${y + h} Q${x + w} ${y + h} ${x + w} ${y + h - rr} L${x + w} ${y} Z`;
}
function niceTicks(max, count = 4) {
  if (max <= 0) return { top: 1, ticks: [0, 0.5, 1] };
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = []; for (let t = 0; t <= top + 1e-9; t += step) ticks.push(+t.toFixed(6));
  return { top, ticks };
}

const tip = document.getElementById('tooltip');
function showTip(evt, title, rows, note) {
  tip.innerHTML = `<div class="tt-title">${title}</div>` +
    rows.map(r => `<div class="tt-row"><span class="k">${r.k}</span><span>${r.v}</span></div>`).join('') +
    (note ? `<div class="tt-note">${note}</div>` : '');
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(evt.clientX + pad, innerWidth - w - 8) + 'px';
  tip.style.top = Math.max(8, Math.min(evt.clientY - h - pad, innerHeight - h - 8)) + 'px';
}
const hideTip = () => { tip.hidden = true; };

/**
 * The legend is also the switch: clicking a series takes it off both charts
 * until it is clicked back on.
 *
 * Put here rather than in a row of checkboxes above the chart because the
 * legend is already the list of what is drawn, and it is already where the eye
 * goes to ask "which one is that". A second list of the same names would be a
 * second thing to keep in step.
 *
 * A hidden series keeps its place in the legend, struck through — it has to
 * stay visible, or a source that was put away for a minute is indistinguishable
 * from one that has no data, which is the one confusion this whole file is
 * built to avoid.
 */
function legendInto(node, items, notes = {}, extra = '') {
  const off = items.filter(s => hiddenSeries.has(s.key)).length;
  node.innerHTML = items.map(s => {
    const hid = hiddenSeries.has(s.key);
    return `<button type="button" class="item${hid ? ' off' : ''}" data-series="${esc(s.key)}"`
      + ` aria-pressed="${hid ? 'false' : 'true'}" title="${hid ? 'Show' : 'Hide'} ${esc(s.label)} on the charts">`
      + `<span class="swatch" style="background:${s.color}"></span>${esc(s.label)}`
      // Only the gauges carry their note into the legend — which network and how
      // far out — because that is what tells two station names apart. The gridded
      // sources are described in the card's own text.
      + (s.gauge ? ` <span class="none">${esc(s.note)}</span>` : '')
      + (notes[s.key] ? ` <span class="none">${esc(notes[s.key])}</span>` : '') + '</button>';
  }).join('') + extra
    + (off ? `<button type="button" class="item back" data-series="*">Show all (${off} hidden)</button>` : '');

  node.querySelectorAll('[data-series]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.series;
    if (k === '*') hiddenSeries.clear();
    else if (!hiddenSeries.delete(k)) hiddenSeries.add(k);
    // A redraw, not a reload: the rows on screen are the rows either way, and a
    // round trip per click would make putting a series away feel like a query.
    renderCharts();
  }));
}

/** One place for the comparison year's two non-hue signals. */
const CMP_FADE = 0.55;
const CMP_DASH = '7 4';

/**
 * How the two sides of a comparison are told apart, spelled out beside the
 * series. The same key serves both kinds: two years of one field, or two fields
 * over one window — which is the point of encoding it this way at all.
 *
 * The other side rides on position (above or below the baseline) and stroke
 * form (solid or dashed) — never on a second set of hues. One of the people
 * reading this is colourblind, and "the same source, the other year" is exactly
 * the pairing a shifted hue destroys: shift it far enough to be visible and the
 * two stop reading as the same series; keep it close and it is invisible.
 * Position and dash survive any vision, any print, and forced-colors mode.
 *
 * The glyphs wear the legend's own ink, not a series colour — identity is
 * already carried by the swatches above; this key is about form.
 */
function yearKeyHtml(kind, curYear, cmpYear) {
  const rule = dash => `<svg class="ykey" viewBox="0 0 24 14" aria-hidden="true"><path d="M1 7h22" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/></svg>`;
  // The baseline wears the legend's own ink at half strength rather than
  // --axis: at 14px the axis grey disappears into the card in dark mode, and
  // without the line there is nothing for "above" and "below" to be relative to.
  const bar = down => `<svg class="ykey" viewBox="0 0 24 14" aria-hidden="true"><path d="M1 7h22"
    stroke="currentColor" stroke-width="1" opacity="0.45"/><rect x="8" y="${down ? 7 : 1}" width="8" height="6"
    rx="2" fill="currentColor"${down ? ` opacity="${CMP_FADE}"` : ''}/></svg>`;
  const item = (glyph, label) => `<span class="item">${glyph}${label}</span>`;
  return kind === 'bars'
    ? item(bar(false), `${curYear} above`) + item(bar(true), `${cmpYear} below`)
    : item(rule(), curYear) + item(rule(CMP_DASH), cmpYear);
}

/* ---------- Chart 1: daily rainfall, grouped bars ---------- */
/**
 * `cmp` — `{ kind, cur, prev }`, the two sides — mirrors the comparison below
 * the baseline rather than squeezing a second bar into every day's slot.
 *
 * Pairing the bars sideways would halve a width that is already under two
 * pixels at 90 days with seven series, and the only channel left to mark the
 * other side with would have been colour. Up versus down costs no width and is
 * readable by anyone. It also puts each pair back to back, which is the
 * comparison — "more or less than the same day last year", or "more or less
 * than the north eighty" — is one glance at which side of the line is longer.
 *
 * `series` is passed in rather than read from the module binding because the
 * legend can put some of them away; SERIES stays the full list so they can be
 * fetched back out.
 */
function drawDaily(svg, rows, binLabel, cmp, series) {
  const W = 1100, H = cmp ? 430 : 300;
  const m = { t: 14, r: cmp ? 56 : 16, b: 34, l: 44 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.replaceChildren();
  if (!rows.length) return;

  // One scale for both halves: a bar above and a bar below are the same inches
  // per pixel, or the chart would be inventing the comparison it is drawing.
  const max = Math.max(0.1, ...rows.flatMap(r =>
    series.flatMap(s => [r[s.key] ?? 0, cmp ? (r[`c:${s.key}`] ?? 0) : 0])));
  const { top, ticks } = niceTicks(max);
  const half = cmp ? ph / 2 : ph;
  const base = m.t + half;                 // mid-plot when comparing, the floor otherwise
  const y = v => base - (v / top) * half;
  const yDown = v => base + (v / top) * half;
  const gw = pw / rows.length;
  // Slot the bars rather than sizing them and hoping. The old form subtracted a
  // fixed 2px gap and clamped the remainder, so once the group got tight the
  // bars kept their stride and marched over the next day's slot — already true
  // at 90 days, and worse now a field can draw seven series. The gap shrinks
  // with the slot instead, which keeps the group inside its own day.
  const slot = Math.max(0.8, (gw - 4) / Math.max(1, series.length));
  const bw = Math.max(0.8, slot - Math.min(2, slot * 0.3));  // surface gap between adjacent bars

  for (const t of ticks) {
    // Below the line the ticks count away from zero again — the mirrored half is
    // the same positive inches, not a negative quantity.
    for (const gy of cmp && t > 0 ? [y(t), yDown(t)] : [y(t)]) {
      svg.append(el('line', { class: 'grid-line', x1: m.l, x2: m.l + pw, y1: gy, y2: gy }));
      svg.append(el('text', { class: 'tick', x: m.l - 8, y: gy + 4, 'text-anchor': 'end' }, [t.toFixed(2)]));
    }
  }
  svg.append(el('line', { class: 'axis-line', x1: m.l, x2: m.l + pw, y1: base, y2: base }));
  if (cmp) {
    // Which side is which, said on the chart itself rather than only in the
    // legend — the reader is looking at the bars, not back up at the card head.
    // A year is four characters and a field name is not, so it is clipped to the
    // margin; the legend's key carries it in full.
    const edge = t => (t.length > 9 ? `${t.slice(0, 8)}…` : t);
    svg.append(el('text', { class: 'dlabel', x: m.l + pw + 8, y: base - 6 }, [edge(cmp.cur)]));
    svg.append(el('text', { class: 'dlabel', x: m.l + pw + 8, y: base + 15, opacity: 0.75 }, [edge(cmp.prev)]));
  }

  const every = Math.max(1, Math.ceil(rows.length / 14));
  rows.forEach((r, i) => {
    const gx = m.l + i * gw;
    const band = el('rect', { class: 'band', x: gx, y: m.t, width: gw, height: ph, fill: 'transparent' });
    svg.append(band);

    series.forEach((s, si) => {
      const bx = gx + 2 + si * slot;
      const v = r[s.key];
      if (has(v)) svg.append(el('path', { d: barPath(bx, y(v), bw, base - y(v)), fill: s.color }));
      const p = cmp ? r[`c:${s.key}`] : null;
      // Faded as well as mirrored: this year is the one being read, last year is
      // the reference behind it. The fade is a third signal, never the only one.
      if (has(p)) svg.append(el('path', {
        d: barPathDown(bx, base, bw, yDown(p) - base), fill: s.color, opacity: CMP_FADE,
      }));
    });

    band.addEventListener('mousemove', e => {
      band.classList.add('on');
      // Each gauge names itself here, so the old "which station did this figure
      // come from" footnote has nothing left to explain.
      // Two fields share one date, so only a year comparison has a second one
      // to name here.
      showTip(e, cmp?.kind === 'year' ? `${r.date} vs ${r.cdate ?? '—'}` : r.date, series.map(s => ({
        k: `<span class="dot" style="background:${s.color}"></span>${esc(s.label)}`,
        v: (has(r[s.key]) ? `${fmt(r[s.key])}"` : 'no report')
          + (cmp ? ` <span class="prev">${has(r[`c:${s.key}`]) ? `${fmt(r[`c:${s.key}`])}"` : 'no report'}</span>` : ''),
      })));
    });
    band.addEventListener('mouseleave', () => { band.classList.remove('on'); hideTip(); });

    if (i % every === 0) svg.append(el('text', {
      class: 'tick', x: gx + gw / 2, y: H - 12, 'text-anchor': 'middle',
    }, [binLabel(r.date)]));
  });
}

/* ---------- Chart 2: cumulative lines ---------- */
/**
 * `cmp` — `{ kind, cur, prev }` — overlays the comparison directly rather than
 * shifting it. Two cumulative lines that start from the same zero on the same
 * day of the calendar are meant to be read against each other, and the gap
 * between them at any point *is* the answer; moving one sideways would turn
 * that gap into a lie. The other side is carried by the dash, the same hue per
 * source on both, so a source stays one colour across both years — or across
 * both fields, where the gap between a solid line and its dashed twin is how
 * much further apart the ground is than the sources are.
 */
function drawCumulative(svg, rows, cmp, binLabel, series) {
  // Right margin holds the direct end-labels, which are mandatory at 4 series —
  // and carry both years' totals when comparing, so they need more room.
  const W = 1100, H = 280, m = { t: 14, r: cmp ? 168 : 124, b: 34, l: 44 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.replaceChildren();
  if (!rows.length) return;

  // Accumulate only from each series' first real observation. Starting every
  // line at index 0 would draw a source with no history — RFC QPE publishes no
  // archive — as a flat zero across the whole range, which reads as "measured
  // nothing" rather than "wasn't collecting yet".
  const cum = {}, from = {};
  const run = key => {
    const start = rows.findIndex(r => has(r[key]));
    if (start < 0) return;
    from[key] = start;
    let a = 0;
    cum[key] = rows.slice(start).map(r => (a += r[key] ?? 0));
  };
  for (const s of series) { run(s.key); if (cmp) run(`c:${s.key}`); }
  const drawn = series.filter(s => cum[s.key] || (cmp && cum[`c:${s.key}`]));
  if (!drawn.length) return;
  // `cum` only ever holds the series that were passed in, so a series the legend
  // has put away is off the axis too — the rest re-scale to fill the plot.
  const max = Math.max(0.1, ...Object.values(cum).map(c => c.at(-1)));
  const { top, ticks } = niceTicks(max);
  const x = i => m.l + (rows.length === 1 ? pw / 2 : (i / (rows.length - 1)) * pw);
  const y = v => m.t + ph - (v / top) * ph;

  for (const t of ticks) {
    svg.append(el('line', { class: 'grid-line', x1: m.l, x2: m.l + pw, y1: y(t), y2: y(t) }));
    svg.append(el('text', { class: 'tick', x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, [t.toFixed(2)]));
  }
  svg.append(el('line', { class: 'axis-line', x1: m.l, x2: m.l + pw, y1: y(0), y2: y(0) }));

  const path = (key, color, dash) => el('path', {
    d: cum[key].map((v, i) => `${i ? 'L' : 'M'}${x(i + from[key]).toFixed(1)} ${y(v).toFixed(1)}`).join(' '),
    fill: 'none', stroke: color, 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    'stroke-dasharray': dash ? CMP_DASH : null, opacity: dash ? 0.85 : null,
  });

  // The comparison underneath: the solid line is the one being read, and where
  // the two run together it should be the one on top.
  if (cmp) for (const s of drawn) if (cum[`c:${s.key}`]) {
    svg.append(path(`c:${s.key}`, s.color, true));
    // Hollow end-marker against this year's filled one — the same solid/outline
    // pairing the dash makes, at the point the eye actually lands on.
    svg.append(el('circle', {
      cx: x(rows.length - 1), cy: y(cum[`c:${s.key}`].at(-1)), r: 4,
      fill: 'var(--surface-1)', stroke: s.color, 'stroke-width': 2,
    }));
  }

  const ends = [];
  for (const s of drawn) {
    if (!cum[s.key]) continue;
    svg.append(path(s.key, s.color, false));
    const last = cum[s.key].at(-1);
    svg.append(el('circle', { cx: x(rows.length - 1), cy: y(last), r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    ends.push({ s, last, prev: cmp ? cum[`c:${s.key}`]?.at(-1) ?? null : null, at: y(last) });
  }

  // Direct labels at the line ends — identity without relying on the legend
  // alone. Two sources that agree land on the same pixel, which with seven
  // series is the normal case rather than the unlucky one, so they are nudged
  // apart afterwards: the dot stays on the data, only the text moves.
  const GAP = 13;
  ends.sort((a, b) => a.at - b.at);
  let floor = m.t + 4;
  for (const e of ends) { e.y = Math.max(e.at, floor); floor = e.y + GAP; }
  const over = ends.length ? ends.at(-1).y - (m.t + ph) : 0;
  if (over > 0) for (const e of ends) e.y -= over;
  for (const e of ends) {
    // The margin holds roughly this much text; a COOP station name can be far
    // longer than the label slot, and the legend spells it out in full. Both
    // sides share one label rather than getting one each: fourteen end-labels
    // on a 230px plot is not a label layer, it is a wall.
    const cap = cmp ? 11 : 13;
    const name = e.s.label.length > cap ? `${e.s.label.slice(0, cap - 1)}…` : e.s.label;
    svg.append(el('text', { class: 'dlabel', x: x(rows.length - 1) + 10, y: e.y + 4 },
      [`${name} ${e.last.toFixed(2)}"${cmp ? ` (${e.prev === null ? '—' : e.prev.toFixed(2)})` : ''}`]));
  }

  const every = Math.max(1, Math.ceil(rows.length / 10));
  rows.forEach((r, i) => { if (i % every === 0)
    svg.append(el('text', { class: 'tick', x: x(i), y: H - 12, 'text-anchor': 'middle' }, [binLabel(r.date)])); });

  const cross = el('line', { class: 'axis-line', y1: m.t, y2: m.t + ph, opacity: 0 });
  svg.append(cross);
  const hit = el('rect', { class: 'hit', x: m.l, y: m.t, width: pw, height: ph });
  svg.append(hit);
  hit.addEventListener('mousemove', e => {
    const bb = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(rows.length - 1,
      Math.round(((e.clientX - bb.left) / bb.width * W - m.l) / pw * (rows.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
    const through = (key, unit) => {
      const j = i - from[key];
      return !cum[key] || j < 0 ? 'not collecting yet' : `${cum[key][j].toFixed(2)}${unit}`;
    };
    showTip(e, cmp?.kind === 'year' ? `Through ${rows[i].date} vs ${rows[i].cdate ?? '—'}`
      : `Through ${rows[i].date}`,
      drawn.map(s => ({
        k: `<span class="dot" style="background:${s.color}"></span>${esc(s.label)}`,
        v: through(s.key, '"') + (cmp ? ` <span class="prev">${through(`c:${s.key}`, '"')}</span>` : ''),
      })));
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); hideTip(); });
}

/* ---------- Chart 3: field comparison, horizontal bars ---------- */
/**
 * Season to date, one bar per field — or, when two years are being compared,
 * both of those years for every field at once. Which farm was wetter in 1996
 * than in 2012 is a question about all of the ground, not about the one field
 * the charts above are drawn for.
 *
 * The paired bars are **whole calendar years** while the charts above show
 * whatever window was picked, and the heading and the note both say so. Making
 * them agree would mean a per-field total for an arbitrary window, and this card
 * is answered out of one small pre-built file so the published copy can draw it
 * too — an arbitrary window for every field means shipping every field's daily
 * history to the browser to draw one bar apiece. A year is the unit this gets
 * asked in, so the honest fix is to label it rather than to fake it.
 *
 * Same encoding as the charts above: the comparison year sits under its
 * counterpart and is faded, never given a second hue.
 */
function drawFields(svg, summaries, fields, activeId, cmp, totals) {
  const pair = cmp?.kind === 'year' ? cmp : null;
  const rowH = pair ? 48 : 30, m = { t: 8, r: 130, b: 26, l: 132 };
  const W = 1100, H = m.t + m.b + summaries.length * rowH;
  const pw = W - m.l - m.r;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.replaceChildren();

  const name = id => fields.find(f => f.id === id)?.name ?? id;
  // Year to date on both sides whenever one of the two years is this one: this
  // one is not finished, and a whole 1996 set against eight months of 2026 is
  // not a comparison, it is a head start. Two years that are both over are
  // compared whole.
  const partial = !!pair && [pair.cur, pair.prev].includes(todayIso().slice(0, 4));
  const yearVal = (id, y) => {
    const t = (totals?.[id] ?? []).find(r => r.y === y);
    return { v: t ? (partial ? t.ytd : t.total) : null, src: t?.src ?? null };
  };
  const best = s => s.season.mrms ?? s.season.gauge ?? s.season.prism ?? 0;
  const bars = s => (pair
    ? [{ ...yearVal(s.field_id, pair.cur), label: pair.cur },
       { ...yearVal(s.field_id, pair.prev), label: pair.prev, down: true }]
    : [{ v: best(s), src: null, label: null }]);

  const max = Math.max(0.1, ...summaries.flatMap(s => bars(s).map(b => b.v ?? 0)));
  const { top, ticks } = niceTicks(max);
  const x = v => m.l + (v / top) * pw;

  for (const t of ticks) {
    svg.append(el('line', { class: 'grid-line', x1: x(t), x2: x(t), y1: m.t, y2: m.t + summaries.length * rowH }));
    svg.append(el('text', { class: 'tick', x: x(t), y: H - 10, 'text-anchor': 'middle' }, [t.toFixed(1)]));
  }

  const SRC = { mrms: 'radar QPE', gauge: 'rain gauges', prism: 'PRISM' };
  summaries.forEach((s, i) => {
    const yc = m.t + i * rowH, bh = 15, gap = 4;
    // Both are highlighted when two fields are being compared — neither of them
    // is the other one.
    const active = s.field_id === activeId || s.field_id === cmp?.id;
    svg.append(el('text', {
      class: 'dlabel', x: m.l - 10, y: yc + rowH / 2 + 4, 'text-anchor': 'end',
      fill: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    }, [name(s.field_id)]));

    const g = el('g');
    const list = bars(s);
    const first = yc + (rowH - (list.length * bh + (list.length - 1) * gap)) / 2;
    list.forEach((b, k) => {
      const by = first + k * (bh + gap);
      // Horizontal bar: the rounded data-end sits on the right, square at the baseline.
      g.append(el('path', {
        d: hbarPath(m.l, by, Math.max(0.5, x(b.v ?? 0) - m.l), bh),
        fill: 'var(--series-gauge)', opacity: (b.down ? CMP_FADE : 1) * (active ? 1 : 0.55),
      }));
      // The year rides on the value label as well as on position: two bars a few
      // pixels apart is a weak signal on its own, and this row is read across.
      g.append(el('text', {
        class: 'dlabel', x: x(b.v ?? 0) + 10, y: by + bh / 2 + 4, opacity: b.down ? 0.8 : 1,
      }, [has(b.v) ? `${b.v.toFixed(2)}"${b.label ? ` ${b.label}` : ''}` : `— ${b.label ?? ''}`]));
    });

    const hit = el('rect', { class: 'hit', x: m.l, y: yc, width: pw, height: rowH });
    hit.addEventListener('mousemove', e => showTip(e, name(s.field_id),
      pair
        ? list.map(b => ({ k: b.label, v: has(b.v) ? `${b.v.toFixed(2)}"` : 'no record' }))
        : [
          { k: 'Season to date', v: `${list[0].v.toFixed(2)}"` },
          { k: 'Last 7 days', v: `${fmt(s.d7.mrms ?? s.d7.gauge)}"` },
          { k: 'Days since rain', v: s.days_since_rain ?? '—' },
        ],
      // Which source answered is part of the number before radar exists: a year
      // measured by PRISM beside one measured by radar has to say so.
      pair
        ? `${partial ? `January 1st to ${mdy(todayIso())}` : 'whole calendar years'}, from `
          + `${[...new Set(list.map(b => SRC[b.src]).filter(Boolean))].join(' and ') || 'nothing stored'}`
        : null));
    hit.addEventListener('mouseleave', hideTip);
    g.append(hit); svg.append(g);
  });
}
function hbarPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, h / 2, w);
  return `M${x} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h - rr} Q${x + w} ${y + h} ${x + w - rr} ${y + h} L${x} ${y + h} Z`;
}

/* ---------- binning for long ranges ---------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How coarse the bars have to be to stay drawable, from the span actually
 * returned rather than the span asked for — "All history" is a request for
 * whatever exists, and only the answer knows how much that is.
 */
function binFor(span) {
  return span > 5475 ? 'year' : span > 730 ? 'month' : span > 120 ? 'week' : 'day';
}
const binLabeller = mode =>
  mode === 'year' ? (d => d.slice(0, 4))
  : mode === 'month' ? (d => `${MONTHS[+d.slice(5, 7) - 1]} '${d.slice(2, 4)}`)
  : mdy;

/**
 * `keys` covers the comparison columns too, and the bins line up because both
 * years were merged onto one row per calendar day before binning.
 *
 * Weeks are chunks of seven from the start of the range; months and years group
 * by the calendar instead. A "month" of 30.4 days drifts, and lining August up
 * with August is the entire point of looking at forty years at once.
 */
function binRows(rows, keys, mode) {
  if (mode === 'day') return rows;
  const groups = [], byKey = new Map();
  rows.forEach((r, i) => {
    const k = mode === 'week' ? Math.floor(i / 7)
      : mode === 'month' ? r.date.slice(0, 7) : r.date.slice(0, 4);
    let g = byKey.get(k);
    if (!g) { g = []; byKey.set(k, g); groups.push(g); }
    g.push(r);
  });
  return groups.map(chunk => {
    // First day of the bin that found a counterpart, not the first day of the
    // bin: early in a range the other year may not have started collecting yet,
    // and a blank there would read as a broken tooltip rather than a gap.
    const o = { date: chunk[0].date, end: chunk.at(-1).date, cdate: chunk.find(r => r.cdate)?.cdate };
    for (const k of keys) {
      const vals = chunk.map(r => r[k]).filter(has);
      o[k] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
    }
    return o;
  });
}

/* ---------- comparison: another year, or another field ---------- */

/**
 * Fold the other side's rows onto these, so every chart, tooltip and table cell
 * reads one row carrying both.
 *
 * `keyOf` is what the two sides are matched on, and it is the whole difference
 * between the two comparisons. Another **year** matches on the calendar square,
 * which is what makes a leap year behave: February 29th simply has no
 * counterpart and stays missing, in both directions, instead of shunting every
 * later day one place out of step. Safe because no range that offers a year
 * comparison exceeds a year, so a month-day appears at most once on each side.
 * Another **field** matches on the date itself — same days, different ground —
 * and needs no such care.
 *
 * The dates that found no partner are returned so the note can own up to them:
 * a quarter inch that fell on the 29th of February is not nothing, and neither
 * is a day the other field has no row for because it was added last spring.
 */
function mergeCompare(rows, prev, keys, keyOf) {
  const by = new Map(prev.map(r => [keyOf(r.date), r]));
  const matched = new Set();
  for (const r of rows) {
    const p = by.get(keyOf(r.date));
    if (!p) continue;
    matched.add(p.date);
    r.cdate = p.date;
    for (const k of keys) r[`c:${k}`] = p[k] ?? null;
  }
  return prev.filter(p => !matched.has(p.date)).map(p => p.date);
}

/* ---------- app ---------- */
let META = null;
const $ = id => document.getElementById(id);

/**
 * What the two upper charts are currently drawn from.
 *
 * `load()` fetches and computes; this paints. They are separate because the
 * legend can put a series away, and that has to be a redraw of rows the page
 * already holds rather than a fresh round trip — over FTP-published files, a
 * refetch would mean re-downloading a chunk to hide a line.
 */
let view = null;

function renderCharts() {
  if (!view) return;
  const { chartRows, cumRows, bin, cmp, starts } = view;
  const shown = shownSeries();
  // The legends carry the full SERIES, not the visible ones — a series that has
  // been hidden has to stay clickable, and stays struck through until it is.
  legendInto($('legendDaily'), SERIES, starts, cmp ? yearKeyHtml('bars', cmp.cur, cmp.prev) : '');
  legendInto($('legendCum'), SERIES, starts, cmp ? yearKeyHtml('lines', cmp.cur, cmp.prev) : '');
  drawDaily($('chartDaily'), chartRows, binLabeller(bin), cmp, shown);
  drawCumulative($('chartCum'), cumRows, cmp, binLabeller(bin), shown);
}

/* ---------- farm filter ---------- */
// Empty set means "all farms" — an explicit all-selected state would silently
// stop including new farms as they are added.
const NO_FARM = '__no_farm__';
let farmSel = new Set();
try { farmSel = new Set(JSON.parse(localStorage.getItem('rm-farms') || '[]')); } catch { /* ignore */ }

const farmKey = f => f.farm || NO_FARM;
const visibleFields = () =>
  (META.fields ?? []).filter(f => !farmSel.size || farmSel.has(farmKey(f)));

function renderFarmFilter() {
  const farms = META.farms ?? [];
  const unassigned = META.fields.some(f => !f.farm);
  // Drop selections whose farm no longer exists, or the filter would keep
  // hiding fields for a reason nothing on screen explains.
  const live = new Set([...farms, ...(unassigned ? [NO_FARM] : [])]);
  for (const k of farmSel) if (!live.has(k)) farmSel.delete(k);

  const opts = [...farms.map(f => ({ k: f, label: f })),
                ...(unassigned ? [{ k: NO_FARM, label: 'No farm set' }] : [])];
  $('farmOptions').innerHTML = opts.length
    ? `<label><input type="checkbox" data-farm="*" ${farmSel.size ? '' : 'checked'}>All farms</label>
       <div class="sep"></div>` +
      opts.map(o => `<label><input type="checkbox" data-farm="${encodeURIComponent(o.k)}"`
        + `${farmSel.has(o.k) ? ' checked' : ''}>${esc(o.label)}</label>`).join('')
    : '<p class="none">No farms yet — set one on a field below.</p>';

  $('farmSummary').textContent = !farmSel.size ? 'All farms'
    : farmSel.size === 1 ? (farmSel.has(NO_FARM) ? 'No farm set' : [...farmSel][0])
    : `${farmSel.size} farms`;

  $('farmOptions').querySelectorAll('input').forEach(box => box.addEventListener('change', () => {
    const k = box.dataset.farm === '*' ? '*' : decodeURIComponent(box.dataset.farm);
    if (k === '*') farmSel.clear();
    else if (box.checked) farmSel.add(k); else farmSel.delete(k);
    localStorage.setItem('rm-farms', JSON.stringify([...farmSel]));
    renderFarmFilter();
    refreshFieldSelect();
    load();
  }));
}

/** Rebuild the field dropdown for the current farm filter, keeping the
 *  selection if it survives the filter. */
function refreshFieldSelect(prefer) {
  const sel = $('fieldSel');
  const want = prefer ?? sel.value;
  const list = visibleFields();
  sel.innerHTML = list.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  sel.value = list.some(f => f.id === want) ? want : (list[0]?.id ?? '');
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- pasting a coordinate pair ---------- */

/** One half of a pair: decimal, or degrees/minutes/seconds, with or without a
 *  hemisphere letter. Returns the signed value and which axis the letter names. */
function oneCoord(part) {
  const s = String(part).trim();
  const hemi = (/([NSEW])\s*$/i.exec(s) ?? /^([NSEW])/i.exec(s))?.[1]?.toUpperCase() ?? null;
  const nums = s.replace(/[NSEWnsew]/g, ' ').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length > 3) return null;
  const [d, m = 0, sec = 0] = nums.map(Number);
  const v = d + m / 60 + sec / 3600;
  const neg = s.trimStart().startsWith('-') || hemi === 'S' || hemi === 'W';
  return {
    value: Math.round((neg ? -v : v) * 1e6) / 1e6,
    axis: hemi === 'N' || hemi === 'S' ? 'lat' : hemi === 'E' || hemi === 'W' ? 'lon' : null,
  };
}

/**
 * "39.3861, -101.0523" -> both boxes.
 *
 * Everything that hands out coordinates gives them as a pair: a map, a GPS, the
 * header of a NOAA report. Both boxes are type="number", so a paste containing
 * a comma is discarded without a word — you get an empty box and no idea why.
 * Splitting the pair here is the difference between one paste and hand-copying
 * two halves of a number that must not be mistyped.
 *
 * Returns null for anything that is not a pair, so pasting a single number
 * still behaves like an ordinary paste.
 */
function parseLatLon(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // Where the halves divide, most reliable first. A comma settles it; failing
  // that a hemisphere letter marks the seam, which is what keeps
  // `39° 23' 10" N 101° 03' 08" W` from being chopped at its first space.
  const splits = t.includes(',') ? [t.split(',')] : [
    (/^(.*?[NS])\s+(.*[EW])$/i.exec(t) ?? []).slice(1),
    (/^([NS].*?)\s+([EW].*)$/i.exec(t) ?? []).slice(1),
    t.split(/\s+/),
  ];
  for (const parts of splits) {
    if (parts.length !== 2) continue;
    const a = oneCoord(parts[0]), b = oneCoord(parts[1]);
    if (!a || !b) continue;
    let [lat, lon] = [a, b];
    // A hemisphere letter settles the order outright. Failing that, a first
    // value past 90 can only be a longitude.
    if (a.axis === 'lon' || b.axis === 'lat') [lat, lon] = [b, a];
    else if (!a.axis && !b.axis && Math.abs(a.value) > 90 && Math.abs(b.value) <= 90) [lat, lon] = [b, a];
    if (Math.abs(lat.value) > 90 || Math.abs(lon.value) > 180) continue;
    return { lat: lat.value, lon: lon.value };
  }
  return null;
}

function wireCoordPaste(form) {
  // form.elements[...] rather than form[...]: a control called "name" or
  // "submit" shadows the form's own property of that name, and reaching for the
  // inputs one consistent way is cheaper than remembering which ones collide.
  const lat = form?.elements?.lat, lon = form?.elements?.lon;
  if (!lat || !lon) return;
  for (const box of [lat, lon]) box.addEventListener('paste', e => {
    const pair = parseLatLon(e.clipboardData?.getData('text') ?? '');
    if (!pair) return;                    // a single number pastes as it always did
    e.preventDefault();
    lat.value = pair.lat;
    lon.value = pair.lon;
  });
}

/**
 * The window the charts cover, as two dates.
 *
 * "Year to date" is the one range whose length changes as the year runs, which
 * is exactly why it is worth having: in August it is the number anyone actually
 * argues about, and a fixed 30/90/365 never lands on January 1st.
 *
 * `year` slides the whole window bodily into another year, keeping its
 * month-days: the last 30 days of 1996 are the same thirty squares of the
 * calendar the last 30 days of this year are. That is what lets a comparison be
 * 1996 against 1988 with neither side being now — and it is why the shift is
 * here, on the window, rather than in the comparison: the two halves are then
 * the same kind of thing, and either one can be any year.
 */
function rangeWindow(year) {
  const v = $('rangeSel').value;
  const now = todayIso();
  const thisYear = now.slice(0, 4);
  const to = year && year !== thisYear ? shiftYears(now, Number(year) - Number(thisYear)) : now;
  const y = to.slice(0, 4);
  if (v === 'ytd') return { from: `${y}-01-01`, to };
  // A finished year runs to December 31st and this one runs to today: there is
  // nothing after today, and a chart drawn to the end of December would put four
  // blank months on the axis where a reader sees "dry".
  if (v === 'year') return { from: `${y}-01-01`, to: y === thisYear ? now : `${y}-12-31` };
  // "All history" is a question, not a number of days: PRISM reaches back to
  // 1981 and IEMRE further, so how much there is depends on how deep a backfill
  // has been run. A floor no record predates asks for whatever exists.
  if (v === 'all') return { from: '1900-01-01', to };
  return { from: addDaysIso(to, -Number(v)), to };
}

/**
 * Which year the range is measured back from.
 *
 * A year the field has no rows for stays in the list while it is selected, named
 * as empty. Dropping it would reset the picker to this year without the charts
 * moving, so the page would be showing one year and saying another.
 */
function refreshYearSelect(years, want, thisYear) {
  const sel = $('yearSel');
  const list = (years ?? []).filter(y => y !== thisYear);
  const orphan = want && want !== thisYear && !list.includes(want) ? want : null;
  sel.innerHTML = '<option value="">This year</option>'
    + (orphan ? `<option value="${orphan}">${orphan} (no records)</option>` : '')
    + list.map(y => `<option value="${y}">${y}</option>`).join('');
  sel.value = orphan || list.includes(want) ? want : '';
  return sel.value;
}

/**
 * One picker, two kinds of comparison, and a value that says which — `y:1996`
 * or `f:north80`.
 *
 * Grouped in a single select rather than split into two, because they are
 * alternatives and not options: a second year *and* a second field at once is
 * four lines per source, which is a thicket rather than a comparison. A single
 * select is the one control that cannot be in both states at once, so the limit
 * needs no rule and no message to explain it.
 *
 * Above a 366-day range the year half is disabled rather than dropped: the
 * label is where the reason gets said, and an empty space says nothing.
 */
function refreshCompareSelect(years, baseYear, fields, fieldId, lockYears) {
  const sel = $('cmpSel');
  const want = sel.value;
  const yearOpts = (years ?? []).filter(y => y !== baseYear);
  const fieldOpts = fields.filter(f => f.id !== fieldId);
  const group = (label, opts, off) => (opts.length
    ? `<optgroup label="${esc(label)}"${off ? ' disabled' : ''}>${opts.join('')}</optgroup>` : '');
  sel.innerHTML = '<option value="">No comparison</option>'
    + group(lockYears ? 'Another year — pick a range under a year' : 'Another year',
      yearOpts.map(y => `<option value="y:${y}">${y}</option>`), lockYears)
    + group('Another field', fieldOpts.map(f => `<option value="f:${esc(f.id)}">${esc(f.name)}</option>`));
  const live = new Set([...(lockYears ? [] : yearOpts.map(y => `y:${y}`)),
    ...fieldOpts.map(f => `f:${f.id}`)]);
  sel.value = live.has(want) ? want : '';
  return sel.value;
}

async function load() {
  const fieldId = $('fieldSel').value;
  const thisYear = todayIso().slice(0, 4);
  const baseYear = $('yearSel').value;
  const { from, to } = rangeWindow(baseYear);
  const days = daysBetweenIso(from, to);
  // A window longer than a year has no year-over-year overlay, and that is a
  // correctness limit rather than a missing feature: the two years are folded
  // together on month-day, which stops being a unique key the moment a range
  // can contain the same calendar square twice. Comparing two *fields* has no
  // such limit — those rows are matched on the date itself.
  const overAYear = days > 366;
  // Read before the fetch so both halves go out together; the option lists are
  // reconciled against the answer afterwards.
  const asked = $('cmpSel').value;
  const cmpYear = !overAYear && asked.startsWith('y:') ? asked.slice(2) : '';
  const cmpField = asked.startsWith('f:') ? asked.slice(2) : '';
  const shift = cmpYear ? Number(cmpYear) - Number(to.slice(0, 4)) : 0;
  // Looking at a year that is not this one: every KPI tile is a window ending
  // today and always will be, so the year on screen needs a tile of its own.
  const past = baseYear && baseYear !== thisYear ? baseYear : null;
  // The only years the page can draw a total for — the tile's, and the two on
  // the all-fields bars. Asked for by name because totalling every stored year
  // is a full scan of `obs`, and this fetch happens on every picker change; see
  // the note in src/views.js. The published copy ignores the parameter and
  // answers with every year out of its one pre-built file, which is why the
  // shape is the same either way and the caller just looks up the year it wants.
  const wantYears = [...new Set([past, cmpYear && to.slice(0, 4), cmpYear].filter(Boolean))];
  const [{ rows, gauges, uncharted, years }, cmpRes, { summaries, yearTotals }, cal] = await Promise.all([
    apiGet(`/api/series?field=${fieldId}&from=${from}&to=${to}`),
    cmpYear
      ? apiGet(`/api/series?field=${fieldId}&from=${shiftYears(from, shift)}&to=${shiftYears(to, shift)}`)
      : cmpField ? apiGet(`/api/series?field=${cmpField}&from=${from}&to=${to}`)
      : null,
    apiGet(`/api/summary${wantYears.length ? `?years=${wantYears.join(',')}` : ''}`),
    apiGet('/api/calibration'),
  ]);
  const curYear = to.slice(0, 4);
  const fieldName = id => META.fields.find(f => f.id === id)?.name ?? id;
  refreshYearSelect(years, baseYear, thisYear);
  const picked = refreshCompareSelect(years, curYear, visibleFields(), fieldId, overAYear);
  // The picker can lose the selection when the field changes — a field added
  // last spring has no 2024, and a farm filter can take the other field off the
  // list. Nothing is drawn for a comparison that is no longer on offer.
  const live = picked === asked && cmpRes?.rows?.length;
  const cmp = live && cmpYear ? { kind: 'year', cur: curYear, prev: cmpYear }
    : live && cmpField
      ? { kind: 'field', id: cmpField, cur: fieldName(fieldId), prev: fieldName(cmpField) }
      : null;
  // The picker offers a year the field has *some* data for, which is not the
  // same as data for these dates — a field added in June has a 2024, just not a
  // February. Saying so beats an overlay that silently does not appear.
  const cmpEmpty = picked && !cmp;
  // Scoped to the field on screen: its gauges, in its order. A field with no
  // gauge in range draws the gridded sources and nothing else, rather than a
  // permanent "no data yet" for a gauge it does not have. Against another field
  // the gauges collapse to the derived per-field figure — see fieldSeries.
  SERIES = cmp?.kind === 'field'
    ? fieldSeries(rows, cmpRes.rows)
    : [...gaugeSeries(gauges ?? []), ...GRID_SERIES];
  // The other side folded onto these rows, so the charts, the tooltips and the
  // table all read one row per calendar day carrying both.
  const missed = cmp
    ? mergeCompare(rows, cmpRes.rows, SERIES.map(s => s.key),
      cmp.kind === 'year' ? monthDay : (d => d))
    : [];
  const me = summaries.find(s => s.field_id === fieldId) ?? {};
  const other = cmp?.kind === 'field' ? summaries.find(s => s.field_id === cmp.id) ?? {} : null;
  const field = META.fields.find(f => f.id === fieldId);

  // KPI tiles. Radar is the field-specific number; gauge is shown beside it so
  // the reader always sees whether the two agree.
  const pick = w => me[w] ?? {};
  // Headline prefers the finest grid that actually has a value. RFC QPE only
  // exists from the day it was switched on, so older windows fall back to MRMS
  // and the tile says which one it is rather than quietly mixing them.
  const headline = d => {
    const fine = has(d.rfcqpe) && d.rfcqpe > 0;
    return {
      v: fine ? d.rfcqpe : d.mrms,
      src: fine ? 'RFC QPE, ~2.5 mi grid' : 'Radar QPE, ~7 mi grid',
      col: fine ? 'var(--series-rfcqpe)' : 'var(--series-mrms)',
    };
  };
  const tile = (label, w, extra) => {
    const d = pick(w);
    const { v: r, src, col } = headline(d);
    // A line per gauge rather than one "gauge" figure: two gauges that read
    // differently over the same week is the thing worth seeing at a glance,
    // and it is exactly what a single number was hiding. Names are clipped by
    // CSS — the legend under the chart spells them out.
    const lines = SERIES.filter(s => s.gauge).map(s =>
      `<div class="meta" title="${esc(s.label)}"><span class="swatch" style="background:${s.color}"></span>`
      + `${esc(s.label)} ${has(d[s.key]) ? d[s.key].toFixed(2) + '"' : 'no report'}</div>`).join('');
    // The other field's figure for the same window, on the same tile. Comparing
    // two fields and then having to hold four numbers in your head to read the
    // tiles is how the charts below end up being the only honest part of the page.
    const vs = other ? headline(other[w] ?? {}) : null;
    const vsLine = vs
      ? `<div class="meta" title="${esc(cmp.prev)}"><span class="swatch" style="background:${vs.col}"></span>`
        + `${esc(cmp.prev)} ${has(vs.v) ? vs.v.toFixed(2) + '"' : 'no report'}</div>`
      : '';
    return `<div class="tile"><div class="label">${label}</div>
      <div class="value">${has(r) ? r.toFixed(2) : '—'}<span class="unit">in</span></div>
      <div class="meta"><span class="swatch" style="background:${col}"></span>${src}</div>
      ${lines}${vsLine}${extra ? `<div class="meta">${extra}</div>` : ''}</div>`;
  };
  const dry = me.days_since_rain;
  // `past` is settled before the fetch, because it decides which years are
  // asked for. Without a tile of its own "Season to date" would read as the
  // season on the charts rather than the one ending today.
  const yt = past ? (yearTotals?.[fieldId] ?? []).find(t => t.y === past) : null;
  const YT_SRC = { mrms: 'Radar QPE', gauge: 'Rain gauges', prism: 'PRISM' };
  $('kpis').innerHTML =
    (past
      ? `<div class="tile"><div class="label">${past}, whole year</div>
         <div class="value">${has(yt?.total) ? yt.total.toFixed(2) : '—'}<span class="unit">in</span></div>
         <div class="meta">${yt ? esc(YT_SRC[yt.src] ?? yt.src) : 'nothing stored for this field'}</div>
         <div class="meta">the tiles beside it are today's, as always</div></div>`
      : '') +
    tile('Last 24 hours', 'd1') +
    tile('Last 7 days', 'd7') +
    tile('Last 30 days', 'd30') +
    tile('Season to date', 'season', `since ${META.seasonStart}`) +
    `<div class="tile"><div class="label">Days since rain</div>
       <div class="value">${dry === null || dry === undefined ? '—' : dry}</div>
       <div class="meta">last measurable ≥ 0.01"</div></div>`;

  // From the span actually returned, not the one requested: "All history" only
  // knows how far back it goes once the answer is in, and a field added last
  // spring has less of it than the home place does.
  const span = rows.length ? daysBetweenIso(rows[0].date, rows.at(-1).date) : days;
  const bin = binFor(span);
  const keys = SERIES.flatMap(s => (cmp ? [s.key, `c:${s.key}`] : [s.key]));
  const chartRows = binRows(rows, keys, bin);
  const rfcFrom = rows.find(r => has(r.rfcqpe))?.date;
  const BIN_NOTE = {
    day: 'One bar per series per day. A missing bar means that one reported nothing — not that it stayed dry. ',
    week: 'Weekly totals. A blank slot means nothing reported for that week. ',
    month: 'Monthly totals, grouped by the calendar so August lines up with August. A blank slot means nothing reported that month. ',
    year: 'Annual totals, one bar per series per calendar year. The first and last years are partial unless the range covers them whole. ',
  };
  $('dailyNote').textContent = BIN_NOTE[bin]
    + (span > 366 && rows.length
        ? `${rows[0].date.slice(0, 4)} to ${rows.at(-1).date.slice(0, 4)}. Before 2014 the only gridded source is PRISM — and IEMRE behind it — so radar QPE is absent rather than zero for those years. `
        : '')
    + (cmp
        ? `${cmp.cur} is drawn above the line and ${cmp.prev} below it, same colour per source and the same scale on both halves, so the longer side is the wetter one. `
          + (cmp.kind === 'year' ? 'Matched by month and day. ' : 'Same days, different ground. ')
        : '')
    + (cmpEmpty
        ? `Nothing is drawn for ${cmpYear || fieldName(cmpField)}: no readings between `
          + `${cmpYear ? shiftYears(from, shift) : from} and ${cmpYear ? shiftYears(to, shift) : to}. `
        : '')
    + (missed.length
        ? `${missed.length === 1 ? `${missed[0]} is` : `${missed.length} days in ${cmp.prev} are`} left out — nothing on `
          + `${cmp.kind === 'year' ? "this year's side of the calendar" : `${cmp.cur}'s side`} to line up with `
          + `(${cmp.kind === 'year' ? 'February 29th, or ' : ''}a day this field has no row for). `
        : '')
    + (cmp?.kind === 'field'
        ? 'Two fields cannot be charted gauge by gauge — this field\'s nearest station and that one\'s are different ground — so the gauges collapse to one figure per field: the nearest one that reported that day. '
        : 'Each gauge is drawn on its own; where two of them disagree, that is two readings of two different pieces of ground, not an error. ')
    + 'PRISM and RFC QPE both run on a 12Z–12Z day, so a single storm can land on either side of midnight local; compare those over a week, not a day. '
    + (rfcFrom
        ? `RFC QPE is the finest grid here — about 2.5 miles across, roughly a section and a half — but it publishes no archive, so it only exists from ${rfcFrom} forward.`
        : 'RFC QPE (about 2.5 miles across) starts collecting on the next ingest — it publishes no archive, so it cannot be backfilled.')
    // Silent only while the individual gauges are on the chart at all: against
    // another field they have all collapsed into one figure, and there is no cap
    // left to own up to.
    + (uncharted?.length && cmp?.kind !== 'field'
        ? ` ${uncharted.join(' and ')} also count${uncharted.length === 1 ? 's' : ''} for this field but ${uncharted.length === 1 ? 'is' : 'are'} not drawn — there are four gauge colours that stay apart from each other and from the grid.`
        : '');
  // Flag series that only start partway through the range, so a short line
  // never reads as a source that measured nothing.
  const starts = {};
  for (const s of SERIES) {
    const i = rows.findIndex(r => has(r[s.key]));
    // The full date once the range spans years — "from 3/1" is no answer at all
    // when the chart covers four decades of March firsts.
    if (i > 0) starts[s.key] = `from ${span > 366 ? rows[i].date : mdy(rows[i].date)}`;
    else if (i < 0) starts[s.key] = 'no data yet';
  }
  // Held so the legend can redraw without asking the server for rows it already
  // has. The cumulative line runs off the binned rows once the range is measured
  // in years: the curve is identical at every bin boundary, and a single path of
  // sixteen thousand points is a quarter-megabyte of `d` attribute for detail no
  // one can see at this width.
  view = {
    chartRows, cumRows: bin === 'month' || bin === 'year' ? chartRows : rows,
    bin, cmp, starts,
  };
  renderCharts();
  // Years inside the range that returned nothing at all.
  //
  // The cumulative chart spaces its points by position, not by date, so a year
  // with no rows closes up instead of leaving a hole: three missing years draw
  // as one continuous climb, and the total at the end is the sum of what is
  // there presented as if it were an unbroken record. Naming the gap is far
  // cheaper than re-scaling the axis, and it is more useful too — it says
  // exactly which years to re-pull.
  const gapYears = [];
  if (rows.length) {
    const seen = new Set(rows.map(r => r.date.slice(0, 4)));
    for (let y = +rows[0].date.slice(0, 4); y <= +rows.at(-1).date.slice(0, 4); y++)
      if (!seen.has(String(y))) gapYears.push(y);
  }
  const gapNote = gapYears.length
    ? ` ${gapYears.length === 1 ? `${gapYears[0]} has` : `${gapYears.join(', ')} have`} no records at all, and this chart `
      + 'closes that gap up rather than leaving a hole — the totals are of what is stored, not of an unbroken run. '
      + '"Pull all history" under Data collection fills them in.'
    : '';
  $('cumNote').textContent = (cmp?.kind === 'year'
    ? `Both years accumulate from the same day of the calendar, so the vertical gap between a solid line and its dashed twin is how far ahead or behind ${cmp.cur} is running. `
      + 'Day-level binning differences wash out over a range like this, so a gap that keeps widening is a real disagreement about this field.'
    : cmp
    ? `Both fields accumulate over the same days, so the vertical gap between a solid line and its dashed twin is how far ahead or behind ${cmp.prev} is running against ${cmp.cur}. `
      + 'Where the gridded sources agree between the two fields and the gauges do not, that is the gauges being somewhere the grid has smoothed over.'
    : 'Accumulates across the range chosen above, not the whole season. This is the honest way to compare sources — day-level binning differences wash out, '
      + 'so a gap that keeps widening is a real disagreement about this field. Two gauges drifting apart over a month is the clearest reading you get of how much a few miles matters here.')
    + gapNote;
  const shown = visibleFields();
  const scope = farmSel.size ? ` ${shown.length} of ${META.fields.length} fields shown for the selected farm${farmSel.size > 1 ? 's' : ''}.` : '';
  // These bars are the one card that answers for every field at once, so when
  // two years are being compared they answer for both — and say, out loud, that
  // they are whole calendar years while the charts above are a chosen window.
  const yearPair = cmp?.kind === 'year';
  const bothOver = yearPair && ![cmp.cur, cmp.prev].includes(thisYear);
  $('fieldsTitle').textContent = yearPair
    ? `All fields, ${cmp.cur} against ${cmp.prev}` : 'All fields, season to date';
  $('fieldsNote').textContent = (yearPair
    ? `${cmp.cur} above, ${cmp.prev} below, for every field — ${bothOver ? 'whole calendar years'
        : `January 1st to ${mdy(todayIso())} in both years, because ${thisYear} is not finished`}. `
      + 'That is a different window from the charts above, which cover the range picked at the top. '
      + 'Radar QPE where it exists, this field\'s gauges before it does — the tooltip names which. '
    : `Radar QPE totals since ${META.seasonStart}. `)
    + (cmp?.kind === 'field' ? 'Both compared fields highlighted.' : 'Selected field highlighted.')
    + scope;
  drawFields($('chartFields'), summaries.filter(s => shown.some(f => f.id === s.field_id)),
    META.fields, fieldId, cmp, yearTotals);

  // Calibration: how the gridded products compare to the on-farm gauge.
  if (cal && cal.months?.length) {
    $('calCard').hidden = false;
    $('calNote').textContent =
      `${cal.station}, sampled against the grid at ${cal.sampledAt}. Cold months are shown separately because an `
      + `unheated tipping bucket barely registers snow — a winter gap is the gauge missing frozen precipitation, not the radar reading high.`;
    $('calTable').querySelector('thead').innerHTML =
      '<tr><th>Period</th><th>Your gauge</th><th>Radar QPE</th><th>PRISM</th><th>gauge ÷ radar</th><th>gauge ÷ PRISM</th></tr>';
    const row = (label, b, note) => b.months
      ? `<tr><td>${label}${note ? ` <span class="none">${note}</span>` : ''}</td>
         <td>${b.gauge.toFixed(2)}</td><td>${b.mrms.toFixed(2)}</td><td>${b.prism.toFixed(2)}</td>
         <td>${b.mrmsFactor ?? '—'}</td><td>${b.prismFactor ?? '—'}</td></tr>` : '';
    $('calTable').querySelector('tbody').innerHTML =
      row('Warm season', cal.warm, 'May–Sep') + row('Cold season', cal.cold, 'Oct–Apr') + row('All months', cal.all);

    const pf = cal.warm.prismFactor, mf = cal.warm.mrmsFactor;
    const bits = [];
    if (pf !== null && Math.abs(1 - pf) <= 0.06)
      bits.push(`PRISM tracks your gauge to within ${Math.round(Math.abs(1 - pf) * 100)}% — it assimilates gauge networks by design, so it has already done this correction. Use it as the estimate for fields with no gauge nearby.`);
    if (mf !== null)
      bits.push(`Radar QPE reads about ${Math.round((1 / mf - 1) * 100)}% high against your gauge in the warm season. Some of that is the gauge itself — unshielded buckets under-catch wind-driven rain by 5–15% out here — so the true bias sits between ${mf} and 1.00.`);
    if (cal.provisional) bits.push(`Provisional: only ${cal.warm.months} warm-season month${cal.warm.months === 1 ? '' : 's'} of overlap so far.`);
    $('calVerdict').innerHTML = bits.join(' ');
  } else {
    $('calCard').hidden = true;
  }

  // Table view — satisfies the relief rule for the sub-3:1 light-mode series.
  // Every gauge is its own column now, so the old "Gauge station" column —
  // which named whichever one the derived figure had fallen through to that
  // day — has nothing left to say.
  // The comparison year gets columns here too. A dashed line and a mirrored bar
  // are both readable, but "how much exactly, on that one day" is a number, and
  // the table is the one place every value on the charts is also written down.
  const cell = v => (has(v) ? `<td>${v.toFixed(2)}</td>` : '<td class="none">—</td>');
  $('dataTable').querySelector('thead').innerHTML = cmp
    ? `<tr><th rowspan="2">Date</th>${SERIES.map(s =>
        `<th colspan="2"><span class="dot" style="background:${s.color}"></span>${esc(s.label)}</th>`).join('')}</tr>`
      + `<tr>${SERIES.map(() => `<th>${cmp.cur}</th><th class="prev">${cmp.prev}</th>`).join('')}</tr>`
    : `<tr><th>Date</th>${SERIES.map(s =>
        `<th><span class="dot" style="background:${s.color}"></span>${esc(s.label)}</th>`).join('')}</tr>`;
  $('dataTable').querySelector('tbody').innerHTML = [...rows].reverse().map(r =>
    `<tr><td>${r.date}</td>${SERIES.map(s =>
      cell(r[s.key]) + (cmp ? cell(r[`c:${s.key}`]) : '')).join('')}</tr>`).join('');

  // The admin panels are refreshed here because they are scoped to the field on
  // screen. None of them exist in the published copy — the markup is cut, not
  // hidden — so they are skipped rather than guarded one lookup at a time.
  if (!STATIC) {
    renderExclusions(field);
    renderFields();
    renderStation();
    renderHistory();
    // `days` counts back from today, which is the right thing while today is on
    // screen — it exports at least a year whatever the charts are showing. Once
    // the Year picker has moved the window into 1996 it is the wrong thing
    // entirely, so that case exports the window itself.
    $('csvBtn').href = past
      ? `/api/export.csv?field=${fieldId}&from=${from}&to=${to}`
      : `/api/export.csv?field=${fieldId}&days=${Math.max(days, 400)}`;
  }
  $('subtitle').textContent = [
    field.farm ? `${field.farm} · ${field.name}` : field.name,
    // Coordinates are optional: the published copy can withhold them, and a
    // field that says where it is is exactly the thing worth withholding on a
    // public host. Checked rather than defaulted — Number(undefined) is NaN and
    // `0.0000, 0.0000` would be a confident answer off the Gulf of Guinea.
    has(field.lat) && has(field.lon) ? `${field.lat.toFixed(4)}, ${field.lon.toFixed(4)}` : null,
    field.acres ? `${field.acres} ac` : null,
  ].filter(Boolean).join(' · ');
  $('footer').textContent = `Sources: MRMS radar QPE and PRISM via IEM reanalysis; gauges via NWS COOP/ASOS and Kansas Mesonet. Last ingest ${META.lastIngest ?? 'never'} UTC.`;
}

/* ---------- software updates ---------- */
let updateInfo = null, updateListOpen = false;

function renderUpdate() {
  const u = updateInfo;
  // Which version this copy is on is also what decides whether a backup from
  // another machine can be restored here, so that panel follows this one.
  renderBackup();
  if (!u) return;
  const banner = $('updateBanner');
  const repo = u.repo ?? {};
  const cur = repo.current ? `${repo.current.sha} · ${repo.current.date}` : 'unknown';

  banner.hidden = !u.available;
  if (u.available) {
    $('updateBannerTitle').textContent =
      `An update is ready — ${u.behind} change${u.behind === 1 ? '' : 's'} since this copy was installed.`;
    $('updateBannerNote').textContent = u.edits?.length
      ? `Blocked: this copy has local edits to ${u.edits.slice(0, 3).join(', ')}. Updating would overwrite them.`
      : 'Takes a few seconds. Your fields, settings and rainfall history are not affected.';
    $('updateApply').disabled = !!u.edits?.length;
  }

  // The same button as in the banner. "Check now" is at the bottom of the page
  // and the banner is at the top, so checking from here used to answer "yes,
  // there is one" a full screen away from anything that would apply it.
  $('updateApplyHere').hidden = !u.available;
  $('updateApplyHere').disabled = !!u.edits?.length;

  const checked = u.lastCheckedAt ? `checked ${ago(u.lastCheckedAt)}` : 'not checked yet';
  $('updateStatus').innerHTML =
    !u.enabled ? '<span class="none">Update checking is switched off in config.json.</span>'
    : u.checking ? '<span class="spinner"></span><span>Checking for updates…</span>'
    : repo.updatable === false ? `<span class="none">${esc(repo.reason)}</span>`
    : u.error ? `<span class="none">Could not check for updates (${esc(u.error)}) — will try again later. This copy is ${esc(cur)}.</span>`
    : u.available ? `<span>${u.behind} update${u.behind === 1 ? '' : 's'} available. This copy is ${esc(cur)}, ${esc(checked)}.`
      + (u.edits?.length
        ? ` <span class="warn">Blocked: this copy has local edits to ${esc(u.edits.slice(0, 3).join(', '))}.</span>`
        : '') + '</span>'
    : `<span class="none">Up to date — this copy is ${esc(cur)}, ${esc(checked)}.</span>`;

  const show = updateListOpen && u.commits?.length;
  $('updateListWrap').hidden = !show;
  if (show) {
    $('updateTable').querySelector('thead').innerHTML = '<tr><th>Change</th><th>Date</th></tr>';
    $('updateTable').querySelector('tbody').innerHTML = u.commits.map(c =>
      `<tr><td>${esc(c.subject)}</td><td class="none">${esc(c.date)}</td></tr>`).join('');
  }
}

async function loadUpdate(force = false) {
  if (force) {
    updateInfo = { ...(updateInfo ?? {}), checking: true };
    renderUpdate();
  }
  updateInfo = await fetch(`/api/update${force ? '?check=1' : ''}`).then(r => r.json()).catch(() => null);
  renderUpdate();
}

/** Poll until the restarted server answers again, then reload onto the new code. */
async function waitForRestart(deadlineMs = 90_000) {
  const until = Date.now() + deadlineMs;
  // A beat first, so we do not catch the old process still answering.
  await new Promise(r => setTimeout(r, 1500));
  while (Date.now() < until) {
    try {
      const r = await fetch('/api/update', { cache: 'no-store' });
      if (r.ok) return true;
    } catch { /* still down, which is expected */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/** Shared by the banner at the top and the button in the panel at the bottom. */
async function applyUpdate() {
  if (!confirm('Download the update and restart the dashboard? It will be back in a few seconds.')) return;
  for (const id of ['updateApply', 'updateApplyHere']) $(id).disabled = true;
  $('updateBannerTitle').textContent = 'Updating…';
  $('updateBannerNote').textContent = 'Downloading the new version and restarting. This page will reload on its own.';
  $('updateStatus').innerHTML = '<span class="spinner"></span><span>Updating and restarting…</span>';
  const r = await fetch('/api/update', { method: 'POST' }).then(res => res.json()).catch(() => ({ error: 'no reply' }));
  if (r.error) {
    $('updateBannerTitle').textContent = 'Update stopped';
    $('updateBannerNote').textContent = r.error;
    $('updateStatus').innerHTML = `<span class="warn">${esc(r.error)}</span>`;
    for (const id of ['updateApply', 'updateApplyHere']) $(id).disabled = false;
    return;
  }
  if (!r.restarting) { await loadUpdate(); return; }
  if (await waitForRestart()) location.reload();
  else {
    $('updateBannerTitle').textContent = 'Updated, but the dashboard has not come back yet';
    $('updateBannerNote').textContent = 'Give it a moment and refresh this page. If it stays down, restart the computer.';
  }
}

function wireUpdates() {
  $('updateCheck').addEventListener('click', () => loadUpdate(true));
  $('updateDetails').addEventListener('click', () => { updateListOpen = !updateListOpen; renderUpdate();
    if (updateListOpen) $('updateCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });

  for (const id of ['updateApply', 'updateApplyHere']) $(id).addEventListener('click', applyUpdate);

  loadUpdate();
}

/* ---------- background jobs ---------- */
let jobTimer = null, jobWasRunning = false;

const ago = iso => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  return h < 36 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
};

async function pollJobs() {
  const s = await fetch('/api/jobs').then(r => r.json()).catch(() => null);
  if (!s) return;
  const running = s.running;
  const queued = s.queued?.length ? ` (${s.queued.length} more queued)` : '';

  if (running) {
    $('jobStatus').innerHTML = `<span class="spinner"></span><span>${esc(running.label)}`
      + `${running.note ? ` — ${esc(running.note)}` : ''}…${queued}</span>`;
    $('jobLog').hidden = false;
    $('jobLog').textContent = (running.lines ?? []).join('\n');
    $('jobLog').scrollTop = $('jobLog').scrollHeight;
  } else {
    const fails = Object.entries(s.last ?? {}).filter(([, v]) => !v.ok);
    const when = ago(s.lastIngestAt);
    $('jobStatus').innerHTML = fails.length
      ? `<span class="warn">Last ${esc(fails[0][0])} failed: ${esc(fails[0][1].error ?? 'unknown error')}</span>`
      : `<span class="none">${when ? `Up to date — last checked ${when}.` : 'No rainfall pulled yet.'}</span>`;
    $('jobLog').hidden = !jobWasRunning;
  }

  // Reload the charts once, on the transition out of running: the numbers on
  // screen are stale the moment a pull finishes.
  if (jobWasRunning && !running) {
    jobWasRunning = false;
    META = await fetch('/api/fields').then(r => r.json());
    renderFarmFilter();
    refreshFieldSelect();
    await load();
  }
  if (running) jobWasRunning = true;

  // Poll only while there is something to watch, so an idle dashboard left open
  // on a kitchen computer is not making a request every two seconds all day.
  clearTimeout(jobTimer);
  jobTimer = setTimeout(pollJobs, running || s.queued?.length ? 1500 : 60000);
}

/* ---------- how far back history goes ---------- */
const historyMsg = (t, bad) => note('historyMsg', t, bad);

/** The year box and the sentence under it, from the server's own answer rather
 *  than from a constant here — the floor is a property of what PRISM publishes. */
function renderHistory() {
  const h = META.history ?? {};
  const box = $('historyForm').elements.historyFromYear;
  const thisYear = new Date().getFullYear();
  box.min = h.floorYear ?? PRISM_FROM;
  box.max = thisYear;
  // Only fill the box when it is untouched, so re-rendering after a field edit
  // does not overwrite a year somebody is halfway through typing.
  if (!box.value) box.value = h.fromYear ?? ((h.sdate ?? '').slice(0, 4) || box.min);

  const have = h.earliest
    ? `The earliest day stored is ${h.earliest}.`
    : 'Nothing is stored yet.';
  historyMsg(`${have} This setting is also what a newly added field gets, so one added later arrives with the same `
    + `depth as the rest. ${box.min} is as far back as this goes — PRISM, the deepest daily source here, publishes `
    + 'nothing before it, and radar QPE only exists from about 2014.');
}

function wireHistory() {
  $('historyForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const year = Number(f.historyFromYear.value);
    const one = f.scope.value === 'one';
    const fields = one ? [$('fieldSel').value] : null;
    const n = one ? 1 : (META.fields ?? []).length;
    const years = Math.max(1, new Date().getFullYear() - year + 1);

    // Saved before it is run, and saved even for a one-field pull: the setting
    // is "how much history this farm keeps", which is a different question from
    // "which fields am I filling in right now".
    historyMsg('Saving…');
    const res = await fetch('/api/config/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ historyFromYear: year }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return historyMsg(body.error || `Failed (${res.status})`, true);

    // Roughly three seconds per year per field, measured. Worth stating before
    // the click rather than leaving someone watching a log for twenty minutes
    // wondering whether it has hung.
    const mins = Math.ceil(years * n * 3 / 60);
    if (!confirm(`Pull ${years} year${years === 1 ? '' : 's'} back to ${year} for `
      + `${one ? 'the selected field' : `all ${n} field${n === 1 ? '' : 's'}`}?\n\n`
      + `That is roughly ${mins} minute${mins === 1 ? '' : 's'}, and it runs in the background while you use the `
      + 'dashboard. Each year is saved as it arrives, so stopping partway keeps what it got and running it again '
      + 'picks up from there.')) {
      META = await fetch('/api/fields').then(r => r.json());
      return historyMsg(`Saved ${year} as the depth for new fields. Nothing pulled.`);
    }

    await startJob('backfill', { sdate: `${year}-01-01`, fields, note: `history back to ${year}` });
    META = await fetch('/api/fields').then(r => r.json());
    historyMsg(`Pulling ${years} year${years === 1 ? '' : 's'} back to ${year} — see the log above.`);
  });
}

async function startJob(job, extra = {}) {
  await fetch('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job, ...extra }),
  }).catch(() => {});
  jobWasRunning = true;
  clearTimeout(jobTimer);
  pollJobs();
}

function wireJobs() {
  $('jobIngest').addEventListener('click', () => startJob('ingest', { note: 'requested from the dashboard' }));
  $('jobDiscover').addEventListener('click', () => startJob('discover', { note: 'requested from the dashboard' }));
  // Only offered where publishing is switched on. The copy normally goes out by
  // itself after each collection run, so this is for "I changed something and
  // want it on the web now" rather than routine use.
  $('jobPublish').hidden = !META.publishing;
  $('jobPublish').addEventListener('click', () => startJob('publish', { note: 'requested from the dashboard' }));
  wireHistory();
  pollJobs();
}

/* ---------- export / import ---------- */
const exportMsg = (t, bad) => note('exportMsg', t, bad);
const importMsg = (t, bad) => note('importMsg', t, bad);

// Empty means every source, matching the farm filter's convention.
let exportSrc = new Set();

function renderExportSources() {
  const opts = EXPORT_SOURCES;
  $('exportSourceOptions').innerHTML =
    `<label><input type="checkbox" data-esrc="*" ${exportSrc.size ? '' : 'checked'}>All sources</label><div class="sep"></div>`
    + opts.map(o => `<label><input type="checkbox" data-esrc="${o.key}"${exportSrc.has(o.key) ? ' checked' : ''}>${esc(o.label)}</label>`).join('');
  $('exportSourcesLabel').textContent = !exportSrc.size ? 'All sources'
    : exportSrc.size === 1 ? (opts.find(o => o.key === [...exportSrc][0])?.label ?? [...exportSrc][0])
    : `${exportSrc.size} sources`;

  $('exportSourceOptions').querySelectorAll('input').forEach(box => box.addEventListener('change', () => {
    if (box.dataset.esrc === '*') exportSrc.clear();
    else if (box.checked) exportSrc.add(box.dataset.esrc); else exportSrc.delete(box.dataset.esrc);
    renderExportSources();
  }));
}

function exportQuery() {
  const fd = new FormData($('exportForm'));
  const scope = fd.get('scope');
  const ids = scope === 'one' ? [$('fieldSel').value]
    : scope === 'farm' ? visibleFields().map(f => f.id)
    : [];
  const q = new URLSearchParams({ from: fd.get('from'), to: fd.get('to') });
  if (ids.length) q.set('fields', ids.join(','));
  if (exportSrc.size) q.set('sources', [...exportSrc].join(','));
  return q;
}

function wireExport() {
  $('exportForm').to.value = todayIso();
  $('exportForm').from.value = addDaysIso(todayIso(), -14);
  renderExportSources();

  const download = path => {
    const q = exportQuery();
    if (q.get('from') > q.get('to')) return exportMsg('The "from" date is after the "to" date.', true);
    // A plain navigation, so the browser handles the file dialog and the whole
    // range never has to sit in a JS string first.
    location.href = `${path}?${q}`;
    exportMsg(`Downloading ${q.get('from')} to ${q.get('to')}.`);
  };
  $('exportForm').addEventListener('submit', e => { e.preventDefault(); download('/api/export.json'); });
  $('exportCsvBtn').addEventListener('click', () => download('/api/export.csv'));

  $('importForm').addEventListener('submit', async e => {
    e.preventDefault();
    const file = $('importForm').file.files[0];
    if (!file) return importMsg('Choose a sync file first.', true);
    importMsg(`Reading ${file.name}…`);
    let bundle;
    try { bundle = JSON.parse(await file.text()); }
    catch { return importMsg(`${file.name} is not valid JSON.`, true); }

    const res = await fetch('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundle, createMissingFields: $('importForm').createMissingFields.checked }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) return importMsg(r.error || `Import failed (${res.status})`, true);

    const bits = [
      `${r.obs} new observation${r.obs === 1 ? '' : 's'}`,
      r.obsUpdated ? `${r.obsUpdated} revised` : null,
      r.readings ? `${r.readings} new station reading${r.readings === 1 ? '' : 's'}` : null,
      r.readingsUpdated ? `${r.readingsUpdated} station reading${r.readingsUpdated === 1 ? '' : 's'} revised` : null,
      r.gauges ? `${r.gauges} manual gauge${r.gauges === 1 ? '' : 's'}` : null,
      r.addedFields?.length ? `${r.addedFields.length} field${r.addedFields.length === 1 ? '' : 's'} created` : null,
      r.skipped ? `${r.skipped} already current or invalid` : null,
    ].filter(Boolean);
    const warn = r.unknownFields?.length
      ? ` Skipped data for ${r.unknownFields.length} field(s) this instance does not have (${r.unknownFields.join(', ')}) — tick the box above to create them.`
      : '';
    const disc = r.unmapped?.length
      ? ` ${r.unmapped.length} field(s) had no gauges mapped yet (${r.unmapped.join(', ')}) — mapping them now.`
      : '';
    importMsg(`Merged: ${bits.join(', ')}.${warn}${disc}`, !!(warn || disc));

    META = await fetch('/api/fields').then(r => r.json());
    renderFarmFilter();
    refreshFieldSelect();
    await renderGauges();
    await load();
  });
}

/* ---------- full backup & restore ---------- */
const restoreMsg = (t, bad) => note('restoreMsg', t, bad);

/** Which version this copy is, so two machines can be compared before trying. */
function renderBackup() {
  const cur = updateInfo?.repo?.current;
  $('backupStatus').innerHTML = cur
    ? `<span class="none">This copy is version ${esc(cur.sha)} (${esc(cur.date)}). A backup restores only onto a copy `
      + 'on the same version — the file writes straight into the database tables, and only a matching version '
      + 'guarantees they still mean the same thing.</span>'
    : '<span class="none">This copy was not installed with git, so its version cannot be read. Restoring will need '
      + 'the override box below ticked.</span>';
}

function wireBackup() {
  $('restoreForm').addEventListener('submit', async e => {
    e.preventDefault();
    const file = $('restoreForm').file.files[0];
    if (!file) return restoreMsg('Choose a backup file first.', true);
    if (!confirm(`Replace EVERYTHING on this machine with ${file.name}?\n\n`
      + 'Every field, setting and rainfall record here is overwritten. A copy of what is here now is saved to '
      + 'data/backups first, so this can be undone.')) return;

    restoreMsg(`Reading ${file.name}…`);
    // The file's own text goes up as the body: a full database does not need
    // parsing and re-serialising on this side just to attach a flag.
    let body;
    try { body = await file.text(); } catch { return restoreMsg(`Could not read ${file.name}.`, true); }

    restoreMsg('Restoring…');
    const force = $('restoreForm').force.checked;
    const res = await fetch(`/api/restore${force ? '?force=1' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }).catch(() => null);
    if (!res) return restoreMsg('The dashboard did not answer. Nothing was changed.', true);
    const r = await res.json().catch(() => ({}));
    if (!res.ok) return restoreMsg(r.error || `Restore failed (${res.status})`, true);

    const n = r.counts ?? {};
    const done = `Restored ${n.field ?? 0} field(s), ${n.obs ?? 0} observations and `
      + `${n.station_obs ?? 0} station readings, plus config.json. What was here is saved in ${r.safetyCopy}.`;
    if (r.serverMoved) {
      return restoreMsg(`${done} The restored settings move the dashboard to `
        + `http://${r.serverMoved.host}:${r.serverMoved.port} — open that address in a moment.`, true);
    }
    restoreMsg(`${done} Restarting…`);
    if (await waitForRestart()) location.reload();
    else restoreMsg(`${done} The dashboard has not come back yet — give it a moment and refresh this page.`, true);
  });
}

/* ---------- the station on your own ground ---------- */
const stationMsg = (t, bad) => note('stationMsg', t, bad);

/**
 * `fill` refills the form from the saved station, which only the paths that
 * changed it should do. The status line refreshes far more often than that —
 * every time a field moves — and rewriting the boxes underneath somebody
 * halfway through typing a URL would be its own small disaster.
 */
function renderStation({ fill = false } = {}) {
  const s = META.station ?? null;
  const f = $('stationForm').elements;
  $('stationSave').textContent = s ? 'Save changes' : 'Add station';
  $('stationRemove').hidden = !s;

  if (fill) for (const [k, v] of Object.entries({
    name: s?.name, lat: s?.lat, lon: s?.lon, elev_ft: s?.elev_ft,
    // A config written before the switch to miles still carries km, and the
    // box says miles — so show what the range actually is, not the number.
    maxDistanceMi: s?.maxDistanceMi ?? (s?.maxDistanceKm ? +(s.maxDistanceKm * MI_PER_KM).toFixed(1) : ''),
    dailyUrl: s?.dailyUrl, yearlyUrl: s?.yearlyUrl,
  })) f[k].value = v ?? '';

  // Which fields it reaches comes from the links the server computed, so this
  // panel cannot disagree with what the charts are actually using.
  const covers = META.fields
    .filter(x => (x.stations ?? []).some(st => st.network === 'ONFARM' && !st.excluded))
    .map(x => x.name);
  $('stationStatus').innerHTML = !s
    ? '<span class="none">No station set up. If you have one, this becomes the closest thing to ground truth you '
      + 'have — and the gauge the radar gets calibrated against.</span>'
    : `<span>${esc(s.name)} <span class="none">(${esc(s.stationId)})</span> at ${Number(s.lat).toFixed(4)}, `
      + `${Number(s.lon).toFixed(4)} — ${covers.length ? `counts for ${esc(covers.join(', '))}`
        : `<span class="warn">no field within ${s.maxDistanceMi ?? 20} miles</span>`}.</span>`;
}

function wireStation() {
  $('stationTest').addEventListener('click', async () => {
    const f = $('stationForm').elements;
    const dailyUrl = f.dailyUrl.value.trim(), yearlyUrl = f.yearlyUrl.value.trim();
    if (!dailyUrl && !yearlyUrl) return stationMsg('Fill in the daily report address first.', true);
    stationMsg('Fetching the reports…');
    const r = await fetch('/api/config/station/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyUrl, yearlyUrl }),
    }).then(res => res.json()).catch(() => null);
    if (!r) return stationMsg('Could not reach the dashboard.', true);

    const bits = [];
    let bad = false;
    if (r.daily) {
      bad = bad || !r.daily.ok;
      bits.push(r.daily.ok
        ? `Daily report: ${r.daily.days} day${r.daily.days === 1 ? '' : 's'} for ${r.daily.period}, `
          + `${(r.daily.total ?? 0).toFixed(2)}" so far.`
        : `Daily report failed — ${r.daily.error}.`);
    }
    if (r.yearly) {
      bad = bad || !r.yearly.ok;
      bits.push(r.yearly.ok
        ? `Yearly report: ${r.yearly.months} month${r.yearly.months === 1 ? '' : 's'} `
          + `(${r.yearly.firstMonth} to ${r.yearly.lastMonth}), ${(r.yearly.total ?? 0).toFixed(2)}" total.`
        : `Yearly report failed — ${r.yearly.error}.`);
    }

    // The header carries the station's own position, in degrees/minutes/
    // seconds. Filling only the empty boxes: this is an offer, not a correction
    // of something already typed.
    const h = r.daily?.station;
    const filled = [];
    if (h) for (const [k, v] of [['name', h.name], ['lat', h.lat], ['lon', h.lon], ['elev_ft', h.elev_ft]]) {
      if (v === null || v === undefined || v === '' || f[k].value) continue;
      f[k].value = v;
      filled.push(k === 'elev_ft' ? 'elevation' : k);
    }
    if (filled.length) bits.push(`Filled in ${filled.join(', ')} from the report header.`);
    stationMsg(bits.join(' '), bad);
  });

  $('stationForm').addEventListener('submit', async e => {
    e.preventDefault();
    stationMsg('Saving…');
    const res = await fetch('/api/config/station', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return stationMsg(body.error || `Failed (${res.status})`, true);
    META = await fetch('/api/fields').then(r => r.json());
    renderStation({ fill: true });
    if (body.job) { jobWasRunning = true; clearTimeout(jobTimer); pollJobs(); }
    await load();
    stationMsg(`Saved ${body.station.name}.`
      + (body.job ? ` ${body.job} now — see Data collection above.` : '')
      + (body.keptReadings ? ` ${body.keptReadings} reading(s) already stored for it.` : ''));
  });

  $('stationRemove').addEventListener('click', async () => {
    if (!confirm('Remove the weather station? Its readings are kept, so adding the same station back restores them '
      + '— which matters here, because its monthly report is overwritten and this is the only copy.')) return;
    stationMsg('Removing…');
    const res = await fetch('/api/config/station', { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return stationMsg(body.error || `Failed (${res.status})`, true);
    META = await fetch('/api/fields').then(r => r.json());
    renderStation({ fill: true });
    await load();
    stationMsg(`Removed. ${body.keptReadings} reading(s) kept in the database.`);
  });

  renderStation({ fill: true });
}

/* ---------- manual gauges ---------- */
const gaugeMsg = (t, bad) => note('gaugeMsg', t, bad);

async function refreshGauges() {
  META = await fetch('/api/fields').then(r => r.json());
  await renderGauges();
  await load();
}

async function saveGauge(payload, method = 'POST') {
  gaugeMsg('Saving…');
  const res = await fetch('/api/config/gauges', {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { gaugeMsg(body.error || `Failed (${res.status})`, true); return null; }
  await refreshGauges();
  return body;
}

async function renderGauges() {
  const gauges = META.gauges ?? [];
  const t = $('gaugeTable');
  t.querySelector('thead').innerHTML =
    '<tr><th>Gauge</th><th>Latitude</th><th>Longitude</th><th>Range</th><th>Fields it covers</th><th>Readings</th><th></th></tr>';

  const counts = {};
  for (const r of (await fetch('/api/readings?days=5000').then(r => r.json())).readings)
    counts[r.station_id] = (counts[r.station_id] ?? 0) + 1;
  // Which fields a gauge reaches comes from the links the server already
  // computed, so the panel cannot disagree with what the charts actually use.
  const covers = g => META.fields
    .filter(f => (f.stations ?? []).some(s => s.network === 'MANUAL' && s.station_id === g.id && !s.excluded))
    .map(f => f.name);

  t.querySelector('tbody').innerHTML = gauges.length ? gauges.map(g => {
    const on = covers(g);
    return `<tr>
      <td>${esc(g.name)}</td><td>${g.lat.toFixed(6)}</td><td>${g.lon.toFixed(6)}</td>
      <td class="${g.maxDistanceMi ? '' : 'none'}">${g.maxDistanceMi ? `${g.maxDistanceMi} mi` : 'default'}</td>
      <td class="none">${on.length ? esc(on.join(', ')) : 'no field within range'}</td>
      <td>${counts[g.id] ?? 0}</td>
      <td><button class="linkbtn danger" data-delgauge="${esc(g.id)}" data-name="${esc(g.name)}">Remove</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="none">None yet — add the gauge you read by hand below.</td></tr>';

  t.querySelectorAll('[data-delgauge]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Remove "${b.dataset.name}"? Its readings are kept, so adding it back restores them.`)) return;
    const r = await saveGauge({ id: b.dataset.delgauge }, 'DELETE');
    if (r) gaugeMsg(`Removed ${b.dataset.name}. ${r.keptReadings} reading(s) kept in the database.`);
  }));

  const sel = $('readingGauge');
  const keep = sel.value;
  sel.innerHTML = gauges.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  if (gauges.some(g => g.id === keep)) sel.value = keep;
  $('addReading').hidden = !gauges.length;

  await renderReadings();
}

async function renderReadings() {
  const gauge = $('readingGauge').value;
  const t = $('readingTable');
  if (!gauge) { t.querySelector('thead').innerHTML = ''; t.querySelector('tbody').innerHTML = ''; return; }
  const { readings } = await fetch(`/api/readings?gauge=${encodeURIComponent(gauge)}&days=400`).then(r => r.json());
  t.querySelector('thead').innerHTML = '<tr><th>Date</th><th>Inches</th><th>Entered</th><th></th></tr>';
  t.querySelector('tbody').innerHTML = readings.length ? readings.map(r =>
    `<tr><td>${r.date}</td><td>${r.precip_in.toFixed(2)}</td><td class="none">${r.updated_at} UTC</td>
     <td><button class="linkbtn danger" data-delread="${r.date}">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="none">No readings yet for this gauge.</td></tr>';

  t.querySelectorAll('[data-delread]').forEach(b => b.addEventListener('click', async () => {
    // Blank, not zero: deleting has to mean "no reading", never "it stayed dry".
    await postReading({ gauge, date: b.dataset.delread, precip_in: '' });
    gaugeMsg(`Deleted the ${b.dataset.delread} reading.`);
  }));
}

async function postReading(payload) {
  const res = await fetch('/api/readings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { gaugeMsg(body.error || `Failed (${res.status})`, true); return false; }
  await refreshGauges();
  return true;
}

/* ---------- per-field exclusions ---------- */
const note = (id, t, bad) => {
  const n = $(id);
  n.textContent = t || '';
  n.style.color = bad ? 'var(--warning)' : 'var(--text-muted)';
};
const msg = (t, bad) => note('fieldMsg', t, bad);
const exMsg = (t, bad) => note('exMsg', t, bad);

const stationKey = s => `${s.network}|${s.station_id}`;

async function saveExclusions(fieldId, patch) {
  exMsg('Saving…');
  const res = await fetch('/api/config/exclusions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: fieldId, ...patch }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { exMsg(body.error || `Failed (${res.status})`, true); return null; }
  META = await fetch('/api/fields').then(r => r.json());
  await load();
  return body;
}

function renderExclusions(field) {
  if (!field) return;
  const exSrc = new Set(field.exclude?.sources ?? []);
  const rows = field.stations ?? [];
  // The ticks come from the links, not from config.exclude.stations. A field
  // nobody has touched counts its nearest couple and lists the rest unticked
  // without that being written down anywhere, so reading config here would
  // draw every box ticked and disagree with the numbers on the charts. The
  // first change writes the whole state out, and config leads from then on.
  const exSta = new Set(rows.filter(s => s.excluded).map(stationKey));
  $('exField').textContent = field.name;

  // The fixed source list, not the field's drawn series: "Rain gauges" here
  // means all of them at once, and the individual ones have their own boxes in
  // the table below. Two controls for the same gauge would be one too many.
  $('sourceToggles').innerHTML = SOURCE_TOGGLES.map(s => {
    const on = !exSrc.has(s.key);
    return `<label class="${on ? '' : 'off'}"><input type="checkbox" data-src="${s.key}"${on ? ' checked' : ''}>
      ${s.color ? `<span class="swatch" style="background:${s.color}"></span>` : ''}${s.label}</label>`;
  }).join('');
  $('sourceToggles').querySelectorAll('[data-src]').forEach(box => box.addEventListener('change', () => {
    const next = new Set(exSrc);
    if (box.checked) next.delete(box.dataset.src); else next.add(box.dataset.src);
    saveExclusions(field.id, { sources: [...next] })
      .then(r => { if (r) exMsg(`${box.checked ? 'Counting' : 'Ignoring'} ${box.dataset.src} for ${field.name}.`); });
  }));

  const st = $('stationTable');
  st.querySelector('thead').innerHTML =
    '<tr><th>Counts</th><th>Station</th><th>Network</th><th>Distance</th></tr>';
  st.querySelector('tbody').innerHTML = rows.length ? rows.map(s => {
    const on = !exSta.has(stationKey(s));
    return `<tr><td><span class="tick"><input type="checkbox" data-sta="${esc(stationKey(s))}"${on ? ' checked' : ''}
        aria-label="Count ${esc(s.name ?? s.station_id)} for this field"></span></td>
      <td${on ? '' : ' class="none"'}>${esc(s.name ?? s.station_id)} <span class="none">(${esc(s.station_id)})</span></td>
      <td class="none">${esc(s.network)}</td><td${on ? '' : ' class="none"'}>${mi(s.dist_km)}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="none">No gauge within range — widen maxDistanceMi in config.json.</td></tr>';

  st.querySelectorAll('[data-sta]').forEach(box => box.addEventListener('change', () => {
    const next = new Set(exSta);
    if (box.checked) next.delete(box.dataset.sta); else next.add(box.dataset.sta);
    saveExclusions(field.id, { stations: [...next] }).then(r => {
      if (r) exMsg(`${box.checked ? 'Counting' : 'Ignoring'} ${box.dataset.sta.split('|')[1]} for ${field.name}.`);
    });
  }));
}

/* ---------- field management ---------- */

async function saveField(payload, method = 'POST', note = 'Saving…') {
  msg(note);
  const res = await fetch('/api/config/fields', {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { msg(body.error || `Failed (${res.status})`, true); return false; }
  if (body.job) { jobWasRunning = true; clearTimeout(jobTimer); pollJobs(); }
  META = await fetch('/api/fields').then(r => r.json());
  renderFarmFilter();
  // A new field becomes the selection; an edit leaves the selection alone, so
  // fixing the acreage on one field does not yank the charts to it.
  refreshFieldSelect(method === 'POST' && !payload.id
    ? META.fields.find(f => f.name === String(payload.name).trim())?.id
    : undefined);
  await load();
  return true;
}

function renderFields() {
  const t = $('fieldTable');
  t.querySelector('thead').innerHTML =
    '<tr><th>Field</th><th>Farm</th><th>Latitude</th><th>Longitude</th><th>Acres</th><th>Nearest gauge</th><th></th></tr>';
  const cell = (f, k, extra = '') =>
    `<input class="cell ${extra}" data-edit="${k}" data-id="${f.id}" value="${esc(f[k] ?? '')}"`
    + (k === 'farm' ? ' list="farmList" placeholder="—"' : '') + '>';
  t.querySelector('tbody').innerHTML = META.fields.map(f => {
    const near = f.stations?.[0];
    return `<tr>
      <td>${esc(f.name)}</td>
      <td>${cell(f, 'farm')}</td>
      <td>${f.lat.toFixed(6)}</td>
      <td>${f.lon.toFixed(6)}</td>
      <td>${cell(f, 'acres', 'num')}</td>
      <td class="none">${near ? `${esc(near.name ?? near.station_id)} · ${mi(near.dist_km)}` : 'none in range'}</td>
      <td><button class="linkbtn danger" data-del="${f.id}" data-name="${esc(f.name)}">Remove</button></td>
    </tr>`;
  }).join('');
  $('farmList').innerHTML = (META.farms ?? []).map(f => `<option value="${esc(f)}">`).join('');

  // Save on commit (blur or Enter), not per keystroke — every save rewrites
  // config.json, and a half-typed farm name should never reach it.
  t.querySelectorAll('[data-edit]').forEach(inp => {
    const original = inp.value;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', async () => {
      const v = inp.value.trim();
      if (v === original.trim()) return;
      inp.classList.add('saving');
      const label = META.fields.find(f => f.id === inp.dataset.id)?.name ?? inp.dataset.id;
      const ok = await saveField({ id: inp.dataset.id, [inp.dataset.edit]: v }, 'POST',
        `Saving ${inp.dataset.edit} for ${label}…`);
      if (ok) msg(`Saved ${inp.dataset.edit} for ${label}.`);
      else inp.value = original;   // leave the rejected text out of the table
      inp.classList.remove('saving');
    });
  });

  t.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (META.fields.length <= 1) return msg('Keep at least one field.', true);
    if (!confirm(`Remove "${b.dataset.name}"? Its stored observations are deleted too.`)) return;
    if (await saveField({ id: b.dataset.del }, 'DELETE', 'Removing…')) msg(`Removed ${b.dataset.name}.`);
  }));
}

/**
 * Everything that can change something: forms, job buttons, import, restore.
 *
 * Grouped so the published copy can skip it in one place. It is not defensive —
 * every $() in here would throw on the static build, because the markup it
 * reaches for has been cut out of the page rather than hidden. That is the
 * intent: a read-only mirror should not carry a disabled copy of the controls
 * for a machine the reader cannot reach.
 */
async function wireAdmin() {
  $('addField').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!fd.acres) delete fd.acres;
    if (!fd.farm) delete fd.farm;
    if (await saveField(fd, 'POST', 'Saving…')) {
      e.target.reset();
      msg(`Added ${fd.name}. Mapping its gauges and pulling its history now — see Data collection below.`);
    }
  });
  $('addGauge').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!fd.maxDistanceMi) delete fd.maxDistanceMi;
    if (await saveGauge(fd)) {
      e.target.reset();
      gaugeMsg(`Added ${fd.name}. It now covers any field within range — enter its readings below.`);
    }
  });

  $('addReading').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (await postReading(fd)) {
      const kept = fd.date;
      e.target.reset();
      // Keep the date, clear the amount: readings are usually caught up a run of
      // days at a time, and retyping the date every line is the tedious part.
      e.target.date.value = kept;
      gaugeMsg(`Saved ${Number(fd.precip_in).toFixed(2)}" for ${kept}.`);
    }
  });
  $('readingGauge').addEventListener('change', renderReadings);
  for (const f of ['addField', 'addGauge', 'stationForm']) wireCoordPaste($(f));
  wireExport();
  wireBackup();
  wireStation();
  wireJobs();
  wireUpdates();
  $('addReading').date.value = todayIso();
  $('addReading').date.max = $('addReading').date.value;
  await renderGauges();
}

(async function init() {
  META = await apiGet('/api/fields');
  if (!STATIC) await wireAdmin();

  renderFarmFilter();
  refreshFieldSelect();
  $('fieldSel').addEventListener('change', load);
  $('yearSel').addEventListener('change', load);
  $('rangeSel').addEventListener('change', load);
  $('cmpSel').addEventListener('change', load);
  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('rm-theme', next);
    load();
  });
  // Click-away closes any open checkbox popover, which <details> does not do.
  document.addEventListener('click', e => {
    document.querySelectorAll('details.multi[open]').forEach(d => {
      if (!d.contains(e.target)) d.open = false;
    });
  });
  const saved = localStorage.getItem('rm-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  await load();
})();
