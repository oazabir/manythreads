// The starter app of a manythreads team: one page, one health check, no dependencies beyond Node itself, so it builds and starts in seconds.
// It is served from a sub-path of the site (`/apps/<team>/<app>/`), so every link on its pages is relative and it sets no cookie.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** The team the app belongs to, shown on the page. Set with the TEAM_NAME environment variable; the deploy README does it. */
export function teamName(env = process.env) {
  const raw = (env.TEAM_NAME ?? '').trim();
  return raw === '' ? 'your team' : raw.slice(0, 80);
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem">
<main>
${body}
</main>
</body>
</html>
`;
}

/** The routes. Returns [status, content type, body]. A new page of the app is one more branch here. */
export function route(method, url, env = process.env) {
  const path = new URL(url, 'http://app.invalid').pathname;
  if (method !== 'GET' && method !== 'HEAD') return [405, 'text/plain; charset=utf-8', 'method not allowed\n'];
  if (path === '/healthz') return [200, 'text/plain; charset=utf-8', 'ok\n'];
  if (path === '/') {
    const team = escapeHtml(teamName(env));
    return [200, 'text/html; charset=utf-8', page('Starter app', `<h1>Starter app</h1>\n<p>This small app was made for ${team} to try a delivery from the first goal to a running page.</p>`)];
  }
  return [404, 'text/plain; charset=utf-8', 'not found\n'];
}

export function makeServer(env = process.env) {
  return createServer((req, res) => {
    const [status, type, body] = route(req.method ?? 'GET', req.url ?? '/', env);
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8080);
  makeServer().listen(port, '0.0.0.0', () => console.log(`starter app listening on ${port}`));
}
