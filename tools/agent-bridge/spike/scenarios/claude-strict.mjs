import { boot, mcpServer, prompt, textOf, state, WORK } from './lib.mjs';
const { a } = await boot('claude', 'strict-probe');
const mcp = await mcpServer();
const options = {
  settingSources: [],
  tools: ['Read', 'Glob', 'Grep', 'TaskCreate', 'TaskUpdate', 'TaskList', 'Agent'],
  allowedTools: ['Read', 'Glob', 'Grep', 'TaskCreate', 'TaskUpdate', 'TaskList', 'Agent', 'mcp__manythreads__*'],
  extraArgs: { restricted: null, 'strict-mcp-config': null },
  allowDangerouslySkipPermissions: false,
};
const n = await a.request('session/new', { cwd: WORK, mcpServers: [mcp.server], _meta: { claudeCode: { options } } });
const sid = n.result.sessionId;
await a.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'haiku' });
const p = await prompt(
  a,
  sid,
  'List the exact names of all tools you have, grouped by prefix, no commentary. Then call mt_note from the manythreads server with text "x".',
);
console.log(textOf(p.notes).slice(0, 1500));
console.log('mcp calls', JSON.stringify(mcp.seen.calls), 'authOk', mcp.seen.authOk, 'perms', state.permLog.length);
await a.stop();
await mcp.close();
