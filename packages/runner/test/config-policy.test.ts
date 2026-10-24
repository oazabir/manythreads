import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { detectCapabilities, type Probe } from '../src/capabilities.ts';
import { ConfigError, connectUrl, loadConfig, parseFlags, profilesDir, readToken } from '../src/config.ts';
import { checkServerConfig, terminalSection, withRunnerPolicy } from '../src/policy.ts';

const scratch = mkdtempSync(join(tmpdir(), 'runner-config-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('configuration', () => {
  it('needs the server and the token file, and says so', () => {
    expect(() => loadConfig([], {})).toThrow(/server address is required/);
    expect(() => loadConfig(['--server', 'https://t.example'], {})).toThrow(/token file is required/);
  });

  it('reads flags before environment, with workable defaults', () => {
    const c = loadConfig(['--server', 'https://t.example/', '--token-file=/etc/t', '--max-jobs', '3'], { MANYTHREADS_RUNNER_SERVER: 'https://other', HERMES_HOME: '/h/.hermes' });
    expect(c).toMatchObject({ server: 'https://t.example', tokenFile: '/etc/t', maxJobs: 3, terminal: 'docker', hermesBin: 'hermes', hermesHome: '/h/.hermes', sandboxImage: 'manythreads/runner-sandbox:1' });
    // Hermes only boots from <home>/profiles/<name>
    expect(profilesDir(c)).toBe('/h/.hermes/profiles');
  });

  it('refuses a typo, a bad number and a bad mode instead of running with defaults', () => {
    expect(() => parseFlags(['--sever', 'x'])).toThrow(ConfigError);
    expect(() => parseFlags(['--server'])).toThrow(/needs a value/);
    expect(() => parseFlags(['stray'])).toThrow(/unexpected/);
    const base = ['--server', 'https://t', '--token-file', '/t'];
    expect(() => loadConfig([...base, '--max-jobs', '0'], {})).toThrow(/max-jobs/);
    expect(() => loadConfig([...base, '--terminal', 'ssh'], {})).toThrow(/terminal/);
    expect(() => loadConfig(['--server', 'ftp://x', '--token-file', '/t'], {})).toThrow(/http/);
  });

  it('builds the websocket address from the public address', () => {
    expect(connectUrl('https://threads.example')).toBe('wss://threads.example/api/runners/connect');
    expect(connectUrl('http://localhost:3000')).toBe('ws://localhost:3000/api/runners/connect');
  });

  it('reads the token only from a private file that holds a runner token', () => {
    const good = join(scratch, 'good');
    writeFileSync(good, 'mtr_abcdefghijklmnopqrstuvwxyz0123456789\n', { mode: 0o600 });
    chmodSync(good, 0o600);
    expect(readToken(good)).toBe('mtr_abcdefghijklmnopqrstuvwxyz0123456789');
    const open = join(scratch, 'open');
    writeFileSync(open, 'mtr_abcdefghijklmnopqrstuvwxyz0123456789\n');
    chmodSync(open, 0o644);
    expect(() => readToken(open)).toThrow(/readable by other users/);
    const wrong = join(scratch, 'wrong');
    writeFileSync(wrong, 'sk-not-a-runner-token\n', { mode: 0o600 });
    expect(() => readToken(wrong)).toThrow(/does not hold a runner token/);
    expect(() => readToken(join(scratch, 'missing'))).toThrow(/cannot be read/);
  });
});

const SERVER_CONFIG = `model:
  provider: "manythreads"
  default: "code"
platform_toolsets:
  cli: ["terminal", "file"]
agent:
  disabled_toolsets: ["browser"]
providers:
  manythreads:
    api: "https://t.example/api/llm/runs/r/v1"
    api_key: "run-token"
mcp_servers:
  manythreads:
    url: "https://t.example/api/mcp/runs/r"
    headers:
      Authorization: "Bearer run-token"
`;

describe('the runner decides the host policy', () => {
  it('accepts the profile the server renders', () => {
    expect(checkServerConfig(SERVER_CONFIG)).toEqual({ ok: true });
  });

  it('refuses a config that says anything about the host: a terminal section, an unknown section, a program to start', () => {
    expect(checkServerConfig(`${SERVER_CONFIG}terminal:\n  backend: local\n`)).toMatchObject({ ok: false, reason: expect.stringContaining('"terminal"') });
    expect(checkServerConfig(`${SERVER_CONFIG}hooks:\n  x: y\n`)).toMatchObject({ ok: false });
    expect(checkServerConfig(`mcp_servers:\n  evil:\n    command: sh\n    args: ["-c", "id"]\n`)).toMatchObject({ ok: false, reason: expect.stringContaining('names a program') });
    expect(checkServerConfig(`mcp_servers:\n  evil:\n    url: "https://x"\n    command: sh\n`)).toMatchObject({ ok: false });
    expect(checkServerConfig('mcp_servers:\n  x: {}\n')).toMatchObject({ ok: false, reason: expect.stringContaining('no url') });
    expect(checkServerConfig('- a\n- b\n')).toMatchObject({ ok: false });
    expect(checkServerConfig('a: [unclosed')).toMatchObject({ ok: false, reason: expect.stringContaining('does not parse') });
  });

  it('refuses keys the server does not render: a provider that points at a host credential or address, extra model, agent and mcp keys', () => {
    const swap = (from: string, to: string) => SERVER_CONFIG.replace(from, to);
    for (const [label, text] of [
      ['api_key_env', swap('    api_key: "run-token"\n', '    api_key_env: "LITELLM_API_KEY"\n')],
      ['base_url', swap('    api_key: "run-token"\n', '    api_key: "run-token"\n    base_url: "http://169.254.169.254"\n')],
      ['model key', swap('  default: "code"\n', '  default: "code"\n  base_url: "http://x"\n')],
      ['agent key', swap('agent:\n', 'agent:\n  system_prompt_file: "/etc/passwd"\n')],
      ['mcp key', swap('    url: "https://t.example/api/mcp/runs/r"\n', '    url: "https://t.example/api/mcp/runs/r"\n    tools: ["*"]\n')],
      ['platform_toolsets key', swap('  cli: ["terminal", "file"]\n', '  cli: ["terminal"]\n  telegram: ["terminal"]\n')],
    ] as const) {
      expect(checkServerConfig(text), label).toMatchObject({ ok: false });
    }
    // what the server does render is accepted, with the optional keys
    const full = `${SERVER_CONFIG}`.replace('    api_key: "run-token"\n', '    api_key: "run-token"\n    transport: "chat_completions"\n    default_model: "code"\n    name: "manythreads"\n').replace('      Authorization: "Bearer run-token"\n', '      Authorization: "Bearer run-token"\n    timeout: 120\n    connect_timeout: 30\n').replace('agent:\n', 'agent:\n  reasoning_effort: "high"\n');
    expect(checkServerConfig(full)).toEqual({ ok: true });
  });

  it('appends a docker terminal whose cwd is the process directory (not /workspace) and mounts it', () => {
    const files = withRunnerPolicy({ 'config.yaml': SERVER_CONFIG, 'SOUL.md': 'x' }, { terminal: 'docker', sandboxImage: 'manythreads/runner-sandbox:1' }, 'run-1', 300, 1000);
    expect(files['SOUL.md']).toBe('x');
    const yaml = parseYaml(files['config.yaml']!) as Record<string, Record<string, unknown>>;
    expect(yaml['terminal']).toEqual({
      backend: 'docker',
      cwd: '.',
      timeout: 180,
      lifetime_seconds: 360,
      docker_image: 'manythreads/runner-sandbox:1',
      docker_mount_cwd_to_workspace: true,
      docker_run_as_host_user: true,
      docker_extra_args: ['--label', 'manythreads-runner-run=run-1'],
    });
    // everything the server rendered is still there, once
    expect(yaml['model']).toMatchObject({ default: 'code' });
    expect(files['config.yaml']!.match(/^terminal:/gm)).toHaveLength(1);
  });

  it('runs as root without asking docker for the host user, and offers a local terminal only when told to', () => {
    expect(terminalSection({ terminal: 'docker', sandboxImage: 'i' }, 'r', 60, 0)).not.toContain('docker_run_as_host_user');
    const local = parseYaml(terminalSection({ terminal: 'local', sandboxImage: 'i' }, 'r', 60, 1000)) as { terminal: Record<string, unknown> };
    expect(local.terminal).toMatchObject({ backend: 'local', cwd: '.' });
  });
});

const probeOf = (have: string[], over: Partial<Probe> = {}): Probe => ({
  platform: 'linux',
  env: {},
  home: '/h',
  has: (p) => have.includes(p),
  exists: () => false,
  dockerWorks: async () => have.includes('docker'),
  ...over,
});

describe('capabilities', () => {
  it('advertises what the machine has, from the words the spec gives', async () => {
    const caps = await detectCapabilities(probeOf(['hermes', 'docker', 'ffmpeg', 'nvidia-smi', 'google-chrome', 'claude']), 'hermes');
    expect(caps).toEqual(['cdp', 'chrome', 'claude-code', 'docker', 'ffmpeg', 'gpu', 'hermes']);
  });

  it('does not claim docker when the program is there but the daemon is not', async () => {
    expect(await detectCapabilities(probeOf(['hermes', 'docker'], { dockerWorks: async () => false }), 'hermes')).toEqual(['hermes']);
  });

  it('recognises the platform capabilities and an explicit Hermes path', async () => {
    expect(await detectCapabilities(probeOf([], { platform: 'win32' }), 'C:/h/hermes.exe')).toEqual(['windows']);
    expect(await detectCapabilities(probeOf(['xcrun'], { platform: 'darwin' }), 'hermes')).toEqual(['ios-simulator']);
    expect(await detectCapabilities(probeOf([], { exists: (p) => p === '/opt/hermes' }), '/opt/hermes')).toEqual(['hermes']);
  });

  it('adds the operator\'s words and drops anything that is not a capability word', async () => {
    expect(await detectCapabilities(probeOf([]), 'hermes', ['codex', 'Bad Word', 'x;y', 'playwright'])).toEqual(['codex', 'playwright']);
  });
});
