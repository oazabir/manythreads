import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { boot, mcpServer, prompt, show, kinds, textOf, state, sleep, SPIKE, WORK } from './lib.mjs';
const sid = readFileSync(`${SPIKE}/hermes-sid`, 'utf8').trim();
const alive = () => execSync("ps -eo pid,args | grep '[9]1237' | grep -v 'bash -c' | grep -c 'node -e' || true").toString().trim();
const { a } = await boot('hermes', 'second');
const mcp = await mcpServer();
let t = a.elapsed();
const r = await a.request('session/resume', { sessionId: sid, cwd: WORK, mcpServers: [mcp.server] });
console.log(
  'resume',
  r.error ? JSON.stringify(r.error) : Object.keys(r.result),
  'ms',
  a.elapsed() - t,
  'notes',
  a.notifications.length,
  JSON.stringify(kinds(a.notifications)),
);
t = a.elapsed();
const n2 = await a.request('session/new', { cwd: WORK, mcpServers: [mcp.server] });
const s2 = n2.result.sessionId;
console.log('second session new', a.elapsed() - t, 'ms', s2 !== sid);
state.perm = 'allow';
const t0 = a.elapsed();
const p1 = prompt(
  a,
  sid,
  'Two things, tersely: (a) which file did you read earlier in this conversation? (b) use your delegate_task tool to have a subagent read package.json and report its "name". One short sentence.',
);
const p3 = prompt(a, s2, 'Run this terminal command: node -e "setTimeout(()=>{},91237)"   then answer ok.');
await a
  .waitFor((x) => x.params?.sessionId === s2 && x.params?.update?.sessionUpdate === 'tool_call' && x.params.update.kind === 'execute', 120000)
  .catch(() => console.log('no execute call on s2'));
await sleep(3000);
console.log('s2 command running:', alive(), 'perm requests so far', state.permLog.length, 's1 pending?', a.pending.size);
const tc = a.elapsed();
a.notify('session/cancel', { sessionId: s2 });
const r3 = await p3;
console.log('s2 cancelled: prompt ended', r3.resp.result?.stopReason ?? JSON.stringify(r3.resp.error), 'after', a.elapsed() - tc, 'ms');
for (let i = 0; i < 6; i++) {
  console.log(`+${i}s s2 command running:`, alive());
  if (alive() === '0') break;
  await sleep(1000);
}
show(r3.notes);
const r1 = await p1;
console.log('s1 finished', r1.resp.result?.stopReason ?? JSON.stringify(r1.resp.error), 'at', a.elapsed() - t0, 'ms');
show(r1.notes);
console.log('s1 text:', textOf(r1.notes));
console.log('s1 kinds', JSON.stringify(kinds(r1.notes)));
for (const q of state.permLog) console.log('REQ', JSON.stringify(q.params).slice(0, 1500));
console.log('stderr tail', a.stderr.slice(-600));
console.log('exit', JSON.stringify(await a.stop()));
await mcp.close();
