import { startFakeLlm } from './server.ts';

/*
 * Run the fake proxy on its own port (PLAN P5-08). Point the gateway at it and a workspace can push its config and mint
 * bot keys with no model provider, no API key and nothing to pull:
 *
 *     pnpm -C tools/fake-llm start
 *     MANYTHREADS_LITELLM_URL=http://127.0.0.1:4000 MANYTHREADS_LITELLM_MASTER_KEY=sk-fake pnpm ... dev
 *
 * `FAKE_LLM_PORT` and `FAKE_LLM_MASTER_KEY` configure it. With no master key set the management endpoints are open,
 * which is what makes a one-line dev setup possible; a test always sets one so the 401 path is covered too.
 */

const port = Number(process.env['FAKE_LLM_PORT'] ?? 4000);
const masterKey = (process.env['FAKE_LLM_MASTER_KEY'] ?? '').trim() || undefined;

const fake = await startFakeLlm({ port, ...(masterKey ? { masterKey } : {}) });

// The line a probe waits for; the URL is the value MANYTHREADS_LITELLM_URL takes.
console.log(`fake-llm ready: ${fake.url} (master key ${masterKey ? 'required' : 'not required'})`);
console.log(`  management: /model/new /model/update /model/delete /config/update /key/generate /key/delete`);
console.log(`  also:       /chat/completions (canned), /health/readiness, /state`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
