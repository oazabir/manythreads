import { writeFileSync } from 'node:fs';
import { boot, mcpServer, prompt, show, kinds, textOf, state, SPIKE, WORK } from './lib.mjs';
const { a, tInit } = await boot('hermes', 'work');
console.log('init at', tInit, 'ms');
const mcp = await mcpServer();
const t = a.elapsed();
const n = await a.request('session/new', { cwd: WORK, mcpServers: [mcp.server] });
console.log('session/new rtt', a.elapsed() - t, n.error ? JSON.stringify(n.error) : 'ok');
const sid = n.result.sessionId;
writeFileSync(`${SPIKE}/hermes-sid`, sid);
const au = await a.request('authenticate', { methodId: 'custom' });
console.log('authenticate custom ->', JSON.stringify(au.result ?? au.error));
const p = await prompt(
  a,
  sid,
  'Do these in order, tersely: (1) write a todo plan of 2 items with your todo tool, (2) list the files in this folder, (3) read package.json, (4) call the mt_note tool of the manythreads MCP server with text "hi". Then answer in one short sentence.',
);
show(p.notes);
console.log('prompt', p.ms, 'ms', JSON.stringify(p.resp.result ?? p.resp.error).slice(0, 800));
console.log('kinds', JSON.stringify(kinds(p.notes)));
console.log('text:', textOf(p.notes));
console.log('mcp saw:', JSON.stringify({ ...mcp.seen, requests: mcp.seen.requests.length }), JSON.stringify(mcp.seen.requests.slice(0, 4)));
console.log('perm requests:', state.permLog.length);
console.log('token in stderr:', a.stderr.includes('spike-fake-token'));
console.log('stderr tail:', a.stderr.slice(-1500));
console.log('exit', JSON.stringify(await a.stop()));
await mcp.close();
