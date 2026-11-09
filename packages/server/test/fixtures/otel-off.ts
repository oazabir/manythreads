// Run by test/otel.test.ts in a fresh process: loads what the server loads at start with no OTLP endpoint, then lists the OpenTelemetry modules that ended up loaded.
import { createRequire } from 'node:module';
import { setTraceBridge, tracingOn } from '@manythreads/sdk';
import { registerHttpTracing } from '../../src/http-trace.ts';
import { otelConfigFromEnv, startOtel } from '../../src/otel.ts';

const mode = process.argv[2] ?? 'off';
const cache = (): string[] => Object.keys((createRequire(import.meta.url)('node:module') as { _cache: Record<string, unknown> })._cache).filter((k) => k.includes('@opentelemetry'));

const before = cache().length;
const { config } = otelConfigFromEnv(mode === 'on' ? { MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' } : {});
const handle = await startOtel(config, mode === 'on' ? { simple: true } : {});
const fastifyHooks: string[] = [];
registerHttpTracing({ addHook: (name: string) => void fastifyHooks.push(name) } as never);
const result = { handle: handle !== null, tracing: tracingOn(), hooks: fastifyHooks, before, loaded: cache().length };
await handle?.shutdown();
setTraceBridge(null);
process.stdout.write(`${JSON.stringify(result)}\n`);
