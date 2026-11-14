import { open, WORK } from './common.mjs';
const agent = process.argv[2];
const ours = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true, _meta: { gateway: true } }, elicitation: { url: {} } };
for (const [label, caps] of [
  ['bare', {}],
  ['ours', ours],
]) {
  const a = open(agent, `init-${label}`);
  const r = await a.request('initialize', { protocolVersion: 1, clientCapabilities: caps, clientInfo: { name: 'manythreads-spike', version: '0.0.0' } });
  const tInit = a.elapsed();
  console.log(`--- ${agent} ${label}: initialize answered at ${tInit} ms (rtt ${r.rtt})`);
  console.log(JSON.stringify(r.result ?? r.error, null, 1).slice(0, 6000));
  const n = await a.request('session/new', { cwd: WORK, mcpServers: [] });
  console.log(`session/new at ${a.elapsed()} ms (rtt ${n.rtt}):`, JSON.stringify(n.result ?? n.error).slice(0, 2500));
  console.log('stderr:', a.stderr.slice(0, 600));
  console.log('exit', JSON.stringify(await a.stop()));
}
