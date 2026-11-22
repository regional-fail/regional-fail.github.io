// Classify each scheduled train (and each line "leg" of it) from what the logger observed.
import { RULES } from './rules.mjs';
import { km } from './geo.mjs';

/** Number of successful polls with timestamps in [from, to]. */
export function pollsIn(polls, from, to) {
  let n = 0;
  for (const [t, ok] of polls) if (ok && t >= from && t <= to) n++;
  return n;
}

const norm = s => String(s || '').toLowerCase().replace(/\b(station|transit center|st|street)\b/g, '').replace(/[^a-z0-9]/g, '');

/** Did the train's sightings stop short of (or start past) its scheduled ends? */
function partialCheck(rec, stops, polls) {
  const flags = [];
  const origin = stops[rec.legs[0].from], dest = stops[rec.legs.at(-1).to];
  // Only judge an early end if we kept polling while it should still have been running.
  const expectedEnd = rec.arr + Math.max(0, rec.late_now || 0) * 60;
  const watchedEnd = pollsIn(polls, rec.last_seen + 1, expectedEnd) >= RULES.minPollsForVerdict;
  if (watchedEnd && rec.last_pos && dest && km(rec.last_pos, [dest[1], dest[2]]) > RULES.partialKm && norm(rec.next) !== norm(dest[0])) {
    flags.push('ended_early');
  }
  // Only judge a late start if we were polling before departure and never saw it listed at the origin.
  const watchedDeparture = pollsIn(polls, rec.dep - RULES.ghostBeforeDep, rec.dep) > 0;
  if (rec.first_pos && origin && watchedDeparture && rec.listed_first >= rec.first_seen &&
      km(rec.first_pos, [origin[1], origin[2]]) > RULES.partialKm) {
    flags.push('started_late');
  }
  return flags;
}

/**
 * Sets rec.status and each leg's .status / .ghost in place.
 * Train status: upcoming | missing | running | done | partial | ghost | unknown
 */
export function classifyTrain(rec, now, polls, stops) {
  const winEnd = rec.arr + RULES.ghostAfterArr;
  // We can only call a train a ghost if we were watching while it was scheduled to be running.
  const coverage = pollsIn(polls, rec.dep, rec.arr);
  const confirmed = (rec.alert_canceled || []).length > 0;

  if (!rec.first_seen) {
    let status, ghost = null;
    if (rec.removed_from_timetable && now > rec.dep) { status = 'ghost'; ghost = 'pre-canceled'; }
    else if (confirmed && now > rec.dep) { status = 'ghost'; ghost = 'confirmed'; }
    else if (now < rec.dep + RULES.missingAfterDep) status = 'upcoming';
    else if (now <= winEnd) status = 'missing';
    else if (coverage >= RULES.minPollsForVerdict) { status = 'ghost'; ghost = 'inferred'; }
    else status = 'unknown';
    rec.status = status;
    rec.ghost = ghost;
    for (const leg of rec.legs) { leg.status = status; leg.ghost = ghost; }
    return rec;
  }

  // Gone = absent for 15+ min while we were actually polling (a gap in our own data is not "gone").
  const gone = now - rec.last_seen > RULES.doneAfterLastSeen && pollsIn(polls, rec.last_seen + 1, now) >= RULES.minPollsForVerdict;
  const flags = gone ? partialCheck(rec, stops, polls) : [];
  rec.partial = flags.length ? flags : null;
  rec.ghost = null;
  rec.status = !gone ? 'running' : flags.length ? 'partial' : 'done';

  // Per leg: a leg the train never reached (e.g. turned back at Center City) counts as skipped.
  rec.legs.forEach((leg, i) => {
    leg.ghost = null;
    if (leg.polls > 0) {
      const isFirst = i === 0, isLast = i === rec.legs.length - 1;
      const legPartial = (isLast && flags.includes('ended_early')) || (isFirst && flags.includes('started_late'));
      leg.status = !gone ? (i === rec.cur_leg ? 'running' : 'done') : legPartial ? 'partial' : 'done';
      return;
    }
    const legEnd = leg.arr + RULES.ghostAfterArr;
    const longEnough = leg.arr - leg.dep >= RULES.minLegSecondsForSkip;
    if (now < leg.dep + RULES.missingAfterDep || (!gone && now <= legEnd)) leg.status = 'upcoming';
    else if (gone && longEnough && pollsIn(polls, leg.dep, leg.arr) >= RULES.minPollsForVerdict) { leg.status = 'ghost'; leg.ghost = 'skipped'; }
    else if (!gone) leg.status = 'missing';
    else leg.status = 'unknown';
  });
  if (rec.status === 'done' && rec.legs.some(l => l.ghost === 'skipped')) rec.status = 'partial';
  return rec;
}

/** On time (SEPTA's own rule) for a finished leg; null when not applicable. A partial trip is never on time. */
export function legOnTime(leg) {
  if (leg.status === 'partial') return false;
  if (leg.status !== 'done' || leg.late_final == null) return null;
  return leg.late_final <= RULES.onTimeMaxLate;
}
