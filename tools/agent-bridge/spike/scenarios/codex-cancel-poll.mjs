import { execSync } from 'node:child_process';
import { boot, prompt, show, textOf, state, sleep, SPIKE, WORK } from './lib.mjs';
const alive = () => execSync("ps -eo pid,etimes,args | grep '[9]1236' | grep -v 'bash -c' | grep -c 'node -e' || true").toString().trim();
{
  const { a } = await boot('codex', 'permission-exec');
  const n = await a.request('session/new', { cwd: WORK, mcpServers: [] });
  const sid = n.result.sessionId;
  for (const [configId, value] of [
    ['reasoning_effort', 'low'],
    ['mode', 'workspace-write'],
  ])
    await a.request('session/set_config_option', { sessionId: sid, configId, value });
  state.perm = 'allow';
  const p = await prompt(a, sid, `Run the shell command: touch ${SPIKE}/outside-codex.txt . Answer with one word.`);
  show(p.notes);
  console.log('text:', textOf(p.notes), p.resp.result?.stopReason, 'requests', state.permLog.length);
  for (const r of state.permLog) console.log('REQ', JSON.stringify(r.params).slice(0, 1200));
  await a.stop();
}
{
  const { a } = await boot('codex', 'cancel-poll');
  const n = await a.request('session/new', { cwd: WORK, mcpServers: [] });
  const sid = n.result.sessionId;
  for (const [configId, value] of [
    ['reasoning_effort', 'low'],
    ['mode', 'agent'],
  ])
    await a.request('session/set_config_option', { sessionId: sid, configId, value });
  const p1 = prompt(a, sid, 'Run exactly this shell command: node -e "setTimeout(()=>{},91236)"   Then answer ok.');
  await a.waitFor((x) => x.params?.update?.sessionUpdate === 'tool_call', 30000);
  await sleep(2000);
  console.log('running before cancel:', alive());
  const tc = a.elapsed();
  a.notify('session/cancel', { sessionId: sid });
  const r = await p1;
  console.log('prompt ended', r.resp.result?.stopReason, a.elapsed() - tc, 'ms');
  for (let i = 0; i < 12; i++) {
    console.log(`+${i}s still running:`, alive());
    if (alive() === '0') break;
    await sleep(1000);
  }
  show(r.notes);
  console.log('exit', JSON.stringify(await a.stop()));
  console.log('after adapter exit:', alive());
}
