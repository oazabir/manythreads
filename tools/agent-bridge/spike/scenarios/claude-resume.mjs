import { boot, prompt, kinds, textOf, SPIKE, WORK } from './lib.mjs';
const opts = {
  _meta: {
    claudeCode: {
      options: {
        settingSources: [],
        tools: ['Read'],
        allowedTools: ['Read'],
        extraArgs: { restricted: null, 'strict-mcp-config': null },
        allowDangerouslySkipPermissions: false,
      },
    },
  },
};
let sid;
{
  const { a } = await boot('claude', 'resume-1-new');
  const n = await a.request('session/new', { cwd: WORK, mcpServers: [], ...opts });
  sid = n.result.sessionId;
  await a.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'haiku' });
  const p = await prompt(a, sid, 'Remember this secret word: pineapple-17. Reply with just: ok.');
  console.log('p1', textOf(p.notes), p.ms);
  const l = await a.request('session/list', { cwd: WORK });
  console.log('list', JSON.stringify(l.result ?? l.error).slice(0, 400));
  await a.stop();
}
{
  const { a } = await boot('claude', 'resume-2-resume');
  const t = a.elapsed();
  const r = await a.request('session/resume', { sessionId: sid, cwd: WORK, mcpServers: [], ...opts });
  console.log('resume', r.error ?? Object.keys(r.result), 'ms', a.elapsed() - t, 'notes after resume', a.notifications.length, JSON.stringify(kinds(a.notifications)));
  await a.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'haiku' });
  const p = await prompt(a, sid, 'What was the secret word? One word.');
  console.log('memory after resume:', textOf(p.notes), p.resp.result?.stopReason, p.ms);
  await a.stop();
}
{
  const { a } = await boot('claude', 'resume-3-load');
  const t = a.elapsed();
  const r = await a.request('session/load', { sessionId: sid, cwd: WORK, mcpServers: [], ...opts });
  console.log('load', r.error ?? Object.keys(r.result), 'ms', a.elapsed() - t, 'replayed', a.notifications.length, JSON.stringify(kinds(a.notifications)));
  console.log(
    'replay first/last',
    a.notifications.slice(0, 3).map((n) => JSON.stringify(n.params.update).slice(0, 200)),
  );
  await a.stop();
}
{
  const { a } = await boot('claude', 'resume-4-othercwd');
  let r = await a.request('session/resume', { sessionId: sid, cwd: `${SPIKE}/other`, mcpServers: [], ...opts });
  console.log('resume other cwd:', JSON.stringify(r.error ?? Object.keys(r.result)));
  r = await a.request('session/resume', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: WORK, mcpServers: [], ...opts });
  console.log('resume unknown id:', JSON.stringify(r.error ?? Object.keys(r.result)));
  r = await a.request('session/load', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: WORK, mcpServers: [], ...opts });
  console.log('load unknown id:', JSON.stringify(r.error ?? Object.keys(r.result)));
  await a.stop();
}
