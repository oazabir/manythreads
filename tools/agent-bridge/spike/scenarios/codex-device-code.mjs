import { open, SPIKE } from './common.mjs';
import { onRequest, OURS, state } from './lib.mjs';
const a = open('codex', 'signin-devicecode', {
  onRequest: async (m) => {
    if (m.method === 'elicitation/create') {
      state.elicLog.push(m.params);
      console.log('ELICIT', JSON.stringify(m.params).slice(0, 800));
      return { result: { action: process.env.ELIC ?? 'cancel' } };
    }
    return onRequest(m);
  },
  extraEnv: { CODEX_HOME: `${SPIKE}/codex-home-empty` },
});
const init = await a.request('initialize', { protocolVersion: 1, clientCapabilities: OURS, clientInfo: { name: 'manythreads-spike', version: '0.0.0' } });
console.log('methods', init.result.authMethods.map((m) => m.id).join(','));
const t = a.elapsed();
const r = await a.request('authenticate', { methodId: 'chat-gpt-device-code' }, { timeoutMs: 12000 }).catch((e) => ({ error: String(e) }));
console.log('authenticate ->', JSON.stringify(r.result ?? r.error).slice(0, 500), 'after', a.elapsed() - t, 'ms');
for (const n of a.notifications) if (n.method !== 'session/update') console.log('notification', n.method, JSON.stringify(n.params).slice(0, 400));
const lo = await a.request('logout', {}).catch((e) => ({ error: String(e) }));
console.log('logout (scratch home) ->', JSON.stringify(lo.result ?? lo.error).slice(0, 300));
console.log('stderr', a.stderr.slice(0, 500));
await a.stop();
