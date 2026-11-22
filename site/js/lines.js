// Line scorecards: awards, a ranked score chart, and the per-direction table.
import { getJson, LIVE_BASE, DATA_BASE, fmtPct, fmtTime, setText, el } from './common.js';
import { emptyAgg, mergeAgg, score, rates, SCORE } from '../lib/summary.mjs';

const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30 };
const PERIOD_LABEL = { today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days' };
const PERIOD_SHORT = { today: 'today', '7d': '7 days', '30d': '30 days' };
let latest, index, period = 'today';

/** Per line+direction totals for the period: today's live numbers plus archived days. */
function collect() {
  const days = [{ date: latest.current, lines: Object.fromEntries(latest.summary.lines.map(l => [`${l.route}|${l.dir}`, l])) }];
  const archived = (index?.days || []).filter(d => d.date < latest.current).slice(-(PERIOD_DAYS[period] - 1) || Infinity);
  if (PERIOD_DAYS[period] > 1) days.push(...archived.filter(d => Object.values(d.lines || {}).some(l => l.all)));
  const dirs = {};
  for (const d of days) {
    for (const [key, l] of Object.entries(d.lines || {})) {
      if (!l.all) continue;
      const cur = dirs[key] ||= { route: l.route, name: l.name, dir: l.dir, all: emptyAgg(), rush: emptyAgg() };
      cur.all = mergeAgg(cur.all, l.all);
      if (l.rush) cur.rush = mergeAgg(cur.rush, l.rush);
    }
  }
  const lines = {};
  for (const d of Object.values(dirs)) {
    const cur = lines[d.route] ||= { route: d.route, name: d.name, all: emptyAgg() };
    cur.all = mergeAgg(cur.all, d.all);
  }
  return { days: days.map(d => d.date), dirs: Object.values(dirs), lines: Object.values(lines) };
}

const observed = agg => agg.ran + agg.ghosts;
const minToRank = () => SCORE.minObservedToRank[period];

function describe(l) {
  const r = rates(l.all);
  return `Ran ${fmtPct(r.delivered_rate)} of its trains (${l.all.ghosts} ghost${l.all.ghosts === 1 ? '' : 's'}), ` +
    `${fmtPct(r.on_time_rate)} on time, ${r.avg_late == null ? '–' : r.avg_late.toFixed(1)} min late on average ` +
    `across ${observed(l.all)} observed trips.`;
}

function renderAwards(ranked) {
  const set = (prefix, l) => {
    if (!l) {
      setText(`${prefix}-name`, 'Not enough data yet');
      setText(`${prefix}-grade`, '');
      setText(`${prefix}-detail`, `A line needs at least ${minToRank()} observed trips ${PERIOD_LABEL[period]} to be ranked. Check back later.`);
      return;
    }
    setText(`${prefix}-name`, l.name);
    setText(`${prefix}-grade`, `${l.s.grade} · ${l.s.score.toFixed(0)}/100`);
    setText(`${prefix}-detail`, describe(l));
  };
  set('worst', ranked[0]);
  set('best', ranked.length > 1 ? ranked.at(-1) : null);
}

const barTip = document.getElementById('bar-tip');
function showBarTip(e, l) {
  const r = rates(l.all);
  barTip.replaceChildren(
    el('div', { class: 'tt-head' }, `${l.name}: ${l.s.score.toFixed(1)} (${l.s.grade})`),
    el('div', { class: 'tt-row' }, el('span', { class: 'tt-big' }, fmtPct(r.delivered_rate)), ' of trains ran'),
    el('div', { class: 'tt-row' }, el('span', { class: 'tt-big' }, fmtPct(r.on_time_rate)), ' of finished trips on time'),
    el('div', { class: 'tt-row' }, el('span', { class: 'tt-big' }, r.avg_late == null ? '–' : `${r.avg_late.toFixed(1)} min`), ' late on average'),
    el('div', { class: 'tt-row' }, el('span', { class: 'tt-big' }, String(l.all.ghosts)), ` ghost trains · ${l.all.unknown} unknown`),
    el('div', { class: 'tt-row' }, `${observed(l.all)} observed trips (rush hour counts double in the score)`),
  );
  barTip.hidden = false;
  const box = barTip.parentElement.getBoundingClientRect();
  barTip.style.left = `${Math.min(e.clientX - box.left + 14, box.width - barTip.offsetWidth - 8)}px`;
  barTip.style.top = `${e.clientY - box.top + 14}px`;
}

function renderBars(ranked, unranked) {
  const bars = document.getElementById('bars');
  bars.replaceChildren(...ranked.map(l => {
    const row = el('div', { class: 'bar-row', role: 'listitem', tabindex: '0', 'aria-label': `${l.name}: score ${l.s.score.toFixed(0)}, grade ${l.s.grade}. ${describe(l)}` },
      el('span', { class: 'bar-name' }, l.name),
      el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width:${Math.max(1, l.s.score)}%` })),
      el('span', { class: 'bar-value' }, `${l.s.score.toFixed(0)} · ${l.s.grade}`));
    row.addEventListener('pointermove', e => showBarTip(e, l));
    row.addEventListener('pointerleave', () => { barTip.hidden = true; });
    row.addEventListener('focus', () => { const b = row.getBoundingClientRect(); showBarTip({ clientX: b.left + 120, clientY: b.bottom }, l); });
    row.addEventListener('blur', () => { barTip.hidden = true; });
    return row;
  }));
  if (!ranked.length) bars.replaceChildren(el('p', { class: 'card-note' }, `No line has ${minToRank()} observed trips ${PERIOD_LABEL[period]} yet.`));
  const un = document.getElementById('unranked');
  un.replaceChildren(...(unranked.length ? [
    el('h3', {}, 'Not enough data to rank yet'),
    el('p', { class: 'card-note' }, unranked.map(l => `${l.name} (${observed(l.all)} of ${minToRank()})`).join(' · ')),
  ] : []));
}

function renderTable(dirs) {
  const tbody = document.querySelector('#dir-table tbody');
  tbody.replaceChildren(...dirs.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir)).map(d => {
    const r = rates(d.all), rr = rates(d.rush), s = score(d.all);
    return el('tr', {},
      el('td', {}, d.name), el('td', {}, d.dir),
      el('td', {}, d.all.due), el('td', {}, d.all.ran), el('td', {}, d.all.ghosts), el('td', {}, d.all.unknown),
      el('td', {}, `${fmtPct(r.on_time_rate)}${d.all.finished ? ` (${d.all.finished})` : ''}`),
      el('td', {}, r.avg_late == null ? '–' : `${r.avg_late.toFixed(1)} min`),
      el('td', {}, d.all.late_max ? `${d.all.late_max} min` : '–'),
      el('td', {}, d.rush.finished ? `${fmtPct(rr.on_time_rate)} (${d.rush.finished})` : '–'),
      el('td', {}, s ? `${s.grade} · ${s.score.toFixed(0)}` : '–'));
  }));
}

function render() {
  const { days, dirs, lines } = collect();
  const scored = lines.map(l => ({ ...l, s: score(l.all) }));
  const ranked = scored.filter(l => l.s && observed(l.all) >= minToRank()).sort((a, b) => a.s.score - b.s.score);
  const unranked = scored.filter(l => !ranked.includes(l)).sort((a, b) => a.name.localeCompare(b.name));
  renderAwards(ranked);
  renderBars(ranked, unranked);
  renderTable(dirs);
  const n = days.length;
  const since = [...days].sort()[0];
  setText('period-note', `${n} day${n === 1 ? '' : 's'} of data${PERIOD_DAYS[period] > n ? ` (we've only been counting since ${since})` : ''} · updated ${fmtTime(latest.updated_at)} ET`);
  setText('min-rank', Object.entries(SCORE.minObservedToRank).map(([k, v]) => `${v} for ${PERIOD_SHORT[k]}`).join(', '));
}

for (const btn of document.querySelectorAll('.seg')) {
  btn.addEventListener('click', () => {
    period = btn.dataset.period;
    for (const b of document.querySelectorAll('.seg')) b.setAttribute('aria-pressed', String(b === btn));
    render();
  });
}

async function refresh() {
  latest = await getJson(`${LIVE_BASE}/latest.json`);
  index = await getJson(`${DATA_BASE}/archive/index.json`).catch(() => ({ days: [] }));
  render();
}
refresh().catch(e => { setText('worst-name', 'No data yet'); console.error(e); });
setInterval(() => refresh().catch(console.error), 60_000);
