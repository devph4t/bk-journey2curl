#!/usr/bin/env node
// Serve the generated pages (BKJ2C_OUT, default "out") on http://localhost:BKJ2C_PORT (default 5174).
// Reads .env like the CLI does; values already in the environment win. Only listens on 127.0.0.1.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

const envFile = process.env.BKJ2C_ENV_FILE ?? '.env';
if (existsSync(envFile)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const root = resolve(process.env.BKJ2C_OUT?.trim() || 'out');
const port = Number(process.env.BKJ2C_PORT?.trim() || 5174);
if (!existsSync(join(root, 'index.html'))) {
  console.error(`No ${join(root, 'index.html')} yet. Run "npm run gen" first.`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  let file = resolve(root, `.${path}`);
  // Never serve anything outside the output folder.
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Not found: ${path}`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root}`);
  console.log(`Open http://localhost:${port}/  (Ctrl+C to stop)`);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use: set BKJ2C_PORT in .env` : e.message);
  process.exit(1);
});
