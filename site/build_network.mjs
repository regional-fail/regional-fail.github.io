// Build the static network file the map draws: line shapes and stations from SEPTA's timetable.
// Usage: node site/build_network.mjs   -> site/static/network.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rail = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'gtfs', 'rail.json'), 'utf8'));

// Shapes used by each line, and the stations each line serves.
const shapesByRoute = {}, stopsUsed = new Set();
for (const t of rail.trips) {
  (shapesByRoute[t.r] ||= new Set()).add(t.sh);
  for (const [stop] of t.st) stopsUsed.add(stop);
}
const lines = Object.entries(rail.routes).map(([id, r]) => ({
  id, name: r.name,
  paths: [...(shapesByRoute[id] || [])].map(sh => rail.shapes[sh]).filter(Boolean).map(pts => pts.map(([lat, lon]) => [lon, lat])),
}));
const stops = {};
for (const id of stopsUsed) if (rail.stops[id]) stops[id] = rail.stops[id];

const out = { gtfs_version: rail.version, built_at: new Date().toISOString(), lines, stops };
fs.mkdirSync(path.join(ROOT, 'site', 'static'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'site', 'static', 'network.json'), JSON.stringify(out));
console.log(`network.json: ${lines.length} lines, ${lines.reduce((a, l) => a + l.paths.length, 0)} paths, ${Object.keys(stops).length} stations`);
