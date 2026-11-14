import { execSync } from 'node:child_process';
import { boot, prompt, show, textOf, state, sleep, WORK } from './lib.mjs';
const opts = (extra = {}) => ({
  _meta: {
    claudeCode: {
      options: {
        settingSources: [],
        tools: ['Bash', 'Read'],
        allowedTools: ['Read'],
        extraArgs: { restricted: null, 'strict-mcp-config': null },
        allowDangerouslySkipPermissions: false,
        ...extra,
      },
    },
  },
});
// ---- permission
{
  const { a } = await boot('claude', 'permission');
  const n = await a.request('session/new', { cwd: WORK, mcpServers: [], ...opts() });
  const sid = n.result.sessionId;
  console.log('mode', n.result.modes.currentModeId);
  await a.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'haiku' });
  const r = await a.request('session/set_mode', { sessionId: sid, modeId: 'default' });
  console.log('set_mode', JSON.stringify(r.result ?? r.error));
  state.perm = 'allow';
  let p = await prompt(a, sid, 'Run the shell command: touch spike-a.txt   (use the Bash tool). Answer with one word.');
  show(p.notes);
  console.log('allow text:', textOf(p.notes), p.resp.result?.stopReason, p.ms);
  console.log(
    'PERM REQUESTS',
    JSON.stringify(
      state.permLog.map((x) => x.params),
      null,
      0,
    ).slice(0, 2500),
  );
  state.perm = 'reject';
  p = await prompt(a, sid, 'Run the shell command: touch spike-b.txt   (use the Bash tool). Answer with one word.');
  show(p.notes);
  console.log('reject text:', textOf(p.notes), p.resp.result?.stopReason, p.ms);
  // unanswered, then cancel
  state.perm = 'hang';
  const before = state.permLog.length;
  const pp = prompt(a, sid, 'Run the shell command: touch spike-c.txt   (use the Bash tool). Answer with one word.');
  await sleep(25000);
  console.log('hanging request seen:', state.permLog.length - before, 'prompt still pending after 25s:', a.pending.size > 0);
  const tc = a.elapsed();
  a.notify('session/cancel', { sessionId: sid });
  for (const res of state.hang) res({ result: { outcome: { outcome: 'cancelled' } } });
  const r2 = await pp;
  console.log('cancel with pending permission -> prompt ended', r2.resp.result?.stopReason ?? JSON.stringify(r2.resp.error), 'after', a.elapsed() - tc, 'ms');
  state.perm = 'allow';
  p = await prompt(a, sid, 'Say ok.');
  console.log('after cancel next prompt:', textOf(p.notes), p.resp.result?.stopReason, 'process alive', !a.exited);
  await a.stop();
}
// ---- cancel during a running command, and two sessions at once
{
  state.hang = [];
  state.perm = 'allow';
  const { a } = await boot('claude', 'cancel');
  const mk = async () => {
    const n = await a.request('session/new', { cwd: WORK, mcpServers: [], ...opts({ allowedTools: ['Read', 'Bash'] }) });
    await a.request('session/set_config_option', { sessionId: n.result.sessionId, configId: 'model', value: 'haiku' });
    return n.result.sessionId;
  };
  const s1 = await mk();
  const s2 = await mk();
  console.log('two sessions', s1 !== s2);
  const p1 = prompt(a, s1, 'Run exactly this shell command with the Bash tool: node -e "setTimeout(()=>{},91234)"   Then answer ok.');
  const p2 = prompt(a, s2, 'Say the word two. Nothing else.');
  const r2 = await p2;
  console.log('s2 finished while s1 running:', textOf(r2.notes), r2.ms, 'ms; s1 pending', a.pending.size);
  await a
    .waitFor((n) => n.params?.sessionId === s1 && n.params?.update?.sessionUpdate === 'tool_call' && n.params.update.kind === 'execute', 30000)
    .catch(() => console.log('no execute tool_call'));
  await sleep(3000);
  console.log('sleep running:', execSync("ps -eo pid,args | grep '[9]1234' | cut -c1-120 || true").toString().trim() || 'none');
  const tc = a.elapsed();
  a.notify('session/cancel', { sessionId: s1 });
  const r1 = await p1;
  console.log('cancelled: prompt ended', r1.resp.result?.stopReason ?? JSON.stringify(r1.resp.error), 'after', a.elapsed() - tc, 'ms');
  await sleep(500);
  console.log('sleep after cancel:', execSync("ps -eo pid,args | grep '[9]1234' | cut -c1-120 || true").toString().trim() || 'gone');
  show(r1.notes);
  const p3 = await prompt(a, s1, 'Say ok.');
  console.log('same session next prompt:', textOf(p3.notes), p3.resp.result?.stopReason, 'alive', !a.exited);
  console.log('exit', JSON.stringify(await a.stop()));
}
