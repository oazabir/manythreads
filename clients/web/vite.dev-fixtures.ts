import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { APP_BRIDGE_CLIENT_FILE, APP_BRIDGE_CLIENT_JS, REPO_APP_PATH_RE, embeddedAppHeaders } from '../../packages/shared/src/surfaces/viewer.ts';

/*
 * Dev and preview only: serves the files of e2e/fixtures/files for the /dev/viewers page, and stands in for the app content route
 * (`GET /api/teams/:slug/repo/app/<folder>/<file>`, served by repo-git later) for the team `_dev`, with the same headers the real
 * route sends. It is a Vite plugin, so none of it exists in the built client; the real server answers `/api` in production.
 */

const FIXTURES = resolve(import.meta.dirname, '../../e2e/fixtures/files');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mmd': 'text/vnd.mermaid; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function inside(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const full = normalize(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

function send(res: ServerResponse, file: string, extra: Record<string, string> = {}): void {
  res.statusCode = 200;
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  createReadStream(file).pipe(res);
}

const APP_PREFIX = '/api/teams/_dev/repo/app/';
const APP_FOLDER = 'apps/release-checklist';

function handle(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (url.startsWith('/__dev/files/')) {
    const file = inside(FIXTURES, url.slice('/__dev/files/'.length));
    if (file && existsSync(file) && statSync(file).isFile()) return send(res, file);
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  if (url.startsWith(APP_PREFIX) && REPO_APP_PATH_RE.test(url)) {
    // <folder>/<file>: `apps/release-checklist` is the only app in the fixtures
    const rest = url.slice(APP_PREFIX.length);
    const folder = rest.startsWith(`${APP_FOLDER}/`) ? 'app' : '';
    const name = folder ? rest.slice(APP_FOLDER.length + 1) : '';
    const headers = embeddedAppHeaders();
    if (folder === 'app' && name === APP_BRIDGE_CLIENT_FILE) {
      res.statusCode = 200;
      res.setHeader('content-type', TYPES['.js'] ?? 'text/javascript');
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(APP_BRIDGE_CLIENT_JS);
      return;
    }
    const file = folder === 'app' ? inside(join(FIXTURES, 'app'), name === '' ? 'index.html' : name) : null;
    if (file && existsSync(file) && statSync(file).isFile()) return send(res, file, headers);
    res.statusCode = 404;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end('not found');
    return;
  }
  next();
}

export function devFixtures(): Plugin {
  return {
    name: 'manythreads-dev-fixtures',
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}
