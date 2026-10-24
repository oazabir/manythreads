import { startFakeHermesGateway } from './server.ts';

// A dev stand-in: one profile `demo` whose key is the first argument (or `demo-key-0123456789`), answering every run with an echo.
const key = process.argv[2] ?? 'demo-key-0123456789';
const port = Number(process.env['FAKE_HERMES_PORT'] ?? '8642');
const gw = await startFakeHermesGateway({ port, profiles: { demo: { apiKey: key } } });
console.log(`fake Hermes gateway on ${gw.url} (profile "demo", key ${key})`);
