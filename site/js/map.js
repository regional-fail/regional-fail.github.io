// Live whole-day map: every train today, where it is (or was), how late, and the ghosts that never came.
// Pick a line (chips) and a direction (toggle) to focus; the URL hash keeps the choice (#line=PAO&dir=in).
import {
  loadLive, getJson, fmtTime, fmtPct, band, GHOST_COLOR, statusText, lineNames, stopName,
  setText, el, renderRules, DIRS, DIR_ORDER, dirFromKey, GRADES, gradeBadge,
} from './common.js';
import { emptyAgg, mergeAgg, rates, score as rawScore, SCORE } from '../lib/summary.mjs';

// Grades only appear once there are enough observed trips today (half the bar for one direction).
const MIN_LINE = SCORE.minObservedToRank.today, MIN_DIR = Math.ceil(MIN_LINE / 2);
const score = (agg, min = MIN_LINE) => (agg.ran + agg.ghosts >= min ? rawScore(agg) : null);

const REFRESH_MS = 60_000;
const LEVEL_COLOR = { Light: 'var(--good)', Moderate: 'var(--warning)', Heavy: 'var(--serious)', Gridlock: 'var(--critical)' };
const LEVEL_QUIP = {
  Light: 'Suspiciously smooth.',
  Moderate: 'Pretty standard, unfortunately.',
  Heavy: 'Maybe the billboard had a point about driving.',
  Gridlock: 'Traffic? LOL.',
};

let network, latest, day, trains = [];
let liveMode = true, playTimer = null;
const ghostMarkers = new Map();
const sel = { line: null, dir: null };   // dir: 'Inbound' | 'Outbound' | null

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: [-75.2, 40.03],
  zoom: 9.4,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

// ---------- selection ----------

const legMatches = leg => (!sel.line || leg.route === sel.line) && (!sel.dir || leg.dir === sel.dir);
const trainMatches = rec => (rec.legs?.length ? rec.legs.some(legMatches) : !sel.line && !sel.dir);
const lineName = id => network.lines.find(l => l.id === id)?.name || id;

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  sel.line = network.lines.some(l => l.id === p.get('line')) ? p.get('line') : null;
  sel.dir = dirFromKey(p.get('dir'));
}
function writeHash() {
  const p = new URLSearchParams();
  if (sel.line) p.set('line', sel.line);
  if (sel.dir) p.set('dir', DIRS[sel.dir].key);
  history.replaceState(null, '', p.toString() ? `#${p}` : location.pathname);
}
function select({ line = sel.line, dir = sel.dir, fly = true } = {}) {
  const lineChanged = line !== sel.line;
  Object.assign(sel, { line, dir });
  writeHash();
  applySelection(fly && lineChanged);
}

function applySelection(fly) {
  for (const b of document.querySelectorAll('#line-chips .chip')) b.setAttribute('aria-pressed', String((b.dataset.line || null) === sel.line));
  for (const b of document.querySelectorAll('.dir-toggle .seg')) b.setAttribute('aria-pressed', String(dirFromKey(b.dataset.dir) === sel.dir));
  if (map.getLayer('network-focus')) map.setFilter('network-focus', sel.line ? ['==', ['get', 'id'], sel.line] : ['==', ['get', 'id'], '__none__']);
  if (map.getLayer('network')) map.setPaintProperty('network', 'line-opacity', sel.line ? 0.35 : 1);
  if (fly) fitTo(sel.line);
  if (latest) { renderTiles(); renderSide(); render(currentT()); }
}

function fitTo(lineId) {
  const bounds = new maplibregl.LngLatBounds();
  for (const l of network.lines) if (!lineId || l.id === lineId) for (const p of l.paths) for (const c of p) bounds.extend(c);
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: { top: 60, bottom: 70, left: 30, right: 30 }, duration: 600, maxZoom: 12 });
}

// ---------- geometry over time ----------

function positionAt(rec, T) {
  const tr = rec.trail;
  if (!tr?.length || T < tr[0][0]) return null;
  const last = tr.at(-1);
  if (T >= last[0]) {
    const stillListed = T <= (rec.last_seen ?? last[0]) + (rec.status === 'running' ? 15 * 60 : 0);
    return stillListed ? { lon: last[2], lat: last[1], late: last[3] } : null;
  }
  let i = 0;
  while (i < tr.length - 1 && tr[i + 1][0] <= T) i++;
  const a = tr[i], b = tr[i + 1];
  const f = (T - a[0]) / (b[0] - a[0] || 1);
  return { lon: a[2] + (b[2] - a[2]) * f, lat: a[1] + (b[1] - a[1]) * f, late: a[3] };
}

function trailUpTo(rec, T) {
  const coords = [];
  for (const p of rec.trail || []) { if (p[0] > T) break; coords.push([p[2], p[1]]); }
  const pos = positionAt(rec, T);
  if (pos && coords.length) coords.push([pos.lon, pos.lat]);
  return coords;
}

const finalLate = rec => (rec.trail?.length ? rec.trail.at(-1)[3] : rec.late_max ?? 0);

/** Ghosts: whole trains that never ran, plus legs a through train skipped (filtered by selection). */
function ghostsAt(T) {
  const out = [];
  for (const rec of trains) {
    if (rec.status === 'ghost' && rec.dep <= T && trainMatches(rec)) out.push({ rec, stop: rec.legs[0]?.from, kind: rec.ghost, dep: rec.dep });
    for (const leg of rec.legs || []) {
      if (leg.ghost === 'skipped' && leg.dep <= T && legMatches(leg)) out.push({ rec, stop: leg.from, kind: 'skipped', leg, dep: leg.dep });
    }
  }
  return out.sort((a, b) => a.dep - b.dep);
}

// ---------- map rendering ----------

function render(T) {
  const points = [], lines = [];
  for (const rec of trains) {
    if (!trainMatches(rec)) continue;
    const pos = positionAt(rec, T);
    if (pos) {
      const b = band(pos.late);
      points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] }, properties: {
        train: rec.train, label: rec.train, color: b.color, radius: b.radius, late: pos.late > 5 ? `+${pos.late}` : '' } });
    }
    const coords = trailUpTo(rec, T);
    if (coords.length >= 2) {
      const finished = !pos;
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { train: rec.train, color: band(finished ? finalLate(rec) : pos.late).color, finished } });
    }
  }
  map.getSource('trains')?.setData({ type: 'FeatureCollection', features: points });
  map.getSource('trails')?.setData({ type: 'FeatureCollection', features: lines });
  renderGhosts(ghostsAt(T));
  setText('time-label', liveMode ? `Live · ${fmtTime(T)}` : fmtTime(T));
}

function renderGhosts(ghosts) {
  const byStop = new Map();
  for (const g of ghosts) {
    if (!network.stops[g.stop]) continue;
    if (!byStop.has(g.stop)) byStop.set(g.stop, []);
    byStop.get(g.stop).push(g);
  }
  for (const [stop, m] of ghostMarkers) if (!byStop.has(stop)) { m.marker.remove(); ghostMarkers.delete(stop); }
  for (const [stop, list] of byStop) {
    let entry = ghostMarkers.get(stop);
    if (!entry) {
      const inner = el('span', { class: 'ghost-inner' }, '👻');
      const node = el('div', { class: 'ghost-marker', role: 'img' }, inner);
      const [, lat, lon] = network.stops[stop];
      const marker = new maplibregl.Marker({ element: node }).setLngLat([lon, lat]).addTo(map);
      node.addEventListener('mouseenter', e => showGhostTooltip(e, stop, ghostMarkers.get(stop).list));
      node.addEventListener('mousemove', moveTooltip);
      node.addEventListener('mouseleave', hideTooltip);
      entry = { marker, node, inner };
      ghostMarkers.set(stop, entry);
    }
    entry.list = list;
    entry.inner.querySelector('.count')?.remove();
    if (list.length > 1) entry.inner.append(el('span', { class: 'count' }, list.length));
    entry.node.setAttribute('aria-label', `${list.length} ghost train${list.length > 1 ? 's' : ''} at ${stopName(network, stop)}`);
  }
}

// ---------- tooltip ----------

const tip = document.getElementById('tooltip');
function moveTooltip(e) {
  const box = document.querySelector('.map-wrap').getBoundingClientRect();
  const x = (e.clientX ?? e.originalEvent.clientX) - box.left, y = (e.clientY ?? e.originalEvent.clientY) - box.top;
  tip.style.left = `${Math.max(8, Math.min(x + 14, box.width - tip.offsetWidth - 8))}px`;
  tip.style.top = `${Math.max(8, Math.min(y + 14, box.height - tip.offsetHeight - 8))}px`;
}
function hideTooltip() { tip.hidden = true; }

function trainTooltip(rec, T) {
  const pos = positionAt(rec, T);
  const late = pos ? pos.late : finalLate(rec);
  const b = rec.status === 'ghost' ? { color: GHOST_COLOR, label: 'Ghost' } : band(late);
  const first = rec.legs?.[0], last = rec.legs?.at(-1);
  const rows = [
    el('div', { class: 'tt-head' }, el('span', { class: 'tt-key', style: `--c:${b.color}` }), `Train #${rec.trainno || rec.train}`),
    el('div', { class: 'tt-row' }, el('span', { class: 'tt-big' }, pos ? `${Math.max(0, late)} min late` : statusText(rec)), pos ? ` · ${b.label}` : ''),
    el('div', { class: 'tt-row' }, lineNames(rec, network)),
  ];
  if (first) rows.push(el('div', { class: 'tt-row' }, `${stopName(network, first.from)} → ${stopName(network, last.to)}`));
  if (rec.dep) rows.push(el('div', { class: 'tt-row' }, `Scheduled ${fmtTime(rec.dep)} – ${fmtTime(rec.arr)}`));
  if (rec.late_max != null) rows.push(el('div', { class: 'tt-row' }, `Worst delay today: ${rec.late_max} min`));
  if (rec.next && pos) rows.push(el('div', { class: 'tt-row' }, `Next stop: ${rec.next}`));
  if (rec.cars?.length) rows.push(el('div', { class: 'tt-row' }, `${rec.cars.length} cars`));
  for (const a of rec.alert_canceled || []) rows.push(el('div', { class: 'tt-alert' }, `SEPTA: ${a}`));
  tip.replaceChildren(...rows);
}

function ghostWhat(g) {
  return g.kind === 'skipped' ? 'skipped this part of its run' : g.kind === 'confirmed' ? 'SEPTA confirmed canceled'
    : g.kind === 'pre-canceled' ? 'removed from timetable' : 'never showed up';
}

function showGhostTooltip(e, stop, list) {
  const rows = [el('div', { class: 'tt-head' }, `👻 ${list.length} ghost${list.length > 1 ? 's' : ''} at ${stopName(network, stop)}`)];
  for (const g of list) {
    rows.push(el('div', { class: 'tt-row' }, el('span', { class: 'tt-big' }, `#${g.rec.train}`), ` ${fmtTime(g.dep)} · ${lineNames(g.leg ? { legs: [g.leg] } : g.rec, network)} · ${ghostWhat(g)}`));
  }
  tip.replaceChildren(...rows);
  tip.hidden = false;
  moveTooltip(e);
}

function hookLayerTooltip(layer) {
  map.on('mousemove', layer, e => {
    const f = e.features?.[0];
    const rec = f && trains.find(t => t.train === f.properties.train);
    if (!rec) return;
    map.getCanvas().style.cursor = 'pointer';
    trainTooltip(rec, currentT());
    tip.hidden = false;
    moveTooltip(e);
  });
  map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; hideTooltip(); });
}

// ---------- numbers for the selection ----------

/** Today's totals per line+direction from the logger's summary. */
const summaryLines = () => latest.summary.lines;
function aggFor({ line = sel.line, dir = sel.dir } = {}) {
  let all = emptyAgg();
  for (const l of summaryLines()) if ((!line || l.route === line) && (!dir || l.dir === dir)) all = mergeAgg(all, l.all);
  return all;
}

function renderTiles() {
  const agg = aggFor(), r = rates(agg);
  const running = trains.filter(t => t.status === 'running' && trainMatches(t)).length;
  setText('t-running', running);
  setText('t-ghosts', agg.ghosts);
  setText('t-ontime', fmtPct(r.on_time_rate));
  setText('t-avglate', r.avg_late == null ? '–' : r.avg_late.toFixed(1));
  const n = agg.finished;
  setText('t-ontime-label', `on time today · ${n} trip${n === 1 ? '' : 's'} finished`);
  setText('t-avglate-label', `avg minutes late at the last stop`);
}

function renderChips() {
  const box = document.getElementById('line-chips');
  const chip = (id, label, grade) => {
    const b = el('button', { type: 'button', class: 'chip', 'data-line': id || '', 'aria-pressed': String((id || null) === sel.line) },
      el('span', { class: 'chip-name' }, label));
    if (id) b.append(gradeBadge(grade, 'sm'));
    b.addEventListener('click', () => select({ line: id || null }));
    return b;
  };
  const byLine = {};
  for (const l of summaryLines()) byLine[l.route] = mergeAgg(byLine[l.route] || emptyAgg(), l.all);
  const chips = [chip(null, '✨ All lines')];
  for (const l of [...network.lines].sort((a, b) => a.name.localeCompare(b.name))) chips.push(chip(l.id, l.name, score(byLine[l.id] || emptyAgg())?.grade));
  box.replaceChildren(...chips);
  box.querySelector('.chip[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function statBlock(dir) {
  const agg = aggFor({ dir }), r = rates(agg), s = score(agg, MIN_DIR);
  const D = DIRS[dir];
  const onThisSide = l => l.dir === dir && (!sel.line || l.route === sel.line);
  const ghosts = ghostsAt(Infinity).filter(g => (g.leg ? onThisSide(g.leg) : g.rec.legs.some(onThisSide)));
  const runningLate = trains.filter(t => t.status === 'running' && t.legs?.some(l => l.dir === dir && (!sel.line || l.route === sel.line)))
    .sort((a, b) => (b.late_now ?? 0) - (a.late_now ?? 0)).slice(0, 3);
  const block = el('section', { class: `dir-block ${D.key}` },
    el('header', { class: 'dir-head' },
      el('button', { type: 'button', class: 'dir-title', title: `Show only ${D.label.toLowerCase()} trains` }, el('span', { class: 'dir-icon' }, D.icon), el('span', {}, el('strong', {}, D.label), el('small', {}, D.long))),
      gradeBadge(s?.grade)),
    el('div', { class: 'dir-stats' },
      el('div', {}, el('b', {}, agg.ghosts ? `${agg.ghosts} 👻` : '0'), el('span', {}, 'ghosts')),
      el('div', {}, el('b', {}, fmtPct(r.on_time_rate)), el('span', {}, 'on time')),
      el('div', {}, el('b', {}, r.avg_late == null ? '–' : `${r.avg_late.toFixed(1)}m`), el('span', {}, 'avg late'))),
    el('p', { class: 'dir-sub' }, `${agg.ran} of ${agg.ran + agg.ghosts} observed trips ran${agg.unknown ? ` · ${agg.unknown} we weren’t watching` : ''}`));
  block.querySelector('.dir-title').addEventListener('click', () => select({ dir: sel.dir === dir ? null : dir }));
  if (ghosts.length) block.append(el('ul', { class: 'mini-list' }, ...ghosts.slice(0, 6).map(g => el('li', {}, '👻 ', el('strong', {}, `#${g.rec.train}`), ` ${fmtTime(g.dep)}`, el('span', { class: 'badge' }, g.kind === 'skipped' ? 'cut short' : g.kind)))));
  if (runningLate.length) block.append(el('ul', { class: 'mini-list' }, ...runningLate.map(t => el('li', {}, el('span', { class: 'mini-dot', style: `--c:${band(t.late_now).color}` }), el('strong', {}, `#${t.train}`), ` running ${Math.max(0, t.late_now ?? 0)} min late`))));
  return block;
}

function renderSide() {
  const side = document.getElementById('side');
  if (sel.line) {
    const s = score(aggFor({ dir: null }));
    const head = el('div', { class: 'side-head' },
      el('div', {}, el('h2', {}, lineName(sel.line)), el('p', { class: 'side-quip' }, s ? GRADES[s.grade].quip : 'Too early to grade today. We’re watching.')),
      gradeBadge(s?.grade, 'lg'));
    const dirs = DIR_ORDER.filter(d => !sel.dir || d === sel.dir);
    side.replaceChildren(head, ...dirs.map(statBlock),
      el('p', { class: 'side-note' }, 'Grades are today so far. ', el('a', { href: `lines.html#line=${sel.line}` }, 'See the report card →')));
    return;
  }
  // All lines: today's ghosts and the latest trains.
  const ghosts = ghostsAt(Infinity);
  const running = trains.filter(t => t.status === 'running' && trainMatches(t)).sort((a, b) => (b.late_now ?? 0) - (a.late_now ?? 0)).slice(0, 5);
  side.replaceChildren(
    el('h2', {}, sel.dir ? `${DIRS[sel.dir].icon} ${DIRS[sel.dir].label} ghost trains today` : 'Ghost trains today 👻'),
    el('p', { class: 'side-note' }, 'Scheduled, never showed up. Pick a line above to see its inbound and outbound side by side.'),
    el('ul', { class: 'mini-list' }, ...(ghosts.length ? ghosts.map(g => {
      const li = el('li', { class: 'clickable', tabindex: '0' }, '👻 ', el('strong', {}, `#${g.rec.train}`), ` ${fmtTime(g.dep)} · ${lineNames(g.leg ? { legs: [g.leg] } : g.rec, network)}`, el('span', { class: 'badge' }, g.kind === 'skipped' ? 'cut short' : g.kind));
      const route = (g.leg || g.rec.legs[0]).route;
      li.addEventListener('click', () => select({ line: route }));
      return li;
    }) : [el('li', { class: 'empty' }, 'None so far today. Give it time.')])),
    el('h2', {}, 'Latest right now'),
    el('ul', { class: 'mini-list' }, ...(running.length ? running.map(t => el('li', {}, el('span', { class: 'mini-dot', style: `--c:${band(t.late_now).color}` }), el('strong', {}, `${Math.max(0, t.late_now ?? 0)} min`), ` #${t.train} · ${lineNames(t, network)}`)) : [el('li', { class: 'empty' }, 'No trains running.')])),
    el('p', { class: 'asof' }, `Data as of ${fmtTime(latest.updated_at)} ET · checked every 5 minutes`),
  );
}

function renderBanner() {
  const s = latest.summary;
  const lvl = document.getElementById('traffic-level');
  lvl.textContent = s.traffic.level;
  lvl.style.setProperty('--lvl', LEVEL_COLOR[s.traffic.level]);
  setText('traffic-detail', `${LEVEL_QUIP[s.traffic.level]} Avg ${s.traffic.avg_late_now} min late across ${s.traffic.running} trains.`);
}

// ---------- time controls ----------

const slider = document.getElementById('time');
const liveBtn = document.getElementById('live');
const playBtn = document.getElementById('play');
const currentT = () => Number(slider.value);

function setLive(on) {
  liveMode = on;
  liveBtn.setAttribute('aria-pressed', String(on));
  if (on) { slider.value = slider.max; render(currentT()); }
}
slider.addEventListener('input', () => { stopPlay(); setLive(Number(slider.value) >= Number(slider.max)); render(currentT()); });
liveBtn.addEventListener('click', () => { stopPlay(); setLive(true); });
function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; playBtn.textContent = '▶'; } }
playBtn.addEventListener('click', () => {
  if (playTimer) return stopPlay();
  if (currentT() >= Number(slider.max)) slider.value = slider.min;
  setLive(false);
  playBtn.textContent = '❚❚';
  playTimer = setInterval(() => {
    const next = currentT() + 5 * 60;
    if (next >= Number(slider.max)) { stopPlay(); setLive(true); return; }
    slider.value = next;
    render(next);
  }, 150);
});
for (const b of document.querySelectorAll('.dir-toggle .seg')) b.addEventListener('click', () => select({ dir: dirFromKey(b.dataset.dir) }));

// ---------- data ----------

async function refresh() {
  ({ latest, day } = await loadLive());
  trains = [...Object.values(day.trains), ...Object.values(day.extras || {})];
  slider.min = String(day.polls?.[0]?.[0] ?? latest.updated_at);
  slider.max = String(latest.updated_at);
  if (liveMode) slider.value = slider.max;
  renderBanner();
  renderChips();
  renderTiles();
  renderSide();
  renderRules(latest.rules);
  render(currentT());
}

function addLayers() {
  map.addSource('network', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: network.lines.flatMap(l => l.paths.map(p => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: p }, properties: { id: l.id, line: l.name } }))) },
  });
  map.addSource('stations', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: Object.entries(network.stops).map(([id, [name, lat, lon]]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { id, name } })) },
  });
  map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  const width = ['interpolate', ['linear'], ['zoom'], 8, 1.5, 13, 4];
  map.addLayer({ id: 'network', type: 'line', source: 'network', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#5a5955', 'line-width': width } });
  map.addLayer({ id: 'network-focus', type: 'line', source: 'network', filter: ['==', ['get', 'id'], '__none__'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#c3c2b7', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 13, 7] } });
  map.addLayer({ id: 'stations', type: 'circle', source: 'stations', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 13, 4], 'circle-color': '#898781' } });
  map.addLayer({ id: 'station-labels', type: 'symbol', source: 'stations', minzoom: 12, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top' }, paint: { 'text-color': '#c3c2b7', 'text-halo-color': '#1a1a19', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'trails', type: 'line', source: 'trails', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': ['case', ['get', 'finished'], 0.3, 0.75] } });
  map.addLayer({ id: 'trail-hit', type: 'line', source: 'trails', paint: { 'line-color': '#000', 'line-width': 12, 'line-opacity': 0 } });
  map.addLayer({ id: 'train-hit', type: 'circle', source: 'trains', paint: { 'circle-radius': 14, 'circle-opacity': 0 } });
  map.addLayer({ id: 'trains', type: 'circle', source: 'trains', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['get', 'radius'], 13, ['*', ['get', 'radius'], 1.4]], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#1a1a19', 'circle-stroke-width': 2 } });
  // Minutes late, always shown for late trains (color is never the only cue).
  map.addLayer({ id: 'train-late', type: 'symbol', source: 'trains', layout: { 'text-field': ['get', 'late'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-allow-overlap': true }, paint: { 'text-color': '#f0efec', 'text-halo-color': '#1a1a19', 'text-halo-width': 2 } });
  map.addLayer({ id: 'train-labels', type: 'symbol', source: 'trains', minzoom: 11, layout: { 'text-field': ['concat', '#', ['get', 'label']], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -1.4], 'text-anchor': 'bottom' }, paint: { 'text-color': '#c3c2b7', 'text-halo-color': '#1a1a19', 'text-halo-width': 1.5 } });
  hookLayerTooltip('train-hit');
  hookLayerTooltip('trail-hit');
  map.getCanvas().addEventListener('mouseleave', hideTooltip);
  // Click a line on the map to pick it.
  map.on('click', 'network', e => { const id = e.features?.[0]?.properties.id; if (id) select({ line: id }); });
}

async function start() {
  network = await getJson('static/network.json');
  readHash();
  await new Promise(r => (map.loaded() ? r() : map.on('load', r)));
  addLayers();
  applySelection(true);
  try {
    await refresh();
  } catch (e) {
    setText('traffic-level', 'No data yet');
    setText('traffic-detail', 'The logger hasn’t produced data yet. Check back in a few minutes.');
    console.error(e);
  }
  window.addEventListener('hashchange', () => { readHash(); applySelection(true); });
  setInterval(() => refresh().catch(console.error), REFRESH_MS);
}
start();
