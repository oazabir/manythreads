import { boot, mcpServer, prompt, show, kinds, textOf, state, WORK } from './lib.mjs';
const { a, tInit } = await boot('codex', 'work');
console.log('init at', tInit, 'ms');
const mcp = await mcpServer();
const n = await a.request('session/new', { cwd: WORK, mcpServers: [mcp.server] });
console.log('session/new at', a.elapsed(), n.error ?? 'ok');
const sid = n.result.sessionId;
for (const [configId, value] of [
  ['reasoning_effort', 'low'],
  ['mode', 'workspace-write'],
]) {
  const r = await a.request('session/set_config_option', { sessionId: sid, configId, value });
  console.log('set', configId, r.error ? JSON.stringify(r.error) : 'ok');
}
const p = await prompt(
  a,
  sid,
  'Do these in order, tersely: (1) write a plan of 2 items with your plan tool, (2) list the files in this folder, (3) read package.json, (4) call the mt_note tool of the manythreads MCP server with text "hi". Then answer in one short sentence.',
);
show(p.notes, { full: false });
console.log('prompt', p.ms, 'ms', JSON.stringify(p.resp.result ?? p.resp.error).slice(0, 800));
console.log('kinds', JSON.stringify(kinds(p.notes)));
console.log('text:', textOf(p.notes));
console.log('mcp saw:', JSON.stringify({ ...mcp.seen, requests: mcp.seen.requests.length }), JSON.stringify(mcp.seen.requests.slice(0, 3)));
console.log('perm requests:', state.permLog.length);
const pb = await prompt(a, sid, 'Spawn one subagent whose only job is to read package.json and return the "name" value. Then answer in one short sentence.');
show(pb.notes);
console.log('B', pb.ms, JSON.stringify(pb.resp.result?.stopReason ?? pb.resp.error), JSON.stringify(kinds(pb.notes)));
console.log('B text:', textOf(pb.notes));
console.log('stderr tail:', a.stderr.slice(-400));
console.log('exit', JSON.stringify(await a.stop()));
await mcp.close();
