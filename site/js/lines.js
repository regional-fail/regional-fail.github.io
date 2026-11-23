// Report cards: two awards, then one card per line with inbound and outbound side by side.
import { getJson, LIVE_BASE, DATA_BASE, fmtPct, fmtTime, setText, el, DIRS, DIR_ORDER, GRADES, gradeBadge } from './common.js';
import { emptyAgg, mergeAgg, score, rates, SCORE } from '../lib/summary.mjs';

const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30 };
const PERIOD_LABEL = { today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days' };
const PERIOD_SHORT = { today: 'today', '7d': '7 days', '30d': '30 days' };
let latest, index, period = 'today', sort = 'worst';

/** Per line (with each direction) totals for the period: today's live numbers plus archived days. */
function collect() {
  const days = [{ date: latest.current, lines: Object.fromEntries(latest.summary.lines.map(l => [`${l.route}|${l.dir}`, l])) }];
  if (PERIOD_DAYS[period] > 1) {
    const archived = (index?.days || []).filter(d => d.date < latest.current && Object.values(d.lines || {}).some(l => l.all));
    days.push(...archived.slice(-(PERIOD_DAYS[period] - 1)));
  }
  const lines = {};
  for (const d of days) {
    for (const l of Object.values(d.lines || {})) {
      if (!l.all) continue;
      const line = lines[l.route] ||= { route: l.route, name: l.name, all: emptyAgg(), dirs: {} };
      line.all = mergeAgg(line.all, l.all);
      line.dirs[l.dir] = mergeAgg(line.dirs[l.dir] || emptyAgg(), l.all);
    }
  }
  return { days: days.map(d => d.date), lines: Object.values(lines) };
}

const observed = agg => agg.ran + agg.ghosts;
const minToRank = () => SCORE.minObservedToRank[period];
const ranked = l => l.s && observed(l.all) >= minToRank();

function sentence(agg) {
  const r = rates(agg);
  return `Ran ${fmtPct(r.delivered_rate)} of its trains (${agg.ghosts} ghost${agg.ghosts === 1 ? '' : 's'}), ` +
    `${fmtPct(r.on_time_rate)} on time, ${r.avg_late == null ? '–' : r.avg_late.toFixed(1)} min late on average.`;
}

function renderAwards(list) {
  const set = (prefix, l) => {
    const card = document.getElementById(`${prefix}-card`);
    if (!l) {
      setText(`${prefix}-name`, 'Not enough data yet');
      document.getElementById(`${prefix}-grade`).replaceChildren();
      setText(`${prefix}-detail`, `A line needs ${minToRank()} observed trips ${PERIOD_LABEL[period]} to compete. Check back later.`);
      card.removeAttribute('href');
      return;
    }
    setText(`${prefix}-name`, l.name);
    document.getElementById(`${prefix}-grade`).replaceChildren(gradeBadge(l.s.grade, 'lg'));
    setText(`${prefix}-detail`, `${GRADES[l.s.grade].quip} ${sentence(l.all)}`);
    card.href = `index.html#line=${l.route}`;
  };
  const r = list.filter(ranked).sort((a, b) => a.s.score - b.s.score);
  set('worst', r[0]);
  set('best', r.length > 1 ? r.at(-1) : null);
}

function dirHalf(line, dir) {
  const agg = line.dirs[dir] || emptyAgg(), r = rates(agg), D = DIRS[dir];
  const s = observed(agg) >= Math.ceil(minToRank() / 2) ? score(agg) : null;   // no grade on a tiny sample
  return el('a', { class: `half ${D.key}`, href: `index.html#line=${line.route}&dir=${D.key}`, title: `See ${line.name} ${D.label.toLowerCase()} trains on the map` },
    el('div', { class: 'half-head' }, el('span', { class: 'half-title' }, `${D.icon} ${D.label}`), gradeBadge(s?.grade, 'sm')),
    el('div', { class: 'half-sub' }, D.long),
    el('div', { class: 'half-big' }, fmtPct(r.on_time_rate), el('small', {}, ' on time')),
    el('div', { class: 'half-row' }, el('span', {}, agg.ghosts ? `👻 ${agg.ghosts} ghost${agg.ghosts === 1 ? '' : 's'}` : '👻 0 ghosts'), el('span', {}, r.avg_late == null ? '' : `${r.avg_late.toFixed(1)} min late avg`)));
}

function card(line, rank) {
  const isRanked = ranked(line);
  const head = el('header', { class: 'lc-head' },
    el('div', {},
      isRanked ? el('span', { class: 'lc-rank' }, rank) : el('span', { class: 'lc-rank muted' }, `${observed(line.all)} of ${minToRank()} trips to rank`),
      el('h2', {}, line.name),
      el('p', { class: 'lc-quip' }, isRanked ? GRADES[line.s.grade].quip : 'Too early to judge. We’re watching.')),
    gradeBadge(isRanked ? line.s.grade : null, 'lg'));
  const bar = isRanked ? el('div', { class: 'lc-score', 'aria-label': `Score ${line.s.score.toFixed(0)} out of 100` }, el('span', { style: `width:${Math.max(2, line.s.score)}%` })) : null;
  return el('article', { class: `line-card${isRanked ? '' : ' unranked'}`, id: `line-${line.route}` },
    head, ...(bar ? [bar] : []),
    el('div', { class: 'halves' }, ...DIR_ORDER.map(d => dirHalf(line, d))),
    el('a', { class: 'lc-link', href: `index.html#line=${line.route}` }, 'See it on the map →'));
}

function render() {
  const { days, lines } = collect();
  for (const l of lines) l.s = score(l.all);
  renderAwards(lines);
  const r = lines.filter(ranked).sort((a, b) => a.s.score - b.s.score);
  const rankOf = l => {
    const i = r.indexOf(l);
    return i === 0 ? '😬 Worst' : i === r.length - 1 ? '😌 Best' : `#${i + 1} worst of ${r.length}`;
  };
  const ordered = sort === 'az' ? [...lines].sort((a, b) => a.name.localeCompare(b.name))
    : [...r.sort((a, b) => (sort === 'worst' ? a.s.score - b.s.score : b.s.score - a.s.score)), ...lines.filter(l => !ranked(l)).sort((a, b) => a.name.localeCompare(b.name))];
  document.getElementById('cards').replaceChildren(...ordered.map(l => card(l, rankOf(l))));
  const n = days.length, since = [...days].sort()[0];
  setText('period-note', `${n} day${n === 1 ? '' : 's'} of data${PERIOD_DAYS[period] > n ? ` (counting since ${since})` : ''} · updated ${fmtTime(latest.updated_at)} ET`);
  setText('min-rank', Object.entries(SCORE.minObservedToRank).map(([k, v]) => `${v} for ${PERIOD_SHORT[k]}`).join(', '));
  const target = new URLSearchParams(location.hash.slice(1)).get('line');
  const hit = target && document.getElementById(`line-${target}`);
  if (hit && !render.scrolled) { hit.classList.add('focus'); hit.scrollIntoView({ block: 'center' }); render.scrolled = true; }
}

function wireSegs(selector, attr, set) {
  for (const btn of document.querySelectorAll(selector)) {
    btn.addEventListener('click', () => {
      set(btn.dataset[attr]);
      for (const b of document.querySelectorAll(selector)) b.setAttribute('aria-pressed', String(b === btn));
      render();
    });
  }
}
wireSegs('.seg[data-period]', 'period', v => { period = v; });
wireSegs('.seg[data-sort]', 'sort', v => { sort = v; });

async function refresh() {
  latest = await getJson(`${LIVE_BASE}/latest.json`);
  index = await getJson(`${DATA_BASE}/archive/index.json`).catch(() => ({ days: [] }));
  render();
}
refresh().catch(e => { setText('worst-name', 'No data yet'); console.error(e); });
setInterval(() => refresh().catch(console.error), 60_000);
