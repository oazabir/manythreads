import { readFileSync } from 'node:fs';
import { boot, kinds, SPIKE, WORK } from './lib.mjs';
const sid = readFileSync(`${SPIKE}/hermes-sid`, 'utf8').trim();
const { a } = await boot('hermes', 'resume-load');
let t = a.elapsed();
let r = await a.request('session/load', { sessionId: sid, cwd: WORK, mcpServers: [] });
console.log(
  'load',
  r.error ? JSON.stringify(r.error) : Object.keys(r.result),
  a.elapsed() - t,
  'ms; replayed',
  a.notifications.length,
  JSON.stringify(kinds(a.notifications)),
);
r = await a.request('session/resume', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: WORK, mcpServers: [] });
console.log('resume unknown id:', JSON.stringify(r.error ?? Object.keys(r.result)).slice(0, 300));
r = await a.request('session/load', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: WORK, mcpServers: [] });
console.log('load unknown id:', JSON.stringify(r.error ?? Object.keys(r.result)).slice(0, 300));
r = await a.request('session/resume', { sessionId: sid, cwd: `${SPIKE}/other`, mcpServers: [] });
console.log('resume other cwd:', JSON.stringify(r.error ?? Object.keys(r.result)).slice(0, 200));
await a.stop();
