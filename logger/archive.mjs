// Finalize finished service days: write the permanent daily record + map traces, then close the live file.
// Runs automatically at the end of each poll; can also be run by hand: node logger/archive.mjs [--force DATE]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { paths } from './lib/paths.mjs';
import { nowSec } from './lib/time.mjs';
import { classifyTrain } from './lib/classify.mjs';
import { summarizeDay } from './lib/summary.mjs';
import { RULES } from './lib/rules.mjs';

const FINALIZE_AFTER = 2 * 3600;   // 2 h after the day's last scheduled arrival

const readJson = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
function writeGz(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, zlib.gzipSync(JSON.stringify(obj), { level: 9 }));
}
export const readGz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));

function lastArrival(state) {
  return Math.max(0, ...Object.values(state.trains).map(t => t.arr), ...Object.values(state.extras || {}).map(t => t.last_seen || 0));
}

/** Gaps in our own polling longer than 10 minutes (published so nobody mistakes our outage for SEPTA's). */
function pollGaps(polls) {
  const gaps = [];
  const ok = polls.filter(p => p[1]).map(p => p[0]);
  for (let i = 1; i < ok.length; i++) if (ok[i] - ok[i - 1] > 600) gaps.push([ok[i - 1], ok[i]]);
  return gaps;
}

const compactLeg = l => ({ route: l.route, dir: l.dir, headsign: l.headsign, from: l.from, to: l.to, dep: l.dep, arr: l.arr, rush: l.rush, status: l.status, ghost: l.ghost, late_final: l.late_final, late_max: l.late_max });

function compactTrain(t) {
  const out = { train: t.train, status: t.status, ghost: t.ghost ?? null, dep: t.dep, arr: t.arr, legs: (t.legs || []).map(compactLeg) };
  for (const k of ['first_seen', 'last_seen', 'late_max', 'cars', 'service', 'partial', 'alert_canceled', 'removed_from_timetable', 'added_in', 'trainno']) {
    if (t[k] != null) out[k] = t[k];
  }
  return out;
}

export function finalizeDay(state, now, routes, stops) {
  for (const rec of Object.values(state.trains)) classifyTrain(rec, now, state.polls, stops);
  const summary = summarizeDay(state, now, routes);
  const record = {
    v: 1,
    date: state.date,
    finalized_at: now,
    rules: RULES,
    gtfs_baseline: state.gtfs_baseline,
    gtfs_versions: state.gtfs_versions,
    weekday_service: state.weekday_service,
    polling: { polls: state.polls.length, ok: state.polls.filter(p => p[1]).length, first: state.polls[0]?.[0] ?? null, last: state.polls.at(-1)?.[0] ?? null, gaps: pollGaps(state.polls) },
    errors: state.errors.length,
    alerts: state.alerts,
    rt_flags: state.rt_flags,
    summary,
    trains: Object.values(state.trains).map(compactTrain),
    extras: Object.values(state.extras || {}).map(compactTrain),
  };
  const traces = { date: state.date, trails: {} };
  for (const t of [...Object.values(state.trains), ...Object.values(state.extras || {})]) if (t.trail?.length) traces.trails[t.train] = t.trail;
  return { record, traces };
}

function updateIndex(record) {
  const index = readJson(paths.archiveIndex, { days: [] });
  const s = record.summary.system;
  const entry = {
    date: record.date,
    due: s.all.due, ran: s.all.ran, ghosts: s.all.ghosts, unknown: s.all.unknown,
    on_time_rate: s.rates.on_time_rate, avg_late: s.rates.avg_late,
    score: s.score?.score ?? null, grade: s.score?.grade ?? null,
    // Full totals per line + direction, so the site can combine any range of days and re-score exactly.
    lines: Object.fromEntries(record.summary.lines.map(l => [`${l.route}|${l.dir}`, {
      route: l.route, name: l.name, dir: l.dir, all: l.all, rush: l.rush, score: l.score?.score ?? null, grade: l.score?.grade ?? null,
    }])),
  };
  index.days = [...index.days.filter(d => d.date !== record.date), entry].sort((a, b) => a.date.localeCompare(b.date));
  fs.mkdirSync(path.dirname(paths.archiveIndex), { recursive: true });
  fs.writeFileSync(paths.archiveIndex, JSON.stringify(index, null, 1));
}

/** Archive every open day that is over. Returns the dates archived. */
export function archiveFinishedDays({ now = nowSec(), force = null, log = console.log } = {}) {
  const rail = readJson(paths.gtfsCache);
  if (!fs.existsSync(paths.daysDir)) return [];
  const done = [];
  for (const file of fs.readdirSync(paths.daysDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
    const state = readJson(path.join(paths.daysDir, file));
    if (!state) continue;
    const ready = force === state.date || now > lastArrival(state) + FINALIZE_AFTER;
    if (!ready || !state.polls.length) continue;
    const { record, traces } = finalizeDay(state, now, rail?.routes, rail?.stops || {});
    writeGz(paths.archiveDay(state.date), record);
    writeGz(paths.traceDay(state.date), traces);
    updateIndex(record);
    fs.rmSync(path.join(paths.daysDir, file));
    const s = record.summary.system;
    log(`archived ${state.date}: ${s.all.due} legs due, ${s.all.ghosts} ghost, ${s.all.unknown} unknown, score ${s.score?.score ?? '-'}`);
    done.push(state.date);
  }
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--force');
  archiveFinishedDays({ force: i > 0 ? process.argv[i + 1] : null });
}
