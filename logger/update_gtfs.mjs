// Download SEPTA's latest GTFS release (if newer than our cache) and rebuild data/gtfs/rail.json.
// Usage: node logger/update_gtfs.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRailCache } from './lib/gtfs.mjs';
import { paths } from './lib/paths.mjs';

const RELEASES = 'https://api.github.com/repos/septadev/GTFS/releases/latest';

export async function latestRelease() {
  const headers = { 'User-Agent': 'regional-fail-logger', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(RELEASES, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GTFS release check failed: HTTP ${res.status}`);
  const rel = await res.json();
  const asset = rel.assets.find(a => a.name === 'gtfs_public.zip');
  if (!asset) throw new Error(`gtfs_public.zip missing from release ${rel.tag_name}`);
  return { tag: rel.tag_name, url: asset.browser_download_url, published: rel.published_at };
}

export function cachedVersion() {
  try { return JSON.parse(fs.readFileSync(paths.gtfsMeta, 'utf8')).version; } catch { return null; }
}

/** Returns { updated, version }. */
export async function updateGtfs({ force = false } = {}) {
  const rel = await latestRelease();
  const have = cachedVersion();
  if (!force && have === rel.tag && fs.existsSync(paths.gtfsCache)) return { updated: false, version: have };
  const res = await fetch(rel.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`GTFS download failed: HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const rail = buildRailCache(zip, rel.tag);
  fs.mkdirSync(path.dirname(paths.gtfsCache), { recursive: true });
  fs.writeFileSync(paths.gtfsCache, JSON.stringify(rail));
  fs.writeFileSync(paths.gtfsMeta, JSON.stringify({ version: rel.tag, published: rel.published, source: rel.url, feed_start: rail.feed_start, feed_end: rail.feed_end, fetched: new Date().toISOString() }, null, 2));
  return { updated: true, version: rel.tag, previous: have };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await updateGtfs({ force: process.argv.includes('--force') });
  console.log(r.updated ? `GTFS updated: ${r.previous ?? 'none'} -> ${r.version}` : `GTFS already current (${r.version})`);
}
