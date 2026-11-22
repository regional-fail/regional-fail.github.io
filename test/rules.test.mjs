// Tests for the rules every published number depends on. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDayState, applyPoll, reconcileSchedule } from '../logger/lib/state.mjs';
import { classifyTrain, legOnTime } from '../logger/lib/classify.mjs';
import { canceledTrainsFromText } from '../logger/lib/alerts.mjs';
import { gtfsTimeToEpoch, etParts } from '../logger/lib/time.mjs';
import { summarizeDay, score, emptyAgg } from '../logger/lib/summary.mjs';
import { normalizeTrain } from '../logger/lib/septa.mjs';

const T0 = 1_800_000_000;            // arbitrary base instant
const MIN = 60;
// Stops: Center City (Suburban), a suburb 30 km west, and a second suburb 25 km north.
const STOPS = { CC: ['Suburban Station', 39.95389, -75.16778], WEST: ['Paoli', 40.04306, -75.48389], NORTH: ['Warminster', 40.195, -75.08889] };

function leg(route, dir, from, to, depMin, arrMin, rush = null) {
  return { route, dir, headsign: to, trip: `${route}-${depMin}`, shape: 's', from, to, dep: T0 + depMin * MIN, arr: T0 + arrMin * MIN, rush };
}
function schedule(trains) {
  const out = {};
  for (const [no, legs] of Object.entries(trains)) out[no] = { train: no, legs, dep: legs[0].dep, arr: legs.at(-1).arr };
  return { date: '2027-01-04', gtfs_version: 'v1', weekday_service: true, trains: out };
}
const ok = data => ({ ok: true, data });
function feeds(trains = [], { rtTrips = [], alerts = [] } = {}) {
  return { trainView: ok(trains), alerts: ok(alerts), rtTrips: ok(rtTrips), rtAlerts: ok([]) };
}
const tv = (no, lat, lon, late, extra = {}) => normalizeTrain({ trainno: no, lat, lon, late, line: 'X', consist: '101,102', currentstop: '', nextstop: extra.next || '', SOURCE: '', dest: '', ...extra });

/** Poll every 5 minutes from `fromMin` to `toMin`, with the feed returned by `feedAt(minute)`. */
function run(state, fromMin, toMin, feedAt) {
  for (let m = fromMin; m <= toMin; m += 5) applyPoll([state], state, feedAt(m), T0 + m * MIN, STOPS);
}

// Train 100: inbound West -> CC, 0:00-0:40. Positions interpolate along the way.
const lerp = (a, b, f) => [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

test('a train seen through its trip is "done" and on time at 5 minutes late', () => {
  const s = createDayState(schedule({ 100: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)] }), T0 - 30 * MIN);
  run(s, -20, 90, m => {
    if (m < 0 || m > 45) return feeds([]);
    const [lat, lon] = lerp(STOPS.WEST, STOPS.CC, Math.min(1, m / 45));
    return feeds([tv('100', lat, lon, 5, { next: m >= 40 ? 'Suburban Station' : '' })]);
  });
  const rec = s.trains['100'];
  assert.equal(rec.status, 'done');
  assert.equal(rec.legs[0].late_final, 5);
  assert.equal(legOnTime(rec.legs[0]), true);
});

test('6 minutes late is not on time (SEPTA\'s own rule)', () => {
  assert.equal(legOnTime({ status: 'done', late_final: 6 }), false);
  assert.equal(legOnTime({ status: 'done', late_final: 5 }), true);
  assert.equal(legOnTime({ status: 'partial', late_final: 0 }), false);
  assert.equal(legOnTime({ status: 'running', late_final: 0 }), null);
});

test('never seen while we were polling -> inferred ghost', () => {
  const s = createDayState(schedule({ 200: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)] }), T0 - 30 * MIN);
  run(s, -20, 30, () => feeds([]));
  assert.equal(s.trains['200'].status, 'missing', 'still inside its window: only suspected');
  run(s, 35, 75, () => feeds([]));
  assert.equal(s.trains['200'].status, 'ghost');
  assert.equal(s.trains['200'].ghost, 'inferred');
});

test('never seen but we were NOT polling during its run -> unknown, never a ghost', () => {
  const s = createDayState(schedule({ 300: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)] }), T0 - 30 * MIN);
  run(s, 60, 120, () => feeds([]));   // logger started after the train's scheduled run
  assert.equal(s.trains['300'].status, 'unknown');
});

test('listed as "999" (never departed) the whole time still counts as a ghost', () => {
  const s = createDayState(schedule({ 400: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)] }), T0 - 30 * MIN);
  run(s, -20, 80, () => feeds([tv('400', STOPS.WEST[1], STOPS.WEST[2], 999)]));
  assert.equal(s.trains['400'].status, 'ghost');
});

test('SEPTA marking the trip CANCELED -> confirmed ghost', () => {
  const s = createDayState(schedule({ 500: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)] }), T0 - 30 * MIN);
  run(s, -20, 10, () => feeds([], { rtTrips: [{ trip: 'PAO-0', route: 'PAO', rel: 'CANCELED', skipped: 0 }] }));
  assert.equal(s.trains['500'].status, 'ghost');
  assert.equal(s.trains['500'].ghost, 'confirmed');
});

test('an announced cancellation is overruled if the train actually runs', () => {
  const s = createDayState(schedule({ 600: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)] }), T0 - 30 * MIN);
  const alert = { source: 'alerts-json', route: 'PAO', text: 'Paoli/Thorndale Train #600 is canceled.' };
  run(s, -20, 20, m => feeds(m >= 0 ? [tv('600', ...lerp(STOPS.WEST, STOPS.CC, m / 45), 2)] : [], { alerts: [alert] }));
  assert.equal(s.trains['600'].status, 'running');
  assert.ok(s.trains['600'].alert_canceled.length, 'the alert is still recorded for the audit trail');
});

test('a through train that turns back at Center City: its second leg is a ghost ("skipped")', () => {
  const s = createDayState(schedule({ 700: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40), leg('WAR', 'Outbound', 'CC', 'NORTH', 40, 90)] }), T0 - 30 * MIN);
  run(s, -20, 160, m => {
    if (m < 0 || m > 42) return feeds([]);
    return feeds([tv('700', ...lerp(STOPS.WEST, STOPS.CC, Math.min(1, m / 40)), 1)]);
  });
  const rec = s.trains['700'];
  assert.equal(rec.legs[0].status, 'done');
  assert.equal(rec.legs[1].status, 'ghost');
  assert.equal(rec.legs[1].ghost, 'skipped');
  assert.equal(rec.status, 'partial');
});

test('a gap in OUR polling does not make a running train look finished', () => {
  const s = createDayState(schedule({ 800: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)] }), T0 - 30 * MIN);
  run(s, 0, 10, m => feeds([tv('800', ...lerp(STOPS.WEST, STOPS.CC, m / 45), 0)]));
  // Our logger is down from 0:15 to 0:35; then one poll at 0:35 with the train gone.
  applyPoll([s], s, feeds([]), T0 + 35 * MIN, STOPS);
  assert.equal(s.trains['800'].status, 'running');
});

test('trains removed by a later timetable update are pre-canceled ghosts', () => {
  const sch = schedule({ 900: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)], 901: [leg('PAO', 'Inbound', 'WEST', 'CC', 60, 100)] });
  const s = createDayState(sch, T0 - 24 * 3600);
  const updated = schedule({ 901: sch.trains['901'].legs });
  updated.gtfs_version = 'v2';
  const diff = reconcileSchedule(s, updated, T0 - 12 * 3600);
  assert.deepEqual(diff.removed, ['900']);
  classifyTrain(s.trains['900'], T0 + 10 * MIN, s.polls, STOPS);
  assert.equal(s.trains['900'].ghost, 'pre-canceled');
});

test('alert text parsing', () => {
  const nums = t => canceledTrainsFromText(t).map(x => x.train);
  assert.deepEqual(nums('Paoli/Thorndale Train #9558 (6:30 PM from Suburban) is canceled.'), ['9558']);
  assert.deepEqual(nums('Trains #1717, #1719 and #1721 are canceled due to equipment.'), ['1717', '1719', '1721']);
  assert.deepEqual(nums('Train 4446 is cancelled today.'), ['4446']);
  assert.deepEqual(nums('Train #1234 is operating 20 minutes late.'), []);
  assert.deepEqual(nums('Train #1234 will not be canceled.'), []);
  assert.deepEqual(nums('Train #1234 will operate in place of canceled Train #5678.'), ['5678']);
  assert.deepEqual(nums('Sunday Schedule in Effect for Thanksgiving Day'), []);
});

test('score formula and grades', () => {
  const agg = { ...emptyAgg(), w_ran: 9, w_ghost: 1, w_finished: 9, w_on_time: 9, w_late_sum: 0 };
  assert.deepEqual([score(agg).score, score(agg).grade], [95, 'A']);   // 0.5*0.9 + 0.3*1 + 0.2*1
  const bad = { ...emptyAgg(), w_ran: 7, w_ghost: 3, w_finished: 7, w_on_time: 4, w_late_sum: 7 * 15 };
  assert.equal(score(bad).grade, 'F');   // 0.5*0.7 + 0.3*0.571 + 0 = 52.1
  assert.equal(score(emptyAgg()), null);
});

test('rush-hour trains count double in the score', () => {
  const s = createDayState(schedule({
    1: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40, 'am')],    // rush, ghost
    2: [leg('PAO', 'Inbound', 'WEST', 'CC', 0, 40)],          // not rush, ran on time
  }), T0 - 30 * MIN);
  run(s, -20, 120, m => (m >= 0 && m <= 42 ? feeds([tv('2', ...lerp(STOPS.WEST, STOPS.CC, Math.min(1, m / 40)), 0, { next: m >= 38 ? 'Suburban Station' : '' })]) : feeds([])));
  const sum = summarizeDay(s, T0 + 120 * MIN, {});
  assert.equal(sum.system.all.ghosts, 1);
  assert.equal(sum.system.rates.delivered_rate, 0.5);                 // plain count
  assert.ok(Math.abs(sum.system.score.delivered - 1 / 3) < 1e-9);    // weighted: 1 / (1 + 2)
});

test('GTFS times use noon-minus-12h, so they stay right across daylight-saving changes', () => {
  // 2027-03-14 is the spring-forward Sunday. "12:00:00" on that service date must be noon EDT.
  const p = etParts(gtfsTimeToEpoch('2027-03-14', '12:00:00') * 1000);
  assert.deepEqual([p.date, p.hour, p.minute], ['2027-03-14', 12, 0]);
  // Fall-back Sunday 2026-11-01: "18:00:00" must be 6pm EST.
  const f = etParts(gtfsTimeToEpoch('2026-11-01', '18:00:00') * 1000);
  assert.deepEqual([f.date, f.hour], ['2026-11-01', 18]);
  // Ordinary day: 25:30 on Nov 23 is 1:30am Nov 24.
  const q = etParts(gtfsTimeToEpoch('2026-11-23', '25:30:00') * 1000);
  assert.deepEqual([q.date, q.hour, q.minute], ['2026-11-24', 1, 30]);
});
