import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { startBridge } from './server.ts';

// tsx tools/agent-bridge/src/main.ts --config <file> [--listen 127.0.0.1:8650] [--state-dir ~/.manythreads-bridge] [--key-file <file>]
//
// The API key comes from the environment (AGENT_BRIDGE_API_KEY) or from a file that only its owner can read (mode 0600);
// the bridge does not start without one.

function fatal(message: string): never {
  console.error(`agent-bridge: ${message}`);
  process.exit(1);
}

function readKey(keyFile: string): string {
  const fromEnv = process.env['AGENT_BRIDGE_API_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  let mode: number;
  try {
    mode = statSync(keyFile).mode;
  } catch {
    return fatal(`no API key: set AGENT_BRIDGE_API_KEY or create ${keyFile} (mode 0600)`);
  }
  if ((mode & 0o077) !== 0) return fatal(`${keyFile} is readable by others; run: chmod 600 ${keyFile}`);
  const key = readFileSync(keyFile, 'utf8').trim();
  if (key === '') return fatal(`${keyFile} is empty`);
  return key;
}

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    listen: { type: 'string', default: '127.0.0.1:8650' },
    'state-dir': { type: 'string' },
    'key-file': { type: 'string' },
  },
});
if (!values.config) fatal('--config <file> is required');
const stateDir = values['state-dir'] ?? join(homedir(), '.manythreads-bridge');
const listen = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(values.listen ?? '');
if (!listen) fatal('--listen must look like host:port');

let config;
try {
  config = loadConfig(values.config);
} catch (err) {
  fatal(err instanceof Error ? err.message : String(err));
}
const apiKey = readKey(values['key-file'] ?? join(stateDir, 'api-key'));
if (apiKey.length < 16) fatal('the API key must be at least 16 characters');
// The key lives in this process only; children are started without it (see runs.ts), and it is dropped from the environment here too.
delete process.env['AGENT_BRIDGE_API_KEY'];

const bridge = await startBridge({ config, apiKey, stateDir, host: listen![1] ?? listen![2]!, port: Number(listen![3]) });
console.log(`agent-bridge listening on ${bridge.url} (profiles: ${Object.keys(config.profiles).join(', ')})`);
const shutdown = (): void => {
  void bridge.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
