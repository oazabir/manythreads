import { startFakeHindsight } from './server.ts';

/*
 * Run the fake engine on its own port (PLAN P5-12): `pnpm -C tools/fake-hindsight start`, then
 * `MANYTHREADS_HINDSIGHT_URL=http://127.0.0.1:8888` for a dev server that has team memory with no container, no database and no LLM.
 * `FAKE_HINDSIGHT_PORT` and `FAKE_HINDSIGHT_API_KEY` configure it.
 */
const port = Number(process.env['FAKE_HINDSIGHT_PORT'] ?? 8888);
const apiKey = (process.env['FAKE_HINDSIGHT_API_KEY'] ?? '').trim() || undefined;
const fake = await startFakeHindsight({ port, ...(apiKey ? { apiKey } : {}) });
console.log(`fake-hindsight ready: ${fake.url} (api key ${apiKey ? 'required' : 'not required'})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
