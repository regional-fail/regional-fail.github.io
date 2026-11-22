// Aggregate a day state into per-line, per-direction numbers and a 0-100 score.
// Pure ESM with no Node imports: the website imports this same file, so both always score identically.
import { legOnTime } from './classify.mjs';

export const SCORE = {
  delivered: 0.5, onTime: 0.3, lateness: 0.2, latenessCapMin: 15, rushWeight: 2,
  // A line is ranked only with enough observed trips (ran + ghost) in the period.
  minObservedToRank: { today: 20, '7d': 50, '30d': 100 },
};

export function emptyAgg() {
  return { due: 0, ran: 0, finished: 0, on_time: 0, late_sum: 0, late_max: 0, ghosts: 0, ghost_kinds: {}, partial: 0, unknown: 0, missing: 0,
    // weighted (rush-hour legs count double) inputs for the score
    w_ran: 0, w_ghost: 0, w_finished: 0, w_on_time: 0, w_late_sum: 0 };
}

export function addLeg(agg, leg, now) {
  if (leg.status === 'upcoming' || leg.dep > now) return;
  const w = leg.rush ? SCORE.rushWeight : 1;
  agg.due++;
  switch (leg.status) {
    case 'ghost':
      agg.ghosts++; agg.w_ghost += w;
      agg.ghost_kinds[leg.ghost] = (agg.ghost_kinds[leg.ghost] || 0) + 1;
      return;
    case 'unknown': agg.unknown++; return;
    case 'missing': agg.missing++; return;
  }
  // running, done, partial: it ran
  agg.ran++; agg.w_ran += w;
  if (leg.status === 'partial') agg.partial++;
  const ot = legOnTime(leg);
  if (ot === null) return;   // still running
  agg.finished++; agg.w_finished += w;
  if (ot) { agg.on_time++; agg.w_on_time += w; }
  const late = Math.max(0, leg.late_final ?? 0);
  agg.late_sum += late; agg.w_late_sum += w * late;
  agg.late_max = Math.max(agg.late_max, leg.late_max ?? late);
}

export function mergeAgg(a, b) {
  const out = { ...a, ghost_kinds: { ...a.ghost_kinds } };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'ghost_kinds') for (const [g, n] of Object.entries(v)) out.ghost_kinds[g] = (out.ghost_kinds[g] || 0) + n;
    else if (k === 'late_max') out.late_max = Math.max(out.late_max, v);
    else out[k] += v;
  }
  return out;
}

/** Score 0-100 and letter grade from an aggregate; null if nothing has finished yet. */
export function score(agg) {
  const delivered = agg.w_ran + agg.w_ghost ? agg.w_ran / (agg.w_ran + agg.w_ghost) : null;
  const onTime = agg.w_finished ? agg.w_on_time / agg.w_finished : null;
  const avgLate = agg.w_finished ? agg.w_late_sum / agg.w_finished : null;
  if (delivered === null || onTime === null) return null;
  const s = 100 * (SCORE.delivered * delivered + SCORE.onTime * onTime + SCORE.lateness * (1 - Math.min(avgLate, SCORE.latenessCapMin) / SCORE.latenessCapMin));
  const grade = s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F';
  return { score: Math.round(s * 10) / 10, grade, delivered, on_time: onTime, avg_late: avgLate };
}

export function rates(agg) {
  return {
    on_time_rate: agg.finished ? agg.on_time / agg.finished : null,
    avg_late: agg.finished ? agg.late_sum / agg.finished : null,
    delivered_rate: agg.ran + agg.ghosts ? agg.ran / (agg.ran + agg.ghosts) : null,
  };
}

/** "Traffic conditions" banner from what is running right now. */
export function trafficLevel(running, recentGhosts) {
  const avg = running.length ? running.reduce((a, r) => a + Math.max(0, r.late_now || 0), 0) / running.length : 0;
  let level = avg <= 3 ? 'Light' : avg <= 7 ? 'Moderate' : avg <= 12 ? 'Heavy' : 'Gridlock';
  if (recentGhosts >= 3 && level === 'Light') level = 'Moderate';
  return { level, avg_late_now: Math.round(avg * 10) / 10, running: running.length, recent_ghosts: recentGhosts };
}

export function summarizeDay(state, now, routes) {
  const lines = {};
  let all = emptyAgg(), rush = emptyAgg();
  for (const rec of Object.values(state.trains)) {
    for (const leg of rec.legs) {
      const key = `${leg.route}|${leg.dir}`;
      lines[key] ||= { route: leg.route, name: routes?.[leg.route]?.name || leg.route, dir: leg.dir, all: emptyAgg(), rush: emptyAgg() };
      addLeg(lines[key].all, leg, now);
      if (leg.rush) addLeg(lines[key].rush, leg, now);
    }
  }
  for (const l of Object.values(lines)) { all = mergeAgg(all, l.all); rush = mergeAgg(rush, l.rush); }
  const running = Object.values(state.trains).filter(r => r.status === 'running');
  const recentGhosts = Object.values(state.trains).filter(r => r.status === 'ghost' && r.dep > now - 2 * 3600 && r.dep <= now).length;
  const out = l => ({ ...l, rates: rates(l.all), score: score(l.all), rush_rates: rates(l.rush) });
  return {
    date: state.date,
    at: now,
    traffic: trafficLevel(running, recentGhosts),
    system: { all, rush, rates: rates(all), score: score(all), rush_rates: rates(rush) },
    lines: Object.values(lines).sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir)).map(out),
    extras: Object.keys(state.extras || {}).length,
  };
}
