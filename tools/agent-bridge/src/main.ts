import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { startBridge } from './server.ts';
import { helloFor, keyFiles, readServerKey, storeServerKey } from './server-mode.ts';
import { startServerRepos } from './server-repos.ts';
import { kubeFolder } from './server-run.ts';
import { newInternalKey, startTunnel } from './tunnel.ts';

// tsx tools/agent-bridge/src/main.ts --config <file> [--listen 127.0.0.1:8650] [--state-dir ~/.manythreads-bridge] [--key-file <file>] [--repos-file <file>]
//
// Server mode (an enrolled server): the config has a "server" section. Then the bridge listens on a Unix socket, not a port, and dials the site (--site https://<site>)
// with its bridge key (the file the bridge wrote after a rotation, else $CREDENTIALS_DIRECTORY/key); the site's requests come in over that socket.
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
    'repos-file': { type: 'string' },
    site: { type: 'string' },
    'print-hello': { type: 'boolean', default: false },
    'insecure-for-tests': { type: 'boolean', default: false },
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
if (values['print-hello'] === true) {
  // what the installer sends the site when it enrols: the machine, the bridge's version and the agents it found (no secret in it)
  if (config.server === undefined) fatal('--print-hello is for a bridge with a "server" section');
  process.stdout.write(`${JSON.stringify(await helloFor(config))}\n`);
  process.exit(0);
}
if (config.server !== undefined) {
  if (!values.site) fatal('server mode needs --site https://<site>');
  const stateRoot = stateDir;
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const files = keyFiles(stateRoot, process.env['CREDENTIALS_DIRECTORY'], values['key-file']);
  try {
    readServerKey(files); // fail at start, in plain words, when there is no key
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }
  // A run that was cut short by a crash or a restart left its kubeconfig: no run survives a restart, so the folder is emptied.
  rmSync(kubeFolder(config.server.root), { recursive: true, force: true });
  const internalKey = newInternalKey();
  const socketPath = join(stateRoot, 'bridge.sock');
  const bridge = await startBridge({ config, apiKey: internalKey, stateDir, socketPath, siteUrl: values.site });
  const cfg = config;
  const tunnel = startTunnel({
    siteUrl: values.site,
    key: () => readServerKey(files),
    socketPath,
    internalKey,
    hello: () => helloFor(cfg),
    storeKey: storeServerKey(stateRoot),
    insecure: values['insecure-for-tests'] === true,
    log: (line) => console.log(line),
  });
  // the repositories of the teams on this server's runners: the list from the site, and the sync step that clones them (needs the bundle's tools folder)
  const repos = cfg.server?.toolsDir !== undefined
    ? startServerRepos({ siteUrl: values.site, key: () => readServerKey(files), toolsDir: cfg.server.toolsDir, root: cfg.server.root, stateDir, syncSeconds: 10, log: (line) => console.log(line) })
    : undefined;
  console.log(`agent-bridge (server mode) dialing ${new URL(values.site).origin}; profiles are made from the "server" section`);
  const stop = (): void => {
    void tunnel.close().then(() => repos?.close()).then(() => bridge.close()).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
const apiKey = readKey(values['key-file'] ?? join(stateDir, 'api-key'));
if (apiKey.length < 16) fatal('the API key must be at least 16 characters');
// The key lives in this process only; children are started without it (see runs.ts), and it is dropped from the environment here too.
delete process.env['AGENT_BRIDGE_API_KEY'];

const bridge = await startBridge({ config, apiKey, stateDir, host: listen![1] ?? listen![2]!, port: Number(listen![3]), ...(values['repos-file'] ? { reposFile: values['repos-file'] } : {}), ...(process.env['CLAUDE_CONFIG_DIR'] ? { claudeConfigDir: process.env['CLAUDE_CONFIG_DIR'] } : {}), ...(process.env['CODEX_HOME'] ? { codexHome: process.env['CODEX_HOME'] } : {}) });
console.log(`agent-bridge listening on ${bridge.url} (profiles: ${Object.keys(config.profiles).join(', ')})`);
const shutdown = (): void => {
  void bridge.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
}
