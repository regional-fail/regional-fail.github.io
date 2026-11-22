// SEPTA Regional Rail timetable (GTFS): build a compact cache and list a day's scheduled trains.
import { unzipSync, strFromU8 } from 'fflate';
import { parseCsv } from './csv.mjs';
import { gtfsTimeToEpoch, weekdayOf, etMinuteOfDay } from './time.mjs';
import { km } from './geo.mjs';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

/** Rush-hour windows (Philadelphia local minutes after midnight). Published on the site. */
export const RUSH = {
  am: { dir: 'Inbound', field: 'arr', from: 6 * 60, to: 9 * 60 + 30 },   // inbound arriving 6:00-9:30am
  pm: { dir: 'Outbound', field: 'dep', from: 16 * 60, to: 19 * 60 },    // outbound departing 4:00-7:00pm
};

/** Thin a polyline: keep points at least `minKm` apart, round to 5 decimals (~1 m). */
function simplify(points, minKm = 0.03) {
  const out = [];
  for (const p of points) {
    if (!out.length || km(out.at(-1), p) >= minKm) out.push(p.map(v => Math.round(v * 1e5) / 1e5));
  }
  if (points.length && out.at(-1) !== points.at(-1)) out.push(points.at(-1).map(v => Math.round(v * 1e5) / 1e5));
  return out;
}

/**
 * Build the compact timetable cache from SEPTA's gtfs_public.zip (which contains google_rail.zip).
 * @param {Uint8Array} publicZip
 * @param {string} version release tag, e.g. "v202611220"
 */
export function buildRailCache(publicZip, version) {
  const outer = unzipSync(publicZip, { filter: f => f.name === 'google_rail.zip' });
  if (!outer['google_rail.zip']) throw new Error('google_rail.zip not found in GTFS release');
  const files = unzipSync(outer['google_rail.zip']);
  const read = name => {
    if (!files[name]) throw new Error(`${name} missing from google_rail.zip`);
    return parseCsv(strFromU8(files[name]));
  };

  const feed = read('feed_info.txt')[0] || {};
  const routes = {};
  for (const r of read('routes.txt')) {
    routes[r.route_id] = { name: r.route_long_name.replace(/ Line$/, ''), color: `#${r.route_color || '4F758B'}` };
  }
  const directions = {};
  for (const d of read('directions.txt')) directions[`${d.route_id}|${d.direction_id}`] = d.direction;
  const stops = {};
  for (const s of read('stops.txt')) stops[s.stop_id] = [s.stop_name, Number(s.stop_lat), Number(s.stop_lon)];

  const stopTimes = new Map();
  for (const st of read('stop_times.txt')) {
    const list = stopTimes.get(st.trip_id) || [];
    list.push([Number(st.stop_sequence), st.stop_id, st.departure_time || st.arrival_time, st.arrival_time || st.departure_time]);
    stopTimes.set(st.trip_id, list);
  }
  const trips = read('trips.txt').map(t => {
    const st = (stopTimes.get(t.trip_id) || []).sort((a, b) => a[0] - b[0]);
    return {
      id: t.trip_id, r: t.route_id, s: t.service_id, b: t.block_id, d: t.direction_id,
      h: t.trip_headsign, sh: t.shape_id,
      // [stop_id, departure "HH:MM:SS"]; last stop uses its arrival time.
      st: st.map((x, i) => [x[1], i === st.length - 1 ? x[3] : x[2]]),
    };
  }).filter(t => t.st.length >= 2);

  const shapePts = new Map();
  if (files['shapes.txt']) {
    for (const p of read('shapes.txt')) {
      const list = shapePts.get(p.shape_id) || [];
      list.push([Number(p.shape_pt_sequence), Number(p.shape_pt_lat), Number(p.shape_pt_lon)]);
      shapePts.set(p.shape_id, list);
    }
  }
  const shapes = {};
  for (const [id, pts] of shapePts) shapes[id] = simplify(pts.sort((a, b) => a[0] - b[0]).map(p => [p[1], p[2]]));

  return {
    version,
    feed_start: feed.feed_start_date || null,
    feed_end: feed.feed_end_date || null,
    built_at: new Date().toISOString(),
    routes, directions, stops,
    calendar: read('calendar.txt'),
    calendar_dates: read('calendar_dates.txt'),
    trips, shapes,
  };
}

/** Service ids active on a date ("YYYY-MM-DD"), plus whether it is a regular weekday schedule. */
export function activeServices(rail, date) {
  const ymd = date.replaceAll('-', '');
  const wd = weekdayOf(date);
  const active = new Set(rail.calendar.filter(c => c[wd] === '1' && c.start_date <= ymd && ymd <= c.end_date).map(c => c.service_id));
  for (const e of rail.calendar_dates.filter(e => e.date === ymd)) {
    if (e.exception_type === '1') active.add(e.service_id); else active.delete(e.service_id);
  }
  // A holiday running a weekend schedule on a weekday is not a "weekday" for rush-hour purposes.
  const weekdayService = [...active].some(id => {
    const c = rail.calendar.find(x => x.service_id === id);
    return c && WEEKDAYS.some(d => c[d] === '1');
  });
  return { active, weekdayService };
}

/**
 * Scheduled trains for one service date, keyed by train number.
 * A train number can cover two lines (through-routed via Center City): one "leg" per line.
 */
export function scheduleForDate(rail, date) {
  const { active, weekdayService } = activeServices(rail, date);
  const trains = {};
  for (const t of rail.trips) {
    if (!active.has(t.s)) continue;
    const [first, last] = [t.st[0], t.st.at(-1)];
    const leg = {
      route: t.r,
      dir: rail.directions[`${t.r}|${t.d}`] || (t.d === '0' ? 'Outbound' : 'Inbound'),
      headsign: t.h,
      trip: t.id,
      shape: t.sh,
      from: first[0],
      to: last[0],
      dep: gtfsTimeToEpoch(date, first[1]),
      arr: gtfsTimeToEpoch(date, last[1]),
      rush: null,
    };
    if (weekdayService) {
      for (const [name, w] of Object.entries(RUSH)) {
        const m = etMinuteOfDay(leg[w.field]);
        if (leg.dir === w.dir && m >= w.from && m <= w.to) leg.rush = name;
      }
    }
    const rec = trains[t.b] ||= { train: t.b, legs: [] };
    rec.legs.push(leg);
  }
  for (const rec of Object.values(trains)) {
    rec.legs.sort((a, b) => a.dep - b.dep);
    rec.dep = rec.legs[0].dep;
    rec.arr = rec.legs.at(-1).arr;
  }
  return { date, gtfs_version: rail.version, weekday_service: weekdayService, trains };
}
