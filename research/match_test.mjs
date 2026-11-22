// Research spike: can we match SEPTA's live TrainView feed to the GTFS timetable?
// Usage: node research/match_test.mjs <path-to-google_rail-folder>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('pass the google_rail folder path');

// Minimal CSV parser (handles quoted fields with commas).
function readCsv(file) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, '');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); rows.push(out);
  }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// "Service day" in Philadelphia time.
const now = new Date();
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
const ymd = `${parts.year}${parts.month}${parts.day}`;
const weekday = parts.weekday.toLowerCase();
const nowMin = (+parts.hour % 24) * 60 + +parts.minute;

const calendar = readCsv('calendar.txt');
const exceptions = readCsv('calendar_dates.txt');
const active = new Set(calendar.filter(c => c[weekday] === '1' && c.start_date <= ymd && ymd <= c.end_date).map(c => c.service_id));
for (const e of exceptions.filter(e => e.date === ymd)) e.exception_type === '1' ? active.add(e.service_id) : active.delete(e.service_id);

const directions = new Map(readCsv('directions.txt').map(d => [`${d.route_id}|${d.direction_id}`, d.direction]));
const trips = readCsv('trips.txt').filter(t => active.has(t.service_id));
const tripIds = new Set(trips.map(t => t.trip_id));
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const span = new Map();
for (const st of readCsv('stop_times.txt')) {
  if (!tripIds.has(st.trip_id)) continue;
  const t = toMin(st.departure_time || st.arrival_time);
  const s = span.get(st.trip_id) || { first: Infinity, last: -Infinity };
  s.first = Math.min(s.first, t); s.last = Math.max(s.last, t); span.set(st.trip_id, s);
}

// Group scheduled trips by train number (block_id); a through-routed train has one trip per line.
const byTrain = new Map();
for (const t of trips) {
  const s = span.get(t.trip_id);
  const e = byTrain.get(t.block_id) || { train: t.block_id, legs: [], first: Infinity, last: -Infinity };
  e.legs.push(`${t.route_id} ${directions.get(`${t.route_id}|${t.direction_id}`)}`);
  e.first = Math.min(e.first, s.first); e.last = Math.max(e.last, s.last);
  byTrain.set(t.block_id, e);
}

const live = await (await fetch('https://www3.septa.org/api/TrainView/index.php')).json();
const liveNos = new Map(live.map(t => [t.trainno.replace(/\D+$/, ''), t]));

const shouldBeRunning = [...byTrain.values()].filter(e => e.first <= nowMin - 5 && e.last >= nowMin + 5);
const hh = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
console.log(`Service day ${ymd} (${weekday}), now ${hh(nowMin)} ET, active service ids: ${[...active].join(', ')}`);
console.log(`Scheduled trains today: ${byTrain.size}; live trains in feed: ${live.length}`);
console.log(`Trains that should be mid-trip right now: ${shouldBeRunning.length}`);
const missing = shouldBeRunning.filter(e => !liveNos.has(e.train));
console.log(`  ...of which NOT in live feed: ${missing.length}`);
for (const m of missing) console.log(`    #${m.train} ${hh(m.first)}-${hh(m.last)} ${m.legs.join(' + ')}`);
const unknown = [...liveNos.keys()].filter(n => !byTrain.has(n));
console.log(`Live trains not in today's timetable: ${unknown.length} ${unknown.map(n => `#${liveNos.get(n).trainno}(${liveNos.get(n).line})`).join(' ')}`);
const suffixed = live.filter(t => /\D$/.test(t.trainno)).map(t => t.trainno);
console.log(`Live train numbers with letter suffix: ${suffixed.join(' ') || 'none'}`);
console.log(`late=999 entries: ${live.filter(t => t.late === 999).map(t => `#${t.trainno}@${t.currentstop}`).join(' ') || 'none'}`);
