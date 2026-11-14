import { execSync } from 'node:child_process';
import { boot, mcpServer, prompt, show, kinds, textOf, state, SPIKE, WORK } from './lib.mjs';
const { a, tInit } = await boot('claude', 'work', { extraEnv: { CLAUDE_AGENT_LOGS: `${SPIKE}/claude-logs` } });
console.log('init at', tInit, 'ms');
const mcp = await mcpServer();
const options = {
  settingSources: [],
  tools: ['Read', 'Glob', 'Grep', 'TaskCreate', 'TaskUpdate', 'TaskList', 'Agent'],
  allowedTools: ['Read', 'Glob', 'Grep', 'TaskCreate', 'TaskUpdate', 'TaskList', 'Agent', 'mcp__manythreads__*'],
  extraArgs: { restricted: null, 'strict-mcp-config': null },
  allowDangerouslySkipPermissions: false,
};
const n = await a.request('session/new', { cwd: WORK, mcpServers: [mcp.server], _meta: { claudeCode: { options } } });
console.log('session/new at', a.elapsed(), n.error ?? 'ok');
const sid = n.result.sessionId;
await a
  .request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'haiku' })
  .then((r) => console.log('set model', JSON.stringify(r.result?.configOptions?.find?.((o) => o.id === 'model')?.currentValue ?? r.error)));
const p = await prompt(
  a,
  sid,
  'Do these in order, tersely: (1) write a todo plan of 2 items with TaskCreate, and mark the first one done with TaskUpdate, (2) list the files in this folder with Glob, (3) read package.json with Read, (4) call the mt_note tool of the manythreads server with text "hi". Then answer in one short sentence.',
);
show(p.notes);
console.log('prompt', p.ms, 'ms', JSON.stringify(p.resp.result ?? p.resp.error).slice(0, 800));
console.log('kinds', JSON.stringify(kinds(p.notes)));
console.log('text:', textOf(p.notes));
console.log('mcp saw:', JSON.stringify({ ...mcp.seen, requests: mcp.seen.requests.length }), JSON.stringify(mcp.seen.requests.slice(0, 4)));
console.log('perm requests:', state.permLog.length);
const pb = await prompt(a, sid, 'Use the Agent tool to start one helper that reads package.json and returns only its "name" value. Then answer in one short sentence.');
show(pb.notes);
console.log('B prompt', pb.ms, 'ms', JSON.stringify(pb.resp.result ?? pb.resp.error).slice(0, 300));
console.log('B kinds', JSON.stringify(kinds(pb.notes)));
console.log('B text:', textOf(pb.notes));
const pc = await prompt(
  a,
  sid,
  'Try to run the shell command "echo hi" with a Bash tool, and try to create a file x.txt with a Write tool. Say in one line what happened and list the exact names of all tools you have.',
);
show(pc.notes);
console.log('C text:', textOf(pc.notes), JSON.stringify(pc.resp.result?.stopReason));
console.log('perm after C:', state.permLog.length);
console.log('stderr tail:', a.stderr.split('\n').slice(-8).join('\n').slice(0, 800));
console.log('token in stderr:', a.stderr.includes('spike-fake-token'));
console.log(
  'token in the adapter log folder:',
  execSync(`grep -rl spike-fake-token ${SPIKE}/claude-logs || true`).toString().trim() || 'no',
  '| files:',
  execSync(`ls ${SPIKE}/claude-logs 2>&1 | head -3`).toString().trim(),
);
console.log('exit', JSON.stringify(await a.stop()));
await mcp.close();
