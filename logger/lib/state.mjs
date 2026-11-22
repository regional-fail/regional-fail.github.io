// Day state: one JSON document per service date holding the baseline timetable plus everything observed.
import { RULES } from './rules.mjs';
import { km } from './geo.mjs';
import { classifyTrain } from './classify.mjs';
import { canceledTrainsFromText } from './alerts.mjs';

export const STATE_VERSION = 1;

function legFromSchedule(l) {
  return { ...l, polls: 0, late_final: null, late_max: null };
}

/** New day state from a schedule (see gtfs.scheduleForDate). The schedule becomes the baseline. */
export function createDayState(schedule, now) {
  const trains = {};
  for (const [no, t] of Object.entries(schedule.trains)) {
    trains[no] = { train: no, scheduled: true, dep: t.dep, arr: t.arr, legs: t.legs.map(legFromSchedule), status: 'upcoming' };
  }
  return {
    v: STATE_VERSION,
    date: schedule.date,
    created_at: now,
    updated_at: now,
    weekday_service: schedule.weekday_service,
    gtfs_baseline: schedule.gtfs_version,
    gtfs_versions: [{ version: schedule.gtfs_version, seen_at: now }],
    polls: [],          // [t, trainViewOk 0|1, trains in feed]
    errors: [],         // [t, source, message]
    alerts: [],         // unique alert texts seen today
    rt_flags: [],       // GTFS-rt trips marked other than SCHEDULED
    trains,
    extras: {},         // trains seen in the feed that are not in the timetable
  };
}

/**
 * SEPTA published a new timetable: trips missing from it that were in our baseline are "removed from timetable"
 * (pre-canceled if they never run); new trips are added and marked as added.
 */
export function reconcileSchedule(state, schedule, now) {
  if (state.gtfs_versions.at(-1)?.version === schedule.gtfs_version) return { removed: [], added: [] };
  state.gtfs_versions.push({ version: schedule.gtfs_version, seen_at: now });
  const removed = [], added = [];
  for (const [no, rec] of Object.entries(state.trains)) {
    if (rec.scheduled && !schedule.trains[no] && !rec.removed_from_timetable) { rec.removed_from_timetable = schedule.gtfs_version; removed.push(no); }
  }
  for (const [no, t] of Object.entries(schedule.trains)) {
    if (!state.trains[no]) {
      state.trains[no] = { train: no, scheduled: true, added_in: schedule.gtfs_version, dep: t.dep, arr: t.arr, legs: t.legs.map(legFromSchedule), status: 'upcoming' };
      added.push(no);
    }
  }
  return { removed, added };
}

/**
 * Which leg is the train on? Use schedule time adjusted for its lateness. A train sitting in Center City
 * at the hand-over minute still belongs to the leg it just finished.
 */
export function currentLeg(rec, now, lateMin) {
  const eff = now - (lateMin || 0) * 60;
  let idx = 0;
  rec.legs.forEach((l, i) => { if (i === 0 || eff > l.dep + 60) idx = i; });
  return idx;
}

function observe(rec, t, now) {
  rec.listed_first ??= now;
  if (!t.reporting) { rec.listed_last = now; return; }   // listed but not running yet ("999")
  const pos = [t.lat, t.lon];
  rec.first_seen ??= now;
  rec.first_pos ??= pos;
  rec.last_seen = now;
  rec.last_pos = pos;
  rec.polls = (rec.polls || 0) + 1;
  rec.late_now = t.late;
  rec.late_max = Math.max(rec.late_max ?? t.late, t.late);
  if (t.cars.length) rec.cars = t.cars;
  Object.assign(rec, { tv_line: t.line, service: t.service, tv_source: t.source, tv_dest: t.dest, cur: t.cur, next: t.next, trainno: t.trainno });
  rec.trail ||= [];
  const lastPt = rec.trail.at(-1);
  if (!lastPt || km([lastPt[1], lastPt[2]], pos) > 0.05 || lastPt[3] !== t.late) rec.trail.push([now, t.lat, t.lon, t.late]);
  if (rec.legs?.length) {
    const i = currentLeg(rec, now, t.late);
    rec.cur_leg = i;
    const leg = rec.legs[i];
    leg.polls++;
    leg.late_final = t.late;
    leg.late_max = Math.max(leg.late_max ?? t.late, t.late);
  }
}

/** Find the open day whose scheduled run of this train number is plausible right now. */
export function matchDay(states, trainNo, now) {
  let best = null, bestDist = Infinity;
  for (const s of states) {
    const rec = s.trains[trainNo];
    if (!rec) continue;
    if (now < rec.dep - RULES.matchBefore || now > rec.arr + RULES.matchAfter) continue;
    const dist = now < rec.dep ? rec.dep - now : now > rec.arr ? now - rec.arr : 0;
    if (dist < bestDist) { best = s; bestDist = dist; }
  }
  return best;
}

/**
 * Apply one poll's feeds to all open day states.
 * @param states open day states (usually 1, 2 around the early-morning overlap)
 * @param current the state that unmatched "extra" trains are recorded on
 * @param feeds result of septa.fetchAll()
 * @param stops timetable stops (for partial-trip checks)
 */
export function applyPoll(states, current, feeds, now, stops) {
  const tv = feeds.trainView;
  for (const s of states) {
    s.updated_at = now;
    s.polls.push([now, tv.ok ? 1 : 0, tv.ok ? tv.data.length : 0]);
    for (const [name, r] of Object.entries(feeds)) if (!r.ok) s.errors.push([now, name, r.error]);
  }

  if (tv.ok) {
    for (const t of tv.data) {
      if (!t.train) continue;
      const day = matchDay(states, t.train, now);
      if (day) observe(day.trains[t.train], t, now);
      else if (t.reporting) {   // ignore stale "999" listings of old trains (SEPTA leaves canceled trains listed)
        const rec = current.extras[t.train] ||= { train: t.train, scheduled: false, legs: [] };
        observe(rec, t, now);
      }
    }
  }

  // Alerts: keep each unique text once; mark trains whose cancellation SEPTA announced.
  const texts = [...(feeds.alerts.ok ? feeds.alerts.data : []), ...(feeds.rtAlerts.ok ? feeds.rtAlerts.data : [])];
  for (const a of texts) {
    for (const s of states) {
      if (!s.alerts.some(x => x.text === a.text)) s.alerts.push({ first_seen: now, source: a.source, route: a.route, text: a.text });
    }
    // Alerts are current, so a cancellation applies to the nearest upcoming/ongoing run of that train number
    // (SEPTA often posts the evening before), never to a run that already finished.
    for (const { train, sentence } of canceledTrainsFromText(a.text)) {
      let target = null, dist = Infinity;
      for (const s of states) {
        const rec = s.trains[train];
        if (!rec || now > rec.arr + 2 * 3600 || now < rec.dep - 18 * 3600) continue;
        const d = Math.abs(rec.dep - now);
        if (d < dist) { dist = d; target = rec; }
      }
      if (!target) continue;
      target.alert_canceled ||= [];
      if (!target.alert_canceled.includes(sentence)) target.alert_canceled.push(sentence);
    }
  }

  // GTFS-rt trips flagged CANCELED / ADDED / with skipped stops: record for audit.
  if (feeds.rtTrips.ok) {
    for (const r of feeds.rtTrips.data.filter(r => r.rel !== 'SCHEDULED' || r.skipped)) {
      for (const s of states) {
        const train = Object.values(s.trains).find(x => x.legs.some(l => l.trip === r.trip));
        if (!train) continue;
        if (!s.rt_flags.some(f => f.trip === r.trip && f.rel === r.rel)) s.rt_flags.push({ t: now, trip: r.trip, train: train.train, rel: r.rel, skipped: r.skipped });
        if (r.rel === 'CANCELED') {
          train.alert_canceled ||= [];
          const note = `GTFS-realtime marked trip ${r.trip} CANCELED`;
          if (!train.alert_canceled.includes(note)) train.alert_canceled.push(note);
        }
      }
    }
  }

  for (const s of states) for (const rec of Object.values(s.trains)) classifyTrain(rec, now, s.polls, stops);
}
