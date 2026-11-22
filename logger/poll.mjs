// One poll: fetch SEPTA's live feeds and update the open day states. Run every 5 minutes.
// Usage: node logger/poll.mjs        (SAVE_RAW=1 also saves the raw feeds for tests/debugging)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths } from './lib/paths.mjs';
import { etParts, addDays, nowSec } from './lib/time.mjs';
import { scheduleForDate } from './lib/gtfs.mjs';
import { fetchAll } from './lib/septa.mjs';
import { createDayState, reconcileSchedule, applyPoll } from './lib/state.mjs';
import { summarizeDay } from './lib/summary.mjs';
import { RULES } from './lib/rules.mjs';
import { updateGtfs } from './update_gtfs.mjs';
import { archiveFinishedDays } from './archive.mjs';

const GTFS_CHECK_EVERY = 3600;

const readJson = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

/** The service date trains running "now" mostly belong to: before 4am it is still yesterday's. */
export function currentServiceDate(nowS) {
  const p = etParts(nowS * 1000);
  return p.hour < 4 ? addDays(p.date, -1) : p.date;
}

function feedCovers(rail, date) {
  const ymd = date.replaceAll('-', '');
  return (!rail.feed_start || rail.feed_start <= ymd) && (!rail.feed_end || ymd <= rail.feed_end);
}

export async function runPoll({ now = nowSec(), feeds = null, log = console.log } = {}) {
  // 1. Timetable: refresh from SEPTA's GitHub at most hourly.
  const metaPath = path.join(paths.live, 'meta.json');
  const meta = readJson(metaPath, {});
  if (!fs.existsSync(paths.gtfsCache) || !meta.gtfs_checked || now - meta.gtfs_checked > GTFS_CHECK_EVERY) {
    try {
      const r = await updateGtfs();
      if (r.updated) log(`timetable updated -> ${r.version}`);
      meta.gtfs_checked = now;
    } catch (e) {
      log(`timetable check failed: ${e.message}`);
      if (!fs.existsSync(paths.gtfsCache)) throw e;
    }
  }
  const rail = readJson(paths.gtfsCache);

  // 2. Open days: yesterday (if not archived yet), today, tomorrow (baseline captured a day ahead).
  const current = currentServiceDate(now);
  const states = [];
  for (const date of [addDays(current, -1), current, addDays(current, 1)]) {
    let s = readJson(paths.day(date));
    if (!s && date !== addDays(current, -1) && feedCovers(rail, date)) {
      s = createDayState(scheduleForDate(rail, date), now);
      log(`opened ${date}: ${Object.keys(s.trains).length} scheduled trains (timetable ${rail.version})`);
    }
    if (!s) continue;
    if (feedCovers(rail, date)) {
      const diff = reconcileSchedule(s, scheduleForDate(rail, date), now);
      if (diff.removed.length || diff.added.length) log(`${date}: timetable change, removed ${diff.removed.length}, added ${diff.added.length}`);
    }
    states.push(s);
  }
  const currentState = states.find(s => s.date === current);
  if (!currentState) throw new Error(`no timetable covers ${current}`);

  // 3. Fetch and apply.
  feeds ??= await fetchAll();
  if (process.env.SAVE_RAW) writeJson(path.join(paths.raw, `${now}.json`), feeds);
  applyPoll(states, currentState, feeds, now, rail.stops);

  // 4. Save.
  for (const s of states) writeJson(paths.day(s.date), s);
  const summary = summarizeDay(currentState, now, rail.routes);
  writeJson(paths.latest, {
    updated_at: now,
    current,
    open_days: states.map(s => s.date),
    gtfs_version: rail.version,
    feeds_ok: Object.fromEntries(Object.entries(feeds).map(([k, v]) => [k, v.ok])),
    rules: RULES,
    summary,
  });
  writeJson(metaPath, meta);
  archiveFinishedDays({ now, log });

  const tv = feeds.trainView;
  const sys = summary.system;
  log(`${new Date(now * 1000).toISOString()} ${current}: feed ${tv.ok ? `${tv.data.length} trains` : `FAILED (${tv.error})`} | ` +
      `due ${sys.all.due}, ran ${sys.all.ran}, ghosts ${sys.all.ghosts}, missing ${sys.all.missing}, unknown ${sys.all.unknown} | ` +
      `on-time ${sys.rates.on_time_rate == null ? '-' : (sys.rates.on_time_rate * 100).toFixed(0) + '%'} | traffic ${summary.traffic.level}`);
  return { states, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // POLL_NOW (epoch seconds) is for dry runs only, e.g. simulating the next morning to test archiving.
  await runPoll(process.env.POLL_NOW ? { now: Number(process.env.POLL_NOW) } : {});
}
