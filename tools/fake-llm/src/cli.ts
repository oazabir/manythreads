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
 * `FAKE_LLM_HOST` (default 127.0.0.1) names the interface to bind; the demo deployment sets 0.0.0.0 so the
 * pod's probes and the server reach it.
 *
 * `FAKE_LLM_UPSTREAM` names a real OpenAI-compatible gateway to forward chat completions to, so a real agent runs against a
 * real model while this server keeps the config and the keys. The credential is never a literal in the environment here:
 * `FAKE_LLM_UPSTREAM_KEY_ENV` names the variable that holds it (e.g. `LITELLM_API_KEY`), and `FAKE_LLM_UPSTREAM_MODEL`
 * renames the model asked for (manythreads' aliases are not the gateway's model names).
 */

const port = Number(process.env['FAKE_LLM_PORT'] ?? 4000);
const host = (process.env['FAKE_LLM_HOST'] ?? '127.0.0.1').trim() || '127.0.0.1';
const masterKey = (process.env['FAKE_LLM_MASTER_KEY'] ?? '').trim() || undefined;
const scenarioFlag = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length);
const scenarioEnv = (process.env['FAKE_LLM_SCENARIO'] ?? '').trim() || undefined;
const scenario = scenarioFlag ?? scenarioEnv;
if (scenario !== undefined && scenario !== 'demo' && scenario !== 'journey') {
  console.error(`unknown scenario "${scenario}": "demo" and "journey" are supported`);
  process.exit(1);
}

// FAKE_LLM_GOOD_KEYS (comma separated) makes the stand-in a provider that refuses every other key with a 401; FAKE_LLM_NO_QUOTA_KEYS lists keys that get a 429.
const list = (name: string): string[] => (process.env[name] ?? '').split(',').map((k) => k.trim()).filter((k) => k !== '');
const goodKeys = list('FAKE_LLM_GOOD_KEYS');
const noQuotaKeys = list('FAKE_LLM_NO_QUOTA_KEYS');

const upstreamUrl = (process.env['FAKE_LLM_UPSTREAM'] ?? '').trim().replace(/\/+$/, '');
const upstreamKeyEnv = (process.env['FAKE_LLM_UPSTREAM_KEY_ENV'] ?? '').trim();
const upstreamKey = upstreamKeyEnv === '' ? '' : (process.env[upstreamKeyEnv] ?? '').trim();
const upstreamName = (process.env['FAKE_LLM_UPSTREAM_MODEL'] ?? '').trim();
if (upstreamKeyEnv !== '' && upstreamKey === '') {
  console.error(`FAKE_LLM_UPSTREAM_KEY_ENV names ${upstreamKeyEnv}, which is not set`);
  process.exit(1);
}
const upstream =
  upstreamUrl === ''
    ? undefined
    : { url: upstreamUrl, ...(upstreamKey === '' ? {} : { apiKey: upstreamKey }), ...(upstreamName === '' ? {} : { model: upstreamName }) };

const fake = await startFakeLlm({
  port,
  host,
  ...(masterKey ? { masterKey } : {}),
  ...(scenario === 'demo' || scenario === 'journey' ? { scenario } : {}),
  ...(goodKeys.length > 0 ? { providerKeys: { good: goodKeys, noQuota: noQuotaKeys } } : {}),
  ...(upstream ? { upstream } : {}),
});

// The line a probe waits for; the URL is the value MANYTHREADS_LITELLM_URL takes.
console.log(`fake-llm ready: ${fake.url} (master key ${masterKey ? 'required' : 'not required'}${scenario !== undefined ? `, scenario ${scenario}` : ''})`);
console.log(`  management: /model/new /model/update /model/delete /config/update /key/generate /key/delete`);
console.log(
  `  also:       /chat/completions (${
    upstream ? `forwarded to ${upstreamUrl}${upstreamName === '' ? '' : ` as ${upstreamName}`}` : scenario === 'demo' ? 'demo bot-chain scenario' : 'canned'
  }), /health/readiness, /state`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
