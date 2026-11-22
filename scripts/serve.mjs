// Local preview server. Serves the site plus the logger's live output, mirroring production paths.
//   /        -> site/
//   /live/*  -> out/live/*   (production: the `live` branch)
//   /data/*  -> data/*       (production: main branch archive)
//   /lib/*   -> logger/lib/* (shared scoring code)
// Usage: node scripts/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
// /lib/ -> logger/lib: the scoring code is shared with the site (copied into site/lib when deploying).
const MOUNTS = [['/live/', path.join(ROOT, 'out', 'live')], ['/data/', path.join(ROOT, 'data')], ['/lib/', path.join(ROOT, 'logger', 'lib')], ['/', path.join(ROOT, 'site')]];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [prefix, dir] = MOUNTS.find(([p]) => url.startsWith(p));
  let file = path.join(dir, url.slice(prefix.length));
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  });
}).listen(PORT, () => console.log(`Regional Fail preview: http://localhost:${PORT}`));
