import { startFakeHindsight } from './server.ts';

/*
 * Run the fake engine on its own port (PLAN P5-12): `pnpm -C tools/fake-hindsight start`, then
 * `MANYTHREADS_HINDSIGHT_URL=http://127.0.0.1:8888` for a dev server that has team memory with no container, no database and no LLM.
 * `FAKE_HINDSIGHT_PORT` and `FAKE_HINDSIGHT_API_KEY` configure it.
 * `FAKE_HINDSIGHT_HOST` (default 127.0.0.1) names the interface to bind; the demo deployment sets 0.0.0.0 so the
 * pod's probes and the server reach it.
 */
const port = Number(process.env['FAKE_HINDSIGHT_PORT'] ?? 8888);
const host = (process.env['FAKE_HINDSIGHT_HOST'] ?? '127.0.0.1').trim() || '127.0.0.1';
const apiKey = (process.env['FAKE_HINDSIGHT_API_KEY'] ?? '').trim() || undefined;
const fake = await startFakeHindsight({ port, host, ...(apiKey ? { apiKey } : {}) });
console.log(`fake-hindsight ready: ${fake.url} (api key ${apiKey ? 'required' : 'not required'})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
