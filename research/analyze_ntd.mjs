// Turn the raw NTD pulls into comparison tables (markdown) for SEPTA vs peer commuter railroads.
// Usage: node research/analyze_ntd.mjs [year]   (default: latest year in the data)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'ntd');
const load = n => JSON.parse(fs.readFileSync(path.join(DIR, `${n}.json`), 'utf8')).rows;
const NAMES = {
  '30019': 'SEPTA Regional Rail', '20100': 'LIRR (NY)', '20078': 'Metro-North (NY)', '20080': 'NJ Transit',
  '10003': 'MBTA (Boston)', '50118': 'Metra (Chicago)', '90134': 'Caltrain (SF Bay)', '30034': 'MARC (Maryland)',
};
const num = v => (v === undefined || v === null || v === '' ? 0 : Number(v));
const years = [...new Set(load('metrics').map(r => r.report_year))].sort();
const YEAR = process.argv[2] || years.at(-1);

// Sum a dataset's numeric fields per agency (+ year), across DO/PT type-of-service rows.
function sumBy(rows, fields, filter = () => true) {
  const out = {};
  for (const r of rows.filter(filter)) {
    const k = `${r.ntd_id}|${r.report_year}`;
    out[k] ??= Object.fromEntries(fields.map(f => [f, 0]));
    for (const f of fields) out[k][f] += num(r[f]);
  }
  return out;
}

const cr = sumBy(load('metrics'), ['unlinked_passenger_trips', 'total_operating_expenses', 'fare_revenues_earned', 'passenger_miles', 'vehicle_revenue_miles', 'vehicle_revenue_hours']);
const br = sumBy(load('breakdowns'), ['major_mechanical_failures', 'other_mechanical_failures', 'total_mechanical_failures', 'vehicle_passenger_car_revenue', 'train_revenue_miles']);
const ox = sumBy(load('opex_by_function'), ['vehicle_operations', 'vehicle_maintenance', 'facility_maintenance', 'general_administration', 'total']);
const allModes = sumBy(load('metrics_all_modes'), ['unlinked_passenger_trips', 'total_operating_expenses']);
const fundOps = sumBy(load('funding_by_expense_type'), ['fares_and_other_directly', 'taxes_fees_levied_by_transit', 'local', 'state_1', 'federal', 'total'], r => /Operations/.test(r.fund_expenditure_type));
const fundCap = sumBy(load('funding_by_expense_type'), ['local', 'state_1', 'federal', 'total'], r => /Capital/.test(r.fund_expenditure_type));

// Commuter-rail fleet age, weighted by vehicle count.
const CR_TYPES = /^Commuter Rail/;
const fleet = {};
for (const r of load('vehicle_age').filter(r => CR_TYPES.test(r.vehicle_type) && r.average_age_of_fleet_in_years)) {
  const k = `${r.ntd_id}|${r.report_year}`;
  fleet[k] ??= { n: 0, ageXn: 0, old30: 0 };
  const n = num(r.total_vehicles);
  fleet[k].n += n; fleet[k].ageXn += n * num(r.average_age_of_fleet_in_years);
  fleet[k].old30 += num(r._31_60) + num(r._60);
}

const $ = v => (v ? `$${v.toFixed(2)}` : '—');
const pct = v => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const int = v => (Number.isFinite(v) && v ? Math.round(v).toLocaleString('en-US') : '—');
const ids = Object.keys(NAMES);
const k = id => `${id}|${YEAR}`;

function table(title, cols, rowFn, sortCol) {
  const rows = ids.map(id => ({ name: NAMES[id], ...rowFn(id) })).filter(r => r.ok !== false);
  if (sortCol) rows.sort((a, b) => (a[sortCol].sortVal ?? 0) - (b[sortCol].sortVal ?? 0));
  const cell = v => (typeof v === 'object' ? v.text : v);
  let s = `\n### ${title}\n\n| Railroad | ${cols.map(c => c[1]).join(' | ')} |\n|---|${cols.map(() => '---:').join('|')}|\n`;
  for (const r of rows) s += `| ${r.id === '30019' || r.name.startsWith('SEPTA') ? `**${r.name}**` : r.name} | ${cols.map(c => cell(r[c[0]])).join(' | ')} |\n`;
  return s;
}

let md = `## NTD comparison, report year ${YEAR} (commuter rail mode unless noted)\n`;

md += table('Reliability: major mechanical failures', [
  ['fails', 'Major failures'], ['carmi', 'Revenue car-miles'], ['mdbf', 'Car-miles between major failures'], ['trainmi', 'Train-miles between major failures'],
], id => {
  const b = br[k(id)]; if (!b) return { ok: false };
  const m = b.vehicle_passenger_car_revenue / b.major_mechanical_failures;
  return { fails: int(b.major_mechanical_failures), carmi: int(b.vehicle_passenger_car_revenue), mdbf: { text: int(m), sortVal: m }, trainmi: int(b.train_revenue_miles / b.major_mechanical_failures) };
}, 'mdbf');

md += table('Fleet age (commuter rail vehicles)', [['n', 'Vehicles'], ['age', 'Avg age (yrs)'], ['old', 'Share 31+ yrs old']], id => {
  const f = fleet[k(id)]; if (!f) return { ok: false };
  const a = f.ageXn / f.n;
  return { n: int(f.n), age: { text: a.toFixed(1), sortVal: -a }, old: pct(f.old30 / f.n) };
}, 'age');

md += table('Cost efficiency (commuter rail)', [['cpt', 'Operating cost per trip'], ['cpm', 'Cost per passenger-mile'], ['fb', 'Farebox recovery'], ['cvh', 'Cost per vehicle revenue hour'], ['adm', 'General admin share of opex']], id => {
  const c = cr[k(id)], o = ox[k(id)]; if (!c) return { ok: false };
  const cpt = c.total_operating_expenses / c.unlinked_passenger_trips;
  return { cpt: { text: $(cpt), sortVal: -cpt }, cpm: $(c.total_operating_expenses / c.passenger_miles), fb: pct(c.fare_revenues_earned / c.total_operating_expenses), cvh: $(c.total_operating_expenses / c.vehicle_revenue_hours), adm: o ? pct(o.general_administration / o.total) : '—' };
}, 'cpt');

md += table('Operating funding by source, whole agency (all modes), per agency-wide trip', [['trips', 'Agency trips'], ['state', 'State $/trip'], ['local', 'Local $/trip'], ['fed', 'Federal $/trip'], ['own', 'Fares & own revenue $/trip'], ['taxes', 'Dedicated agency taxes $/trip']], id => {
  const f = fundOps[k(id)], a = allModes[k(id)]; if (!f || !a) return { ok: false };
  const t = a.unlinked_passenger_trips;
  return { trips: int(t), state: { text: $(f.state_1 / t), sortVal: f.state_1 / t }, local: $(f.local / t), fed: $(f.federal / t), own: $(f.fares_and_other_directly / t), taxes: $(f.taxes_fees_levied_by_transit / t) };
}, 'state');

md += table('Capital funding, whole agency, per agency-wide trip', [['cap', 'Capital $ total'], ['captrip', 'Capital $/trip'], ['capstate', 'State capital $/trip']], id => {
  const f = fundCap[k(id)], a = allModes[k(id)]; if (!f || !a) return { ok: false };
  const t = a.unlinked_passenger_trips;
  return { cap: int(f.total), captrip: { text: $(f.total / t), sortVal: f.total / t }, capstate: $(f.state_1 / t) };
}, 'captrip');

// SEPTA trend across years.
md += `\n### SEPTA Regional Rail trend\n\n| Year | Trips | Major failures | Car-miles between major failures | Cost/trip | Farebox | Fleet avg age |\n|---|---:|---:|---:|---:|---:|---:|\n`;
for (const y of years) {
  const kk = `30019|${y}`, c = cr[kk], b = br[kk], f = fleet[kk];
  md += `| ${y} | ${int(c?.unlinked_passenger_trips)} | ${int(b?.major_mechanical_failures)} | ${b ? int(b.vehicle_passenger_car_revenue / b.major_mechanical_failures) : '—'} | ${c ? $(c.total_operating_expenses / c.unlinked_passenger_trips) : '—'} | ${c ? pct(c.fare_revenues_earned / c.total_operating_expenses) : '—'} | ${f ? (f.ageXn / f.n).toFixed(1) : '—'} |\n`;
}

console.log(md);
