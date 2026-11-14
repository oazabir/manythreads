import { open, SPIKE, WORK, MCP_TOKEN } from './common.mjs';
import { startMcpServer, kinds, textOf, sleep } from '../acp-probe.mjs';
export { SPIKE, WORK, MCP_TOKEN, kinds, textOf, sleep };
export const OURS = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true, _meta: { gateway: true } }, elicitation: { url: {} } };
export const state = { perm: 'allow', permLog: [], elicLog: [], hang: [] };
export function onRequest(msg) {
  if (msg.method === 'session/request_permission') {
    const opts = msg.params.options ?? [];
    state.permLog.push({ t: Date.now(), params: msg.params });
    if (state.perm === 'hang') return new Promise((res) => state.hang.push(res));
    if (state.perm === 'cancel') return { result: { outcome: { outcome: 'cancelled' } } };
    const kind = state.perm === 'reject' ? 'reject_once' : 'allow_once';
    const o = opts.find((x) => x.kind === kind) ?? opts[0];
    return { result: { outcome: { outcome: 'selected', optionId: o.optionId } } };
  }
  if (msg.method === 'elicitation/create') {
    state.elicLog.push(msg.params);
    return { result: { action: 'cancel' } };
  }
  return { error: { code: -32601, message: `client does not implement ${msg.method}` } };
}
export async function boot(agent, scenario, { caps = OURS, cwd = WORK, extraEnv = {} } = {}) {
  const a = open(agent, scenario, { onRequest, cwd, extraEnv });
  const init = await a.request('initialize', { protocolVersion: 1, clientCapabilities: caps, clientInfo: { name: 'manythreads-spike', version: '0.0.0' } });
  return { a, init, tInit: a.elapsed() };
}
export async function mcpServer() {
  const m = await startMcpServer({ token: MCP_TOKEN });
  return { ...m, server: { type: 'http', name: 'manythreads', url: m.url, headers: [{ name: 'Authorization', value: `Bearer ${MCP_TOKEN}` }] } };
}
/** Sends a prompt, returns the answer and the notifications of that session that came meanwhile. */
export async function prompt(a, sessionId, text, { timeoutMs = 180000 } = {}) {
  const start = a.notifications.length;
  const t0 = a.elapsed();
  const resp = await a.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, { timeoutMs });
  const notes = a.notifications.slice(start).filter((n) => n.params?.sessionId === sessionId);
  return { resp, notes, ms: a.elapsed() - t0 };
}
export function show(notes, { full = false } = {}) {
  for (const n of notes) {
    if (n.method !== 'session/update') {
      console.log(`  [${n.t}] ${n.method}`, JSON.stringify(n.params).slice(0, 300));
      continue;
    }
    const u = n.params.update;
    const k = u.sessionUpdate;
    if (k === 'agent_message_chunk' || k === 'agent_thought_chunk') continue;
    if (k === 'tool_call' || k === 'tool_call_update') {
      const parts = {
        id: String(u.toolCallId).slice(-10),
        title: u.title,
        kind: u.kind,
        status: u.status,
        loc: u.locations?.map((l) => l.path),
        content: u.content?.map((c) => c.type + (c.content?.type ? ':' + c.content.type : '')),
        rawIn: u.rawInput ? Object.keys(u.rawInput) : undefined,
        rawOut: u.rawOutput !== undefined,
        meta: u._meta,
      };
      console.log(`  [${n.t}] ${k}`, JSON.stringify(parts).slice(0, full ? 2000 : 700));
    } else console.log(`  [${n.t}] ${k}`, JSON.stringify(u).slice(0, full ? 2000 : 400));
  }
}
