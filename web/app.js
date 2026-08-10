const ALL_SERIES = [
  { key: 'gauge',  label: 'Rain gauge',   color: 'var(--series-gauge)',  note: 'nearest reporting station' },
  { key: 'manual', label: 'Manual gauge', color: 'var(--series-manual)', note: 'read by hand' },
  { key: 'rfcqpe', label: 'RFC QPE 4km',  color: 'var(--series-rfcqpe)', note: 'NWS multi-sensor, finest grid here' },
  { key: 'mrms',   label: 'Radar QPE',    color: 'var(--series-mrms)',   note: 'MRMS via IEM, ~12km' },
  { key: 'prism',  label: 'PRISM',        color: 'var(--series-prism)',  note: '4km climate analysis' },
];
// What is actually drawn. Narrowed to the sources in play, so a farm with no
// hand-read gauge does not get a fifth legend entry, a fifth bar slot and a
// permanent "no data yet" for a source it does not have.
let SERIES = ALL_SERIES;
const SVG = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, kids = []) => {
  const e = document.createElementNS(SVG, n);
  for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  for (const c of [].concat(kids)) e.append(c);
  return e;
};
const fmt = v => (v === null || v === undefined ? '—' : v.toFixed(2));
const has = v => v !== null && v !== undefined;
const mdy = d => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}`; };

/** Bar with rounded data-end, square against the baseline. */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0.5) return `M${x} ${y + h} h${w}`;
  const rr = Math.min(r, w / 2, h);
  return `M${x} ${y + h} L${x} ${y + rr} Q${x} ${y} ${x + rr} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h} Z`;
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

function legendInto(node, items, notes = {}) {
  node.innerHTML = items.map(s =>
    `<span class="item"><span class="swatch" style="background:${s.color}"></span>${s.label}`
    + (notes[s.key] ? ` <span class="none">${notes[s.key]}</span>` : '') + '</span>').join('');
}

/* ---------- Chart 1: daily rainfall, grouped bars ---------- */
function drawDaily(svg, rows, binLabel) {
  const W = 1100, H = 300, m = { t: 14, r: 16, b: 34, l: 44 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.replaceChildren();
  if (!rows.length) return;

  const max = Math.max(0.1, ...rows.flatMap(r => SERIES.map(s => r[s.key] ?? 0)));
  const { top, ticks } = niceTicks(max);
  const y = v => m.t + ph - (v / top) * ph;
  const gw = pw / rows.length;
  const bw = Math.max(1.5, (gw - 6) / SERIES.length - 2);   // 2px surface gap between adjacent bars

  for (const t of ticks) {
    svg.append(el('line', { class: 'grid-line', x1: m.l, x2: m.l + pw, y1: y(t), y2: y(t) }));
    svg.append(el('text', { class: 'tick', x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, [t.toFixed(2)]));
  }
  svg.append(el('line', { class: 'axis-line', x1: m.l, x2: m.l + pw, y1: y(0), y2: y(0) }));

  const every = Math.max(1, Math.ceil(rows.length / 14));
  rows.forEach((r, i) => {
    const gx = m.l + i * gw;
    const band = el('rect', { class: 'band', x: gx, y: m.t, width: gw, height: ph, fill: 'transparent' });
    svg.append(band);

    SERIES.forEach((s, si) => {
      const v = r[s.key];
      if (!has(v)) return;
      const bx = gx + 3 + si * (bw + 2);
      svg.append(el('path', { d: barPath(bx, y(v), bw, y(0) - y(v)), fill: s.color }));
    });

    band.addEventListener('mousemove', e => {
      band.classList.add('on');
      showTip(e, r.date, SERIES.map(s => ({
        k: `<span class="dot" style="background:${s.color}"></span>${s.label}`,
        v: has(r[s.key]) ? `${fmt(r[s.key])}"` : 'no report',
      })), [r.gauge_src && `Gauge: ${r.gauge_src}`, r.manual_src && `Manual: ${r.manual_src}`]
        .filter(Boolean).join('<br>') || null);
    });
    band.addEventListener('mouseleave', () => { band.classList.remove('on'); hideTip(); });

    if (i % every === 0) svg.append(el('text', {
      class: 'tick', x: gx + gw / 2, y: H - 12, 'text-anchor': 'middle',
    }, [binLabel(r.date)]));
  });
}

/* ---------- Chart 2: cumulative lines ---------- */
function drawCumulative(svg, rows) {
  // Right margin holds the direct end-labels, which are mandatory at 4 series.
  const W = 1100, H = 280, m = { t: 14, r: 124, b: 34, l: 44 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.replaceChildren();
  if (!rows.length) return;

  // Accumulate only from each series' first real observation. Starting every
  // line at index 0 would draw a source with no history — RFC QPE publishes no
  // archive — as a flat zero across the whole range, which reads as "measured
  // nothing" rather than "wasn't collecting yet".
  const cum = {}, from = {};
  for (const s of SERIES) {
    const start = rows.findIndex(r => has(r[s.key]));
    if (start < 0) continue;
    from[s.key] = start;
    let a = 0;
    cum[s.key] = rows.slice(start).map(r => (a += r[s.key] ?? 0));
  }
  const drawn = SERIES.filter(s => cum[s.key]);
  if (!drawn.length) return;
  const max = Math.max(0.1, ...drawn.map(s => cum[s.key].at(-1)));
  const { top, ticks } = niceTicks(max);
  const x = i => m.l + (rows.length === 1 ? pw / 2 : (i / (rows.length - 1)) * pw);
  const y = v => m.t + ph - (v / top) * ph;

  for (const t of ticks) {
    svg.append(el('line', { class: 'grid-line', x1: m.l, x2: m.l + pw, y1: y(t), y2: y(t) }));
    svg.append(el('text', { class: 'tick', x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, [t.toFixed(2)]));
  }
  svg.append(el('line', { class: 'axis-line', x1: m.l, x2: m.l + pw, y1: y(0), y2: y(0) }));

  for (const s of drawn) {
    const off = from[s.key];
    svg.append(el('path', {
      d: cum[s.key].map((v, i) => `${i ? 'L' : 'M'}${x(i + off).toFixed(1)} ${y(v).toFixed(1)}`).join(' '),
      fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    // Direct label at the line end — identity without relying on the legend alone.
    const last = cum[s.key].at(-1);
    svg.append(el('circle', { cx: x(rows.length - 1), cy: y(last), r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    svg.append(el('text', { class: 'dlabel', x: x(rows.length - 1) + 10, y: y(last) + 4 },
      [`${s.label} ${last.toFixed(2)}"`]));
  }

  const every = Math.max(1, Math.ceil(rows.length / 10));
  rows.forEach((r, i) => { if (i % every === 0)
    svg.append(el('text', { class: 'tick', x: x(i), y: H - 12, 'text-anchor': 'middle' }, [mdy(r.date)])); });

  const cross = el('line', { class: 'axis-line', y1: m.t, y2: m.t + ph, opacity: 0 });
  svg.append(cross);
  const hit = el('rect', { class: 'hit', x: m.l, y: m.t, width: pw, height: ph });
  svg.append(hit);
  hit.addEventListener('mousemove', e => {
    const bb = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(rows.length - 1,
      Math.round(((e.clientX - bb.left) / bb.width * W - m.l) / pw * (rows.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
    showTip(e, `Through ${rows[i].date}`, drawn.map(s => {
      const j = i - from[s.key];
      return {
        k: `<span class="dot" style="background:${s.color}"></span>${s.label}`,
        v: j < 0 ? 'not collecting yet' : `${cum[s.key][j].toFixed(2)}"`,
      };
    }));
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); hideTip(); });
}

/* ---------- Chart 3: field comparison, horizontal bars ---------- */
function drawFields(svg, summaries, fields, activeId) {
  const rowH = 30, m = { t: 8, r: 130, b: 26, l: 132 };
  const W = 1100, H = m.t + m.b + summaries.length * rowH;
  const pw = W - m.l - m.r;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.replaceChildren();

  const name = id => fields.find(f => f.id === id)?.name ?? id;
  const best = s => s.season.mrms ?? s.season.gauge ?? s.season.prism ?? 0;
  const max = Math.max(0.1, ...summaries.map(best));
  const { top, ticks } = niceTicks(max);
  const x = v => m.l + (v / top) * pw;

  for (const t of ticks) {
    svg.append(el('line', { class: 'grid-line', x1: x(t), x2: x(t), y1: m.t, y2: m.t + summaries.length * rowH }));
    svg.append(el('text', { class: 'tick', x: x(t), y: H - 10, 'text-anchor': 'middle' }, [t.toFixed(1)]));
  }

  summaries.forEach((s, i) => {
    const yc = m.t + i * rowH, v = best(s), bh = 15;
    const active = s.field_id === activeId;
    svg.append(el('text', {
      class: 'dlabel', x: m.l - 10, y: yc + rowH / 2 + 4, 'text-anchor': 'end',
      fill: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    }, [name(s.field_id)]));

    const g = el('g');
    // Horizontal bar: the rounded data-end sits on the right, square at the baseline.
    g.append(el('path', {
      d: hbarPath(m.l, yc + (rowH - bh) / 2, Math.max(0.5, x(v) - m.l), bh),
      fill: 'var(--series-gauge)', opacity: active ? 1 : 0.55,
    }));
    g.append(el('text', { class: 'dlabel', x: x(v) + 10, y: yc + rowH / 2 + 4 }, [`${v.toFixed(2)}"`]));
    const hit = el('rect', { class: 'hit', x: m.l, y: yc, width: pw, height: rowH });
    hit.addEventListener('mousemove', e => showTip(e, name(s.field_id), [
      { k: 'Season to date', v: `${v.toFixed(2)}"` },
      { k: 'Last 7 days', v: `${fmt(s.d7.mrms ?? s.d7.gauge)}"` },
      { k: 'Days since rain', v: s.days_since_rain ?? '—' },
    ]));
    hit.addEventListener('mouseleave', hideTip);
    g.append(hit); svg.append(g);
  });
}
function hbarPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, h / 2, w);
  return `M${x} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h - rr} Q${x + w} ${y + h} ${x + w - rr} ${y + h} L${x} ${y + h} Z`;
}

/* ---------- weekly binning for long ranges ---------- */
function binWeekly(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 7) {
    const chunk = rows.slice(i, i + 7), o = { date: chunk[0].date, end: chunk.at(-1).date };
    for (const s of SERIES) {
      const vals = chunk.map(r => r[s.key]).filter(has);
      o[s.key] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
    }
    out.push(o);
  }
  return out;
}

/* ---------- app ---------- */
let META = null;
const $ = id => document.getElementById(id);

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

async function load() {
  const fieldId = $('fieldSel').value;
  const days = Number($('rangeSel').value);
  // Scoped to the field on screen, not to the config: a manual gauge eight
  // miles away is a source this field simply does not have, and listing it as
  // "no data yet" reads as a gauge that has stopped reporting.
  const hasManual = f => (f?.stations ?? []).some(s => s.network === 'MANUAL' && !s.excluded);
  SERIES = ALL_SERIES.filter(s => s.key !== 'manual' || hasManual(META.fields.find(f => f.id === fieldId)));
  const [{ rows }, { summaries }, cal] = await Promise.all([
    fetch(`/api/series?field=${fieldId}&days=${days}`).then(r => r.json()),
    fetch('/api/summary').then(r => r.json()),
    fetch('/api/calibration').then(r => r.json()),
  ]);
  const me = summaries.find(s => s.field_id === fieldId) ?? {};
  const field = META.fields.find(f => f.id === fieldId);

  // KPI tiles. Radar is the field-specific number; gauge is shown beside it so
  // the reader always sees whether the two agree.
  const pick = w => me[w] ?? {};
  // Headline prefers the finest grid that actually has a value. RFC QPE only
  // exists from the day it was switched on, so older windows fall back to MRMS
  // and the tile says which one it is rather than quietly mixing them.
  const tile = (label, w, extra) => {
    const d = pick(w), g = d.gauge;
    const fine = has(d.rfcqpe) && d.rfcqpe > 0;
    const r = fine ? d.rfcqpe : d.mrms;
    const src = fine ? 'RFC QPE 4km' : 'Radar QPE ~12km';
    const col = fine ? 'var(--series-rfcqpe)' : 'var(--series-mrms)';
    // The hand-read line only appears once a manual gauge covers this field —
    // a permanent "manual no report" would read as a gauge that is failing.
    const manual = SERIES.some(s => s.key === 'manual') && has(d.manual)
      ? `<div class="meta"><span class="swatch" style="background:var(--series-manual)"></span>manual ${d.manual.toFixed(2)}"</div>` : '';
    return `<div class="tile"><div class="label">${label}</div>
      <div class="value">${has(r) ? r.toFixed(2) : '—'}<span class="unit">in</span></div>
      <div class="meta"><span class="swatch" style="background:${col}"></span>${src}</div>
      <div class="meta"><span class="swatch" style="background:var(--series-gauge)"></span>gauge ${has(g) ? g.toFixed(2) + '"' : 'no report'}</div>
      ${manual}${extra ? `<div class="meta">${extra}</div>` : ''}</div>`;
  };
  const dry = me.days_since_rain;
  $('kpis').innerHTML =
    tile('Last 24 hours', 'd1') +
    tile('Last 7 days', 'd7') +
    tile('Last 30 days', 'd30') +
    tile('Season to date', 'season', `since ${META.seasonStart}`) +
    `<div class="tile"><div class="label">Days since rain</div>
       <div class="value">${dry === null || dry === undefined ? '—' : dry}</div>
       <div class="meta">last measurable ≥ 0.01"</div></div>`;

  const weekly = days > 120;
  const chartRows = weekly ? binWeekly(rows) : rows;
  const rfcFrom = rows.find(r => has(r.rfcqpe))?.date;
  $('dailyNote').textContent = (weekly
    ? 'Weekly totals. A blank slot means no source reported for that week. '
    : 'One bar per source per day. A missing bar means that source reported nothing — not that it stayed dry. ')
    + 'PRISM and RFC QPE both run on a 12Z–12Z day, so a single storm can land on either side of midnight local; compare those over a week, not a day. '
    + (rfcFrom
        ? `RFC QPE is the finest grid here (~4 km) but publishes no archive, so it only exists from ${rfcFrom} forward.`
        : 'RFC QPE (~4 km) starts collecting on the next ingest — it publishes no archive, so it cannot be backfilled.');
  // Flag series that only start partway through the range, so a short line
  // never reads as a source that measured nothing.
  const starts = {};
  for (const s of SERIES) {
    const i = rows.findIndex(r => has(r[s.key]));
    if (i > 0) starts[s.key] = `from ${mdy(rows[i].date)}`;
    else if (i < 0) starts[s.key] = 'no data yet';
  }
  legendInto($('legendDaily'), SERIES, starts);
  legendInto($('legendCum'), SERIES, starts);
  drawDaily($('chartDaily'), chartRows, weekly ? (d => mdy(d)) : mdy);
  drawCumulative($('chartCum'), rows);
  const shown = visibleFields();
  const scope = farmSel.size ? ` ${shown.length} of ${META.fields.length} fields shown for the selected farm${farmSel.size > 1 ? 's' : ''}.` : '';
  $('fieldsNote').textContent = `Radar QPE totals since ${META.seasonStart}. Selected field highlighted.${scope}`;
  drawFields($('chartFields'), summaries.filter(s => shown.some(f => f.id === s.field_id)), META.fields, fieldId);

  // Calibration: how the gridded products compare to the gauge on Home 8.
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
  $('dataTable').querySelector('thead').innerHTML =
    `<tr><th>Date</th>${SERIES.map(s => `<th><span class="dot" style="background:${s.color}"></span>${s.label}</th>`).join('')}<th>Gauge station</th></tr>`;
  $('dataTable').querySelector('tbody').innerHTML = [...rows].reverse().map(r =>
    `<tr><td>${r.date}</td>${SERIES.map(s =>
      has(r[s.key]) ? `<td>${r[s.key].toFixed(2)}</td>` : '<td class="none">—</td>').join('')}
     <td class="none">${r.gauge_src ?? '—'}</td></tr>`).join('');

  renderExclusions(field);
  renderFields();

  $('csvBtn').href = `/api/export.csv?field=${fieldId}&days=${Math.max(days, 400)}`;
  $('subtitle').textContent = [
    field.farm ? `${field.farm} · ${field.name}` : field.name,
    `${field.lat.toFixed(4)}, ${field.lon.toFixed(4)}`,
    field.acres ? `${field.acres} ac` : null,
  ].filter(Boolean).join(' · ');
  $('footer').textContent = `Sources: MRMS radar QPE and PRISM via IEM reanalysis; gauges via NWS COOP/ASOS and Kansas Mesonet. Last ingest ${META.lastIngest ?? 'never'} UTC.`;
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
      <td class="${g.maxDistanceKm ? '' : 'none'}">${g.maxDistanceKm ? `${g.maxDistanceKm} km` : 'default'}</td>
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
  if (!res.ok) { exMsg(body.error || `Failed (${res.status})`, true); return false; }
  META = await fetch('/api/fields').then(r => r.json());
  await load();
  return true;
}

function renderExclusions(field) {
  if (!field) return;
  const exSrc = new Set(field.exclude?.sources ?? []);
  const exSta = new Set(field.exclude?.stations ?? []);
  $('exField').textContent = field.name;

  $('sourceToggles').innerHTML = SERIES.map(s => {
    const on = !exSrc.has(s.key);
    return `<label class="${on ? '' : 'off'}"><input type="checkbox" data-src="${s.key}"${on ? ' checked' : ''}>
      <span class="swatch" style="background:${s.color}"></span>${s.label}</label>`;
  }).join('');
  $('sourceToggles').querySelectorAll('[data-src]').forEach(box => box.addEventListener('change', () => {
    const next = new Set(exSrc);
    if (box.checked) next.delete(box.dataset.src); else next.add(box.dataset.src);
    saveExclusions(field.id, { sources: [...next] })
      .then(ok => { if (ok) exMsg(`${box.checked ? 'Counting' : 'Ignoring'} ${box.dataset.src} for ${field.name}.`); });
  }));

  const st = $('stationTable');
  st.querySelector('thead').innerHTML =
    '<tr><th>Counts</th><th>Station</th><th>Network</th><th>Distance</th></tr>';
  const rows = field.stations ?? [];
  st.querySelector('tbody').innerHTML = rows.length ? rows.map(s => {
    const on = !exSta.has(stationKey(s));
    return `<tr><td><span class="tick"><input type="checkbox" data-sta="${esc(stationKey(s))}"${on ? ' checked' : ''}
        aria-label="Count ${esc(s.name ?? s.station_id)} for this field"></span></td>
      <td${on ? '' : ' class="none"'}>${esc(s.name ?? s.station_id)} <span class="none">(${esc(s.station_id)})</span></td>
      <td class="none">${esc(s.network)}</td><td${on ? '' : ' class="none"'}>${s.dist_km.toFixed(1)} km</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="none">No gauge within range — widen maxDistanceKm in config.json.</td></tr>';

  st.querySelectorAll('[data-sta]').forEach(box => box.addEventListener('change', () => {
    const next = new Set(exSta);
    if (box.checked) next.delete(box.dataset.sta); else next.add(box.dataset.sta);
    saveExclusions(field.id, { stations: [...next] }).then(ok => {
      if (ok) exMsg(`${box.checked ? 'Counting' : 'Ignoring'} ${box.dataset.sta.split('|')[1]} for ${field.name}.`
        + (box.checked ? '' : ' Run "npm run discover" to pull in the next gauge in range.'));
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
      <td class="none">${near ? `${esc(near.name ?? near.station_id)} · ${near.dist_km.toFixed(1)} km` : 'none in range'}</td>
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

(async function init() {
  META = await fetch('/api/fields').then(r => r.json());

  $('addField').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!fd.acres) delete fd.acres;
    if (!fd.farm) delete fd.farm;
    if (await saveField(fd, 'POST', 'Saving and remapping gauges…')) {
      e.target.reset();
      msg(`Added ${fd.name}. Run "npm run backfill" to pull its history.`);
    }
  });
  $('addGauge').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!fd.maxDistanceKm) delete fd.maxDistanceKm;
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
  const now = new Date();
  $('addReading').date.value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  $('addReading').date.max = $('addReading').date.value;
  await renderGauges();

  renderFarmFilter();
  refreshFieldSelect();
  $('fieldSel').addEventListener('change', load);
  $('rangeSel').addEventListener('change', load);
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
