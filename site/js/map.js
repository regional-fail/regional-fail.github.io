// Live whole-day map: every train today, where it is (or was), how late, and the ghosts that never came.
import {
  loadLive, getJson, fmtTime, fmtPct, fmtMin, band, GHOST_COLOR, statusText, lineNames, stopName,
  setText, el, renderRules,
} from './common.js';

const REFRESH_MS = 60_000;
const LEVEL_COLOR = { Light: 'var(--good)', Moderate: 'var(--warning)', Heavy: 'var(--serious)', Gridlock: 'var(--critical)' };
const LEVEL_QUIP = {
  Light: 'Suspiciously smooth.',
  Moderate: 'Pretty standard, unfortunately.',
  Heavy: 'Maybe the billboard had a point about driving.',
  Gridlock: 'Traffic? lol.',
};

let network, latest, day, trains = [];
let liveMode = true, playTimer = null, ghostMarkers = new Map();

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: [-75.2, 40.03],
  zoom: 9.4,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

// ---------- geometry over time ----------

function positionAt(rec, T) {
  const tr = rec.trail;
  if (!tr?.length || T < tr[0][0]) return null;
  const last = tr.at(-1);
  if (T >= last[0]) {
    // After its last movement: still on the map while it is in the feed.
    const stillListed = T <= (rec.last_seen ?? last[0]) + (rec.status === 'running' ? 15 * 60 : 0);
    return stillListed ? { lon: last[2], lat: last[1], late: last[3], t: last[0] } : null;
  }
  let i = 0;
  while (i < tr.length - 1 && tr[i + 1][0] <= T) i++;
  const a = tr[i], b = tr[i + 1];
  const f = (T - a[0]) / (b[0] - a[0] || 1);
  return { lon: a[2] + (b[2] - a[2]) * f, lat: a[1] + (b[1] - a[1]) * f, late: a[3], t: T };
}

function trailUpTo(rec, T) {
  const coords = [];
  for (const p of rec.trail || []) { if (p[0] > T) break; coords.push([p[2], p[1]]); }
  const pos = positionAt(rec, T);
  if (pos && coords.length) coords.push([pos.lon, pos.lat]);
  return coords;
}

const finalLate = rec => rec.trail?.length ? rec.trail.at(-1)[3] : rec.late_max ?? 0;

/** Ghost markers: whole trains that never ran, plus legs a through train skipped. */
function ghostsAt(T) {
  const out = [];
  for (const rec of trains) {
    if (rec.status === 'ghost' && rec.dep <= T) out.push({ rec, stop: rec.legs[0]?.from, kind: rec.ghost });
    for (const leg of rec.legs || []) {
      if (leg.ghost === 'skipped' && leg.dep <= T) out.push({ rec, stop: leg.from, kind: 'skipped', leg });
    }
  }
  return out;
}

// ---------- rendering ----------

function render(T) {
  const points = [], lines = [];
  for (const rec of trains) {
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
    (byStop.get(g.stop) || byStop.set(g.stop, []).get(g.stop)).push(g);
  }
  for (const [stop, m] of ghostMarkers) if (!byStop.has(stop)) { m.marker.remove(); ghostMarkers.delete(stop); }
  for (const [stop, list] of byStop) {
    let entry = ghostMarkers.get(stop);
    if (!entry) {
      const inner = el('span', { class: 'ghost-inner' }, '👻');
      const node = el('div', { class: 'ghost-marker', role: 'img' }, inner);
      node.inner = inner;
      const [, lat, lon] = network.stops[stop];
      const marker = new maplibregl.Marker({ element: node }).setLngLat([lon, lat]).addTo(map);
      node.addEventListener('mouseenter', e => showGhostTooltip(e, stop, ghostMarkers.get(stop).list));
      node.addEventListener('mousemove', e => moveTooltip(e));
      node.addEventListener('mouseleave', hideTooltip);
      entry = { marker, node };
      ghostMarkers.set(stop, entry);
    }
    entry.list = list;
    entry.node.querySelector('.count')?.remove();
    if (list.length > 1) entry.node.inner.append(el('span', { class: 'count' }, list.length));
    entry.node.setAttribute('aria-label', `${list.length} ghost train${list.length > 1 ? 's' : ''} at ${stopName(network, stop)}`);
  }
}

// ---------- tooltip ----------

const tip = document.getElementById('tooltip');
function moveTooltip(e) {
  const box = document.querySelector('.map-wrap').getBoundingClientRect();
  const x = (e.clientX ?? e.originalEvent.clientX) - box.left, y = (e.clientY ?? e.originalEvent.clientY) - box.top;
  tip.style.left = `${Math.min(x + 14, box.width - tip.offsetWidth - 8)}px`;
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
  if (rec.first_seen) rows.push(el('div', { class: 'tt-row' }, `Seen ${fmtTime(rec.first_seen)} – ${fmtTime(rec.last_seen)}`));
  if (rec.late_max != null) rows.push(el('div', { class: 'tt-row' }, `Worst delay today: ${rec.late_max} min`));
  if (!pos && rec.trail?.length) rows.push(el('div', { class: 'tt-row' }, `Last report: ${finalLate(rec)} min late`));
  if (rec.next && pos) rows.push(el('div', { class: 'tt-row' }, `Next stop: ${rec.next}`));
  if (rec.cars?.length) rows.push(el('div', { class: 'tt-row' }, `${rec.cars.length} cars (${rec.cars.join(', ')})`));
  for (const a of rec.alert_canceled || []) rows.push(el('div', { class: 'tt-alert' }, `SEPTA: ${a}`));
  tip.replaceChildren(...rows);
}

function showGhostTooltip(e, stop, list) {
  const rows = [el('div', { class: 'tt-head' }, `👻 ${list.length} ghost${list.length > 1 ? 's' : ''} at ${stopName(network, stop)}`)];
  for (const g of list.sort((a, b) => (a.leg?.dep ?? a.rec.dep) - (b.leg?.dep ?? b.rec.dep))) {
    const when = fmtTime(g.leg?.dep ?? g.rec.dep);
    const what = g.kind === 'skipped' ? 'skipped this part of its run' : g.kind === 'confirmed' ? 'SEPTA confirmed canceled' : g.kind === 'pre-canceled' ? 'removed from timetable' : 'never showed up';
    rows.push(el('div', { class: 'tt-row' }, el('span', { class: 'tt-big' }, `#${g.rec.train}`), ` ${when} · ${g.leg ? lineNames({ legs: [g.leg] }, network) : lineNames(g.rec, network)} · ${what}`));
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

// ---------- side panels, tiles, table ----------

function renderPanels() {
  const s = latest.summary, sys = s.system;
  const lvl = document.getElementById('traffic-level');
  lvl.textContent = s.traffic.level;
  lvl.style.setProperty('--lvl', LEVEL_COLOR[s.traffic.level]);
  setText('traffic-detail', `${LEVEL_QUIP[s.traffic.level]} Avg ${s.traffic.avg_late_now} min late across ${s.traffic.running} trains.`);
  setText('t-running', s.traffic.running);
  setText('t-ghosts', sys.all.ghosts);
  setText('t-ontime', fmtPct(sys.rates.on_time_rate));
  setText('t-avglate', sys.rates.avg_late == null ? '–' : sys.rates.avg_late.toFixed(1));
  // Always show the sample size next to a rate, so a tiny sample can't masquerade as a trend.
  const n = sys.all.finished;
  setText('t-ontime-label', `on time today (SEPTA's own 5-min rule) · ${n} trip${n === 1 ? '' : 's'} finished`);
  setText('t-avglate-label', `avg minutes late at the last stop · ${n} trip${n === 1 ? '' : 's'}`);
  setText('t-worst', sys.all.late_max ? fmtMin(sys.all.late_max) : '–');

  const ghosts = ghostsAt(Infinity).sort((a, b) => (a.leg?.dep ?? a.rec.dep) - (b.leg?.dep ?? b.rec.dep));
  const gl = document.getElementById('ghost-list');
  gl.replaceChildren(...(ghosts.length ? ghosts.map(g => el('li', {},
    el('strong', {}, `#${g.rec.train}`),
    `${fmtTime(g.leg?.dep ?? g.rec.dep)} · ${g.leg ? lineNames({ legs: [g.leg] }, network) : lineNames(g.rec, network)}`,
    el('span', { class: 'badge' }, g.kind === 'skipped' ? 'cut short' : g.kind))) : [el('li', { class: 'empty' }, 'None so far today. Give it time.')]));

  const running = trains.filter(t => t.status === 'running').sort((a, b) => (b.late_now ?? 0) - (a.late_now ?? 0)).slice(0, 6);
  const ll = document.getElementById('late-list');
  ll.replaceChildren(...(running.length ? running.map(r => el('li', {},
    el('strong', {}, `${Math.max(0, r.late_now ?? 0)} min`),
    `#${r.train} · ${lineNames(r, network)}`)) : [el('li', { class: 'empty' }, 'No trains running.')]));

  const ok = Object.values(latest.feeds_ok || {}).every(Boolean);
  setText('asof', `Data as of ${fmtTime(latest.updated_at)} ET · checked every 5 minutes · timetable ${latest.gtfs_version}${ok ? '' : ' · some SEPTA feeds failed on the last check'}`);
  renderTable();
}

function renderTable() {
  const tbody = document.querySelector('#train-table tbody');
  const rows = trains.filter(t => t.legs?.length).sort((a, b) => a.dep - b.dep).map(r => {
    const color = r.status === 'ghost' ? GHOST_COLOR : r.first_seen ? band(r.status === 'running' ? r.late_now : finalLate(r)).color : 'var(--muted)';
    return el('tr', {},
      el('td', {}, r.train),
      el('td', {}, lineNames(r, network)),
      el('td', {}, `${fmtTime(r.dep)} – ${fmtTime(r.arr)}`),
      el('td', {}, el('span', { class: 'status-chip', style: `--c:${color}` }, statusText(r))),
      el('td', {}, r.first_seen ? `${Math.max(0, r.status === 'running' ? r.late_now ?? 0 : finalLate(r))} min` : '–'),
      el('td', {}, r.late_max != null ? `${r.late_max} min` : '–'));
  });
  tbody.replaceChildren(...rows);
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

// ---------- data ----------

async function refresh() {
  ({ latest, day } = await loadLive());
  trains = [...Object.values(day.trains), ...Object.values(day.extras || {})];
  const firstPoll = day.polls?.[0]?.[0] ?? latest.updated_at;
  slider.min = String(firstPoll);
  slider.max = String(latest.updated_at);
  if (liveMode) slider.value = slider.max;
  renderPanels();
  renderRules(latest.rules);
  render(currentT());
}

function addLayers() {
  map.addSource('network', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: network.lines.flatMap(l => l.paths.map(p => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: p }, properties: { line: l.name } }))) },
  });
  map.addSource('stations', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: Object.entries(network.stops).map(([id, [name, lat, lon]]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { id, name } })) },
  });
  map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({ id: 'network', type: 'line', source: 'network', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#5a5955', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 13, 4] } });
  map.addLayer({ id: 'stations', type: 'circle', source: 'stations', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 13, 4], 'circle-color': '#898781' } });
  map.addLayer({ id: 'station-labels', type: 'symbol', source: 'stations', minzoom: 12, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top' }, paint: { 'text-color': '#c3c2b7', 'text-halo-color': '#1a1a19', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'trails', type: 'line', source: 'trails', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': ['case', ['get', 'finished'], 0.3, 0.75] } });
  map.addLayer({ id: 'trail-hit', type: 'line', source: 'trails', paint: { 'line-color': '#000', 'line-width': 12, 'line-opacity': 0 } });
  map.addLayer({ id: 'train-hit', type: 'circle', source: 'trains', paint: { 'circle-radius': 14, 'circle-opacity': 0 } });
  map.addLayer({ id: 'trains', type: 'circle', source: 'trains', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['get', 'radius'], 13, ['*', ['get', 'radius'], 1.4]], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#1a1a19', 'circle-stroke-width': 2 } });
  // Minutes late, always shown for late trains (secondary encoding: color is never the only cue).
  map.addLayer({ id: 'train-late', type: 'symbol', source: 'trains', layout: { 'text-field': ['get', 'late'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-allow-overlap': true }, paint: { 'text-color': '#f0efec', 'text-halo-color': '#1a1a19', 'text-halo-width': 2 } });
  map.addLayer({ id: 'train-labels', type: 'symbol', source: 'trains', minzoom: 11, layout: { 'text-field': ['concat', '#', ['get', 'label']], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -1.4], 'text-anchor': 'bottom' }, paint: { 'text-color': '#c3c2b7', 'text-halo-color': '#1a1a19', 'text-halo-width': 1.5 } });
  hookLayerTooltip('train-hit');
  hookLayerTooltip('trail-hit');
  map.getCanvas().addEventListener('mouseleave', hideTooltip);

  const bounds = new maplibregl.LngLatBounds();
  for (const l of network.lines) for (const p of l.paths) for (const c of p) bounds.extend(c);
  map.fitBounds(bounds, { padding: 30, duration: 0 });
}

async function start() {
  network = await getJson('static/network.json');
  await new Promise(r => (map.loaded() ? r() : map.on('load', r)));
  addLayers();
  try {
    await refresh();
  } catch (e) {
    setText('traffic-level', 'No data yet');
    setText('traffic-detail', 'The logger hasn’t produced data yet. Run it, then reload.');
    console.error(e);
  }
  setInterval(() => refresh().catch(console.error), REFRESH_MS);
}
start();
