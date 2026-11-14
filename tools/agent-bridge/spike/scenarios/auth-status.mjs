import { boot, sleep, WORK } from './lib.mjs';
const agent = process.argv[2];
const { a } = await boot(agent, 'auth-status');
await a.request('session/new', { cwd: WORK, mcpServers: [] });
await sleep(2500);
for (const n of a.notifications)
  if (n.method !== 'session/update')
    console.log('notification', n.method, JSON.stringify(n.params, (k, v) => (['email', 'organization', 'description'].includes(k) ? '<x>' : v)).slice(0, 500));
const r = await a.request('auth/status', {}).catch((e) => ({ error: String(e) }));
console.log('auth/status', JSON.stringify(r.result ?? r.error, (k, v) => (['email', 'organization', 'description', 'label'].includes(k) ? '<x>' : v)).slice(0, 600));
await a.stop();
