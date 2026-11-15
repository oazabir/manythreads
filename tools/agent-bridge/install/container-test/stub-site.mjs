// A stand-in for the site's install routes, for the container test of install/bridge.sh (P26-14, P26-15). It serves what the real site serves under /install/ (the script with its three
// placeholders filled in, the script's hash, the bundle) and answers the two calls the installer makes (POST /api/bridge/enrol, GET /api/bridge/status), and nothing else.
//
//   node stub-site.mjs <dist folder made by install/build.mjs> <port> <code> <log file>
//
// The enrolment code is accepted once. Every request is written to the log file as one line (method, path, status), never a header or a body, so the log holds no secret.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const [dist, portArg, code, logFile] = process.argv.slice(2);
if (!dist || !portArg || !code || !logFile) {
  console.error('usage: stub-site.mjs <dist> <port> <code> <log file>');
  process.exit(2);
}
const port = Number(portArg);
const site = `http://127.0.0.1:${port}`;
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const script = readFileSync(join(dist, 'bridge.sh'), 'utf8')
  .split('@@SITE@@').join(site)
  .split('@@BUNDLE_SHA256@@').join(manifest.bundleSha256)
  .split('@@BRIDGE_VERSION@@').join(manifest.bridgeVersion);
const scriptSha = createHash('sha256').update(script).digest('hex');
const key = `mtb_${randomBytes(32).toString('hex')}`;
let used = false;
let enrolled = false;
const log = (line) => appendFileSync(logFile, line + '\n');

createServer((req, res) => {
  const url = new URL(req.url ?? '/', site);
  const done = (status, body, type = 'text/plain') => {
    log(`${req.method} ${url.pathname} ${status}`);
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  if (req.method === 'GET' && url.pathname === '/install/bridge.sh') return done(200, script);
  if (req.method === 'GET' && url.pathname === '/install/bridge.sh.sha256') return done(200, `${scriptSha}  bridge.sh\n`);
  if (req.method === 'GET' && url.pathname === `/install/${manifest.bundle}`) return done(200, readFileSync(join(dist, manifest.bundle)), 'application/gzip');
  if (req.method === 'POST' && url.pathname === '/api/bridge/enrol') {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(text);
      } catch {
        // answered below
      }
      if (body.code !== code || used) return done(404, '{"error":"no such code"}', 'application/json');
      used = true;
      enrolled = true;
      // what the site learned from the machine, for the test to check: the agents the bridge reported
      log(`enrol agents=${JSON.stringify(body.agents)} bridgeVersion=${body.bridgeVersion}`);
      return done(200, JSON.stringify({ key }), 'application/json');
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/bridge/status') {
    const ok = enrolled && req.headers.authorization === `Bearer ${key}`;
    return done(ok ? 200 : 401, ok ? '{"status":"connected"}' : '{"error":"no"}', 'application/json');
  }
  // what the publisher asks with a run's token: who is this run (a bot that may publish), and the push document of a project (none: the script answers "no credential")
  if (req.method === 'GET' && url.pathname === '/api/runs/self') return done(200, '{"teamSlug":"acme","botSlug":"dev","runId":"run1","mayPublish":true}', 'application/json');
  if (req.method === 'GET' && url.pathname === '/api/runs/self/push-credential') return done(404, '{"error":"none"}', 'application/json');
  return done(404, 'not here');
}).listen(port, '127.0.0.1', () => console.log(`stub site on ${site}`));
