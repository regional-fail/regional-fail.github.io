// Pull National Transit Database (NTD) numbers for SEPTA and peer commuter railroads.
// Source: US DOT open data portal (data.transportation.gov), FTA NTD annual datasets.
// Usage: node research/fetch_ntd.mjs   -> writes research/data/ntd/*.json
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'data', 'ntd');
fs.mkdirSync(OUT, { recursive: true });

export const PEERS = {
  '30019': 'SEPTA Regional Rail',
  '20100': 'LIRR (NY)',
  '20078': 'Metro-North (NY)',
  '20080': 'NJ Transit Rail',
  '10003': 'MBTA Commuter Rail (Boston)',
  '50118': 'Metra (Chicago)',
  '90134': 'Caltrain (SF Bay)',
  '30034': 'MARC (Maryland)',
};
const ids = Object.keys(PEERS).map(i => `'${i}'`).join(',');

const DATASETS = {
  metrics: { id: 'ekg5-frzt', where: `mode='CR' AND ntd_id in(${ids})` },
  metrics_all_modes: { id: 'ekg5-frzt', where: `ntd_id in(${ids})` },
  funding_by_expense_type: { id: '4tmr-gwuu', where: `ntd_id in(${ids})` },
  breakdowns: { id: 'amkt-4ehs', where: `mode='CR' AND ntd_id in(${ids})` },
  opex_by_function: { id: 'dkxx-zjd6', where: `mode='CR' AND ntd_id in(${ids})` },
  vehicle_age: { id: '6abt-uhgq', where: `ntd_id in(${ids})` },
  funding_state: { id: 'dd43-h6wv', where: `ntd_id in(${ids})` },
  funding_local: { id: '8tvb-ywj3', where: `ntd_id in(${ids})` },
  funding_federal: { id: 'qpjk-b3zw', where: `ntd_id in(${ids})` },
  funding_directly_generated: { id: 'yuaq-zdvc', where: `ntd_id in(${ids})` },
};

for (const [name, { id, where }] of Object.entries(DATASETS)) {
  const url = new URL(`https://data.transportation.gov/resource/${id}.json`);
  url.searchParams.set('$where', where);
  url.searchParams.set('$limit', '5000');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const rows = await res.json();
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ source: `https://data.transportation.gov/d/${id}`, fetched: new Date().toISOString(), rows }, null, 1));
  console.log(`${name}: ${rows.length} rows`);
}
