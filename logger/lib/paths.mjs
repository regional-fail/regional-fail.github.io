// Where things live. OUT_DIR (default ./out) holds live state; in GitHub Actions it is the `live` branch checkout.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(process.env.OUT_DIR || path.join(ROOT, 'out'));
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const TRACES = path.resolve(process.env.TRACES_DIR || path.join(OUT, 'traces'));

export const paths = {
  gtfsCache: path.join(DATA, 'gtfs', 'rail.json'),
  gtfsMeta: path.join(DATA, 'gtfs', 'version.json'),
  live: path.join(OUT, 'live'),
  day: date => path.join(OUT, 'live', 'days', `${date}.json`),
  daysDir: path.join(OUT, 'live', 'days'),
  latest: path.join(OUT, 'live', 'latest.json'),
  archiveDay: date => path.join(DATA, 'archive', ...date.split('-').slice(0, 2), `${date.split('-')[2]}.json.gz`),
  archiveIndex: path.join(DATA, 'archive', 'index.json'),
  traceDay: date => path.join(TRACES, date.slice(0, 4), `${date}.json.gz`),
  raw: path.join(OUT, 'raw'),
};
