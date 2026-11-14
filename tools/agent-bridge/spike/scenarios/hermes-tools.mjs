import { boot, prompt, textOf, WORK } from './lib.mjs';
const label = process.argv[2];
const { a } = await boot('hermes', `tools-${label}`, { extraEnv: {} });
const n = await a.request('session/new', { cwd: WORK, mcpServers: [] });
const p = await prompt(a, n.result.sessionId, '/tools');
console.log(label, 'stop', p.resp.result?.stopReason, p.ms, 'ms; tools:', textOf(p.notes).replace(/\s+/g, ' ').slice(0, 1400));
await a.stop();
