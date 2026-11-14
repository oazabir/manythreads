import { createServer } from 'node:http';
import { boot, SPIKE, WORK } from './lib.mjs';
const agent = process.argv[2];
const hits = [];
const srv = createServer((req, res) => {
  hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ? 'yes' : 'no'} xkey=${req.headers['x-test-key'] ? 'yes' : 'no'}`);
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const env = agent === 'claude' ? { CLAUDE_CONFIG_DIR: `${SPIKE}/claude-cfg-empty` } : { CODEX_HOME: `${SPIKE}/codex-home-empty` };
const { a } = await boot(agent, 'signin-gateway', { extraEnv: env });
const r = await a.request('authenticate', { methodId: 'gateway', _meta: { gateway: { baseUrl: base, headers: { 'X-Test-Key': 'not-a-real-key' } } } });
console.log('authenticate gateway ->', JSON.stringify(r.result ?? r.error));
const n = await a.request('session/new', { cwd: WORK, mcpServers: [] });
console.log('session/new ->', n.error ? JSON.stringify(n.error) : 'ok', a.elapsed(), 'ms');
for (const x of a.notifications) if (x.method !== 'session/update') console.log('notification', x.method, JSON.stringify(x.params).slice(0, 300));
await new Promise((r) => setTimeout(r, 1500));
console.log('gateway hits:', hits.slice(0, 5));
console.log(
  'stderr gateway lines:',
  a.stderr
    .split('\n')
    .filter((l) => /gateway|baseUrl/i.test(l))
    .slice(0, 4)
    .join(' | ')
    .slice(0, 500),
);
const lo = await a.request('logout', {});
console.log('logout (in-memory gateway) ->', JSON.stringify(lo.result ?? lo.error));
await a.stop();
srv.close();
