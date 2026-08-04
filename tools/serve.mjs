#!/usr/bin/env node
// Zero-dependency static file server for local dev — serves the repo root so
// index.html can load /src/main.js as a module and fetch /packs/**/*.json.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 4780;

// index.html loads /arcade-sdk.js root-relative, which in production is the
// launcher's copy on the shared origin. Serve it from the sibling checkout so
// `npm run serve` still boots a standalone table.
//
// This is a convenience for solo UI work, NOT a launcher. A FRAMED test needs
// the real thing — `cd ../paulgibeault.github.io && ./dev.sh ../cardstock`
// (GAME_INTEGRATION §12) — which stages both under one origin and handles the
// opaque-origin CORS this server only approximates.
const LAUNCHER_ROOT = path.resolve(ROOT, '..', 'paulgibeault.github.io');
const LAUNCHER_FILES = new Set(['/arcade-sdk.js', '/arcade-audio.js', '/arcade-rng.js']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let filePath;
    if (LAUNCHER_FILES.has(url.pathname)) {
      filePath = path.join(LAUNCHER_ROOT, url.pathname.slice(1));
    } else {
      filePath = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }
    const st = await stat(filePath).catch(() => null);
    if (st?.isDirectory()) filePath = path.join(filePath, 'index.html');
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
});
