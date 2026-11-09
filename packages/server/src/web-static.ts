import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { notFoundHandler } from './errors.ts';

/**
 * The web client, served by the server itself (`MANYTHREADS_WEB_DIR`, off unless set).
 *
 * The Helm chart serves the built web client from its own nginx pod (deploy/docker/nginx.conf). A Docker Compose install has five containers and
 * none of them is a web server, so the manythreads container serves the same files the same way: the app's page for every address that is not a
 * file, with the same security headers, long caching for `/assets/` and `/models/`, no caching for the page and the service worker. The routes
 * of the API, the MCP address, the incoming webhooks and the sockets are matched before this one, and an unknown address under them stays a plain
 * JSON 404 (never the app's page).
 *
 * Not done here, on purpose: compression (a reverse proxy in front of the install does it), range requests, and the screenshot gallery of the
 * project's own site.
 */

/** Read from the environment: the directory of the built client, or null. */
export function webDirFromEnv(env: NodeJS.ProcessEnv): string | null {
  const dir = (env['MANYTHREADS_WEB_DIR'] ?? '').trim();
  return dir === '' ? null : resolve(dir);
}

/** The app page's policy: the same text as the `location /` block of deploy/docker/nginx.conf (a test keeps them equal). */
export const APP_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
/** The diagram frame's policy (`location = /mermaid-sandbox.html` of nginx.conf). */
export const MERMAID_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const PERMISSIONS_POLICY = 'microphone=(self), camera=(self)';

/** First path segments that belong to the server, not to the app: an address under them that nothing matched is a JSON 404. */
const SERVER_PREFIXES = new Set(['api', 'mcp', 'hooks', 'ws', 'healthz', 'readyz', 'metrics']);

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const typeOf = (file: string): string => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';

/** The path under the web directory for a request path, or null when it would leave the directory or is not a plain path. */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const full = resolve(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

async function fileAt(path: string): Promise<{ size: number } | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? { size: s.size } : null;
  } catch {
    return null;
  }
}

/** Mount the static client at the end of the route table. Call before `listen`. */
export async function registerWebStatic(app: FastifyInstance, root: string): Promise<void> {
  const index = join(root, 'index.html');
  if ((await fileAt(index)) === null) throw new Error(`MANYTHREADS_WEB_DIR=${root} has no index.html: that is not a built web client.`);

  const send = async (reply: FastifyReply, file: string, size: number, headers: Record<string, string>): Promise<FastifyReply> => {
    void reply.header('content-type', typeOf(file)).header('content-length', String(size)).header('x-content-type-options', 'nosniff');
    for (const [k, v] of Object.entries(headers)) void reply.header(k, v);
    return reply.status(200).send(createReadStream(file));
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const rest = String((req.params as { '*'?: string })['*'] ?? '');
    const first = rest.split('/')[0] ?? '';
    if (SERVER_PREFIXES.has(first)) return notFoundHandler(req, reply);
    const target = safeJoin(root, rest);
    if (target === null) return notFoundHandler(req, reply);

    const immutable = first === 'assets' || first === 'models';
    const found = await fileAt(target);
    if (found !== null && target !== index) {
      if (immutable) return send(reply, target, found.size, { 'cache-control': 'public, max-age=31536000, immutable' });
      if (rest === 'sw.js') return send(reply, target, found.size, { 'cache-control': 'no-cache' });
      if (rest === 'mermaid-sandbox.html') return send(reply, target, found.size, { 'cache-control': 'no-cache', 'content-security-policy': MERMAID_CSP });
      return send(reply, target, found.size, { 'cache-control': 'no-cache', 'content-security-policy': APP_CSP, 'permissions-policy': PERMISSIONS_POLICY });
    }
    // A missing file under these is a plain 404, never the app's page (a missing model must not look like a model).
    if (immutable || rest === 'sw.js') return notFoundHandler(req, reply);
    const page = (await fileAt(index)) as { size: number };
    return send(reply, index, page.size, { 'cache-control': 'no-cache', 'content-security-policy': APP_CSP, 'permissions-policy': PERMISSIONS_POLICY });
  };

  app.get('/*', { config: { public: true } }, handler);
}
