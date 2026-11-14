import { boot, prompt, kinds, textOf, SPIKE, WORK } from './lib.mjs';
const env = { INITIAL_AGENT_MODE: 'read-only' };
const low = (a, sid) => a.request('session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: 'low' });
let sid;
{
  const { a } = await boot('codex', 'resume-1-new', { extraEnv: env });
  const n = await a.request('session/new', { cwd: WORK, mcpServers: [] });
  sid = n.result.sessionId;
  await low(a, sid);
  const p = await prompt(a, sid, 'Remember this secret word: pineapple-17. Reply with just: ok.');
  console.log('p1', textOf(p.notes), p.ms);
  const l = await a.request('session/list', { cwd: WORK });
  console.log('list', JSON.stringify(l.result ?? l.error).slice(0, 300));
  await a.stop();
}
for (const [label, method, cwd] of [
  ['2-resume', 'session/resume', WORK],
  ['3-load', 'session/load', WORK],
  ['4-othercwd', 'session/resume', `${SPIKE}/other`],
]) {
  const { a } = await boot('codex', `resume-${label}`, { extraEnv: env });
  const t = a.elapsed();
  const r = await a.request(method, { sessionId: sid, cwd, mcpServers: [] });
  console.log(
    label,
    method,
    r.error ? JSON.stringify(r.error) : Object.keys(r.result),
    'ms',
    a.elapsed() - t,
    'replayed',
    a.notifications.length,
    JSON.stringify(kinds(a.notifications)),
  );
  if (label === '2-resume') {
    await low(a, sid);
    const p = await prompt(a, sid, 'What was the secret word? One word.');
    console.log('memory after resume:', textOf(p.notes), p.resp.result?.stopReason, p.ms);
  }
  if (label === '4-othercwd') {
    const r2 = await a.request('session/resume', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: WORK, mcpServers: [] });
    console.log('resume unknown id:', JSON.stringify(r2.error ?? Object.keys(r2.result)));
    const r3 = await a.request('session/load', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: WORK, mcpServers: [] });
    console.log('load unknown id:', JSON.stringify(r3.error ?? Object.keys(r3.result)));
  }
  await a.stop();
}
