import { execSync } from 'node:child_process';
import { boot, prompt, show, kinds, textOf, state, sleep, WORK } from './lib.mjs';
const setup = async (a, mode, extra = {}) => {
  const n = await a.request('session/new', { cwd: WORK, mcpServers: [] });
  const sid = n.result.sessionId;
  for (const [configId, value] of Object.entries({ reasoning_effort: 'low', mode, ...extra })) {
    const r = await a.request('session/set_config_option', { sessionId: sid, configId, value });
    if (r.error) console.log('set', configId, JSON.stringify(r.error));
  }
  return sid;
};
{
  // plan
  const { a } = await boot('codex', 'plan');
  const sid = await setup(a, 'read-only', { collaboration_mode: 'plan' });
  const p = await prompt(a, sid, 'Make a very short plan (2 steps) to add a README to this folder. Do not do it.');
  show(p.notes);
  console.log('plan prompt:', JSON.stringify(kinds(p.notes)), p.resp.result?.stopReason, p.ms);
  await a.stop();
}
{
  // permission under read-only
  const { a } = await boot('codex', 'permission');
  const sid = await setup(a, 'read-only');
  state.perm = 'allow';
  let p = await prompt(a, sid, 'Run the shell command: touch spike-d.txt . Answer with one word.');
  show(p.notes);
  console.log('allow:', textOf(p.notes), p.resp.result?.stopReason, p.ms, 'requests', state.permLog.length);
  for (const r of state.permLog) console.log('REQ', JSON.stringify(r.params).slice(0, 1200));
  state.perm = 'reject';
  p = await prompt(a, sid, 'Run the shell command: touch spike-e.txt . Answer with one word.');
  show(p.notes);
  console.log('reject:', textOf(p.notes), p.resp.result?.stopReason, p.ms);
  state.perm = 'hang';
  const before = state.permLog.length;
  const pp = prompt(a, sid, 'Run the shell command: touch spike-f.txt . Answer with one word.');
  await sleep(25000);
  console.log('hanging request seen:', state.permLog.length - before, 'prompt pending after 25s:', a.pending.size > 0);
  const tc = a.elapsed();
  a.notify('session/cancel', { sessionId: sid });
  for (const res of state.hang) res({ result: { outcome: { outcome: 'cancelled' } } });
  const r2 = await pp;
  console.log('cancel with pending permission ->', r2.resp.result?.stopReason ?? JSON.stringify(r2.resp.error), a.elapsed() - tc, 'ms');
  state.perm = 'allow';
  p = await prompt(a, sid, 'Say ok.');
  console.log('next prompt:', textOf(p.notes), p.resp.result?.stopReason, 'alive', !a.exited);
  await a.stop();
}
{
  // cancel + two sessions
  state.hang = [];
  state.perm = 'allow';
  const { a } = await boot('codex', 'cancel');
  const s1 = await setup(a, 'agent');
  const s2 = await setup(a, 'agent');
  const p1 = prompt(a, s1, 'Run exactly this shell command: node -e "setTimeout(()=>{},91235)"   Then answer ok.');
  const p2 = prompt(a, s2, 'Say the word two. Nothing else.');
  const r2 = await p2;
  console.log('s2 finished while s1 running:', textOf(r2.notes), r2.ms, 'ms; s1 pending', a.pending.size);
  await a.waitFor((n) => n.params?.sessionId === s1 && n.params?.update?.sessionUpdate === 'tool_call', 30000).catch(() => console.log('no tool_call'));
  await sleep(3000);
  console.log('command running:', execSync("ps -eo pid,args | grep '[9]1235' | grep -v 'claude-perm\\|bash -c' | cut -c1-100 || true").toString().trim() || 'none');
  const tc = a.elapsed();
  a.notify('session/cancel', { sessionId: s1 });
  const r1 = await p1;
  console.log('cancelled: prompt ended', r1.resp.result?.stopReason ?? JSON.stringify(r1.resp.error), 'after', a.elapsed() - tc, 'ms');
  await sleep(1000);
  console.log('command after cancel:', execSync("ps -eo pid,args | grep '[9]1235' | grep -v 'bash -c' | cut -c1-100 || true").toString().trim() || 'gone');
  show(r1.notes);
  const p3 = await prompt(a, s1, 'Say ok.');
  console.log('same session next:', textOf(p3.notes), p3.resp.result?.stopReason, 'alive', !a.exited);
  await a.stop();
}
