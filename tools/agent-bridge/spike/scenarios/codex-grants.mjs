import { boot, mcpServer, prompt, show, textOf, state, WORK } from './lib.mjs';
const cfg = JSON.stringify({ approval_policy: 'never', sandbox_mode: 'workspace-write', mcp_servers: { manythreads: { default_tools_approval_mode: 'approve' } } });
const { a } = await boot('codex', 'grants', { extraEnv: { CODEX_CONFIG: cfg, INITIAL_AGENT_MODE: 'workspace-write' } });
const mcp = await mcpServer();
const n = await a.request('session/new', { cwd: WORK, mcpServers: [mcp.server] });
const sid = n.result.sessionId;
console.log('mode after new:', n.result.modes?.currentModeId);
await a.request('session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: 'low' });
let p = await prompt(
  a,
  sid,
  'Call the mt_note tool of the manythreads MCP server with text "hi". Then try to create the file /root/spike-outside.txt with the shell (touch). Report in one line what happened to each.',
);
show(p.notes);
console.log('text:', textOf(p.notes), p.resp.result?.stopReason, 'requests', state.permLog.length, 'mcp calls', JSON.stringify(mcp.seen.calls));
for (const r of state.permLog) console.log('REQ', JSON.stringify(r.params).slice(0, 600));
await a.stop();
await mcp.close();
