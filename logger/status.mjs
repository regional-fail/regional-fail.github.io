// Human-readable view of today's live state, for checking against the SEPTA app.
// Usage: node logger/status.mjs [--all]
import fs from 'node:fs';
import { paths } from './lib/paths.mjs';

const latest = JSON.parse(fs.readFileSync(paths.latest, 'utf8'));
const state = JSON.parse(fs.readFileSync(paths.day(latest.current), 'utf8'));
const t = s => (s ? new Date(s * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) : '--');
const pct = v => (v == null ? '--' : `${Math.round(v * 100)}%`);
const sum = latest.summary;

console.log(`\nRegional Fail - ${latest.current} - updated ${t(latest.updated_at)} - traffic: ${sum.traffic.level} (avg ${sum.traffic.avg_late_now} min late, ${sum.traffic.running} running)`);
console.log(`Polls today: ${state.polls.length} (${state.polls.filter(p => p[1]).length} ok)   Timetable: ${latest.gtfs_version}\n`);

console.log('Line                     Dir       Due  Ran  Ghost  Unknown  On-time  Avg late  Grade');
for (const l of sum.lines) {
  console.log(`${l.name.padEnd(24)} ${l.dir.padEnd(9)} ${String(l.all.due).padStart(4)} ${String(l.all.ran).padStart(4)} ${String(l.all.ghosts).padStart(6)} ${String(l.all.unknown).padStart(8)} ${pct(l.rates.on_time_rate).padStart(8)} ${(l.rates.avg_late == null ? '--' : l.rates.avg_late.toFixed(1)).padStart(9)}  ${l.score?.grade ?? '--'}`);
}

const show = process.argv.includes('--all') ? () => true : r => ['running', 'ghost', 'missing', 'partial'].includes(r.status);
console.log('\nTrain  Status            Sched dep-arr        Late now/max  Line(s)');
for (const r of Object.values(state.trains).filter(show).sort((a, b) => a.dep - b.dep)) {
  const status = r.ghost ? `ghost (${r.ghost})` : r.status;
  const legs = r.legs.map(l => `${l.route} ${l.dir}${l.ghost === 'skipped' ? ' [skipped]' : ''}`).join(' + ');
  console.log(`${r.train.padEnd(6)} ${status.padEnd(17)} ${`${t(r.dep)}-${t(r.arr)}`.padEnd(20)} ${`${r.late_now ?? '-'}/${r.late_max ?? '-'}`.padEnd(13)} ${legs}`);
  for (const a of r.alert_canceled || []) console.log(`         SEPTA: ${a}`);
}
console.log('');
