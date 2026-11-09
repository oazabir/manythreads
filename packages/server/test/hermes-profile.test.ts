import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_MARKER,
  discardProfileDir,
  hasShell,
  mergeEnv,
  prepareProfileDir,
  profileConfigText,
  readEnvFile,
  runtimeGrants,
  splitBotMd,
  writeProfileFiles,
  type ManagedEnv,
  type ProfileView,
} from '../src/cli/hermes-profile.ts';

const values: ManagedEnv = { API_SERVER_KEY: 'key-1', MANYTHREADS_MCP_TOKEN: 'tok-1', LITELLM_API_KEY: 'sk-1' };
const settings = { mcpUrl: 'https://mt.example/mcp', llmBaseUrl: 'https://llm.example/v1', cwd: '/work', toolsets: { enabled: ['web', 'file'], disabled: ['browser'] } };

describe('profileConfigText', () => {
  it('writes, with the devbox settings, the text the host script always wrote (live profiles keep matching)', () => {
    expect(profileConfigText({ ...settings, llmBaseUrl: 'https://litellm-hetzner.kahf.to/v1', mcpUrl: 'http://127.0.0.1:3000/mcp', cwd: '/srv/x' })).toBe(`# manythreads mode A: a bot served by this host's own Hermes gateway (api_server). Written by tools/devbox/provision-host-bots.mjs.
model:
  default: "default"
  provider: "custom:litellm"
  base_url: "https://litellm-hetzner.kahf.to/v1"
providers:
  litellm:
    base_url: https://litellm-hetzner.kahf.to/v1
    key_env: LITELLM_API_KEY
    default_model: default
    models:
      default: {context_length: 262144}
mcp_servers:
  manythreads:
    url: "http://127.0.0.1:3000/mcp"
    headers:
      Authorization: "Bearer \${MANYTHREADS_MCP_TOKEN}"
    timeout: 120
    connect_timeout: 30
platform_toolsets:
  api_server: ["web", "file"]
agent:
  disabled_toolsets: ["browser"]
tools:
  tool_search:
    enabled: "off"
terminal:
  backend: "local"
  cwd: "/srv/x"
  timeout: 600
`);
  });

  it('names the model alias and the description it is given, and always carries the marker', () => {
    const text = profileConfigText({ ...settings, model: 'smart', description: 'the Brain' });
    expect(text.split('\n')[0]).toBe(`# manythreads mode A: the Brain. ${PROFILE_MARKER}.`);
    expect(text).toContain('  default: "smart"');
    expect(text).toContain('    default_model: smart');
    expect(text).toContain('      smart: {context_length: 262144}');
    expect(text).toContain('key_env: LITELLM_API_KEY');
    expect(text).not.toMatch(/sk-|tok-/);
  });
});

describe('mergeEnv and readEnvFile', () => {
  it('sets the three managed keys, keeps every other line, and writes each key once', () => {
    const merged = mergeEnv('# mine\nFOO=bar\nAPI_SERVER_KEY=old\nexport LITELLM_API_KEY="old"\nAPI_SERVER_KEY=dup\n', values);
    expect(merged).toBe('# mine\nFOO=bar\nAPI_SERVER_KEY=key-1\nLITELLM_API_KEY=sk-1\nAPI_SERVER_KEY=dup\nMANYTHREADS_MCP_TOKEN=tok-1\n');
  });

  it('makes a new file from nothing', () => {
    expect(mergeEnv(null, values)).toBe('API_SERVER_KEY=key-1\nMANYTHREADS_MCP_TOKEN=tok-1\nLITELLM_API_KEY=sk-1\n');
  });

  it('reads KEY=value lines, drops quotes, ignores the rest, and a missing file is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-env-'));
    try {
      writeFileSync(join(dir, '.env'), '# c\nA=1\nexport B="two words"\nC=\'q\'\nnot a line\n');
      expect(readEnvFile(join(dir, '.env'))).toEqual({ A: '1', B: 'two words', C: 'q' });
      expect(readEnvFile(join(dir, 'missing'))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('BOT.md helpers', () => {
  const md = '---\nname: x\ncapabilities:\n  runtime:\n    - shell\n    - files\n---\nbody\n';
  it('finds the front matter and the runtime grants (LF and CRLF)', () => {
    expect(runtimeGrants(md)).toEqual(['shell', 'files']);
    expect(hasShell(md)).toBe(true);
    expect(runtimeGrants(md.replace(/\n/g, '\r\n'))).toEqual(['shell', 'files']);
    expect(splitBotMd(md.replace(/\n/g, '\r\n')).eol).toBe('\r\n');
    expect(runtimeGrants('---\nname: y\n---\n')).toEqual([]);
    expect(() => splitBotMd('no front matter')).toThrow(/front matter/);
  });
});

describe('writing a profile', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mt-profiles-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const view = (profile: string, exists: boolean): ProfileView => ({ dir: join(root, profile), exists, token: '', state: 'none' });
  const config = profileConfigText({ ...settings, model: 'smart' });

  it('builds a new profile in a temp directory and renames it into place, with private files', () => {
    const v = view('mt-brain', false);
    const build = prepareProfileDir(root, 'mt-brain', v);
    expect(build).toContain('.tmp-mt-brain-');
    expect(existsSync(build)).toBe(true);
    expect(writeProfileFiles({ profile: 'mt-brain', view: v, build, config, values })).toBe('created');
    expect(readdirSync(root)).toEqual(['mt-brain']);
    expect(readFileSync(join(v.dir, 'config.yaml'), 'utf8')).toBe(config);
    expect(readFileSync(join(v.dir, '.env'), 'utf8')).toBe(mergeEnv(null, values));
    expect(statSync(join(v.dir, '.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(v.dir, 'config.yaml')).mode & 0o777).toBe(0o600);
  });

  it('discards a half-built new directory and leaves an existing profile alone', () => {
    const fresh = view('a', false);
    const build = prepareProfileDir(root, 'a', fresh);
    discardProfileDir(build, fresh);
    expect(existsSync(build)).toBe(false);
    mkdirSync(join(root, 'b'));
    const old = view('b', true);
    discardProfileDir(prepareProfileDir(root, 'b', old), old);
    expect(existsSync(join(root, 'b'))).toBe(true);
  });

  it('on an existing profile: rewrites our own config, then the env; says "unchanged" when nothing differs', () => {
    const v = view('p', false);
    writeProfileFiles({ profile: 'p', view: v, build: prepareProfileDir(root, 'p', v), config: config.replace('smart', 'fast'), values });
    const again = view('p', true);
    expect(writeProfileFiles({ profile: 'p', view: again, build: again.dir, config, values: { ...values, MANYTHREADS_MCP_TOKEN: 'tok-2' } })).toBe('config updated, env updated');
    expect(readFileSync(join(again.dir, '.env'), 'utf8')).toContain('MANYTHREADS_MCP_TOKEN=tok-2');
    expect(writeProfileFiles({ profile: 'p', view: again, build: again.dir, config, values: { ...values, MANYTHREADS_MCP_TOKEN: 'tok-2' } })).toBe('unchanged');
  });

  it('keeps a hand-edited config unless forced, and then keeps the old one as config.yaml.bak', () => {
    const v = view('h', false);
    writeProfileFiles({ profile: 'h', view: v, build: prepareProfileDir(root, 'h', v), config, values });
    const cfg = join(v.dir, 'config.yaml');
    writeFileSync(cfg, 'model:\n  default: mine\n');
    const again = view('h', true);
    expect(writeProfileFiles({ profile: 'h', view: again, build: again.dir, config, values })).toBe('config hand-edited, kept');
    expect(readFileSync(cfg, 'utf8')).toBe('model:\n  default: mine\n');
    expect(writeProfileFiles({ profile: 'h', view: again, build: again.dir, config, values, force: true })).toBe('config replaced (.bak kept)');
    expect(readFileSync(cfg, 'utf8')).toBe(config);
    expect(readFileSync(`${cfg}.bak`, 'utf8')).toBe('model:\n  default: mine\n');
    expect(statSync(`${cfg}.bak`).mode & 0o777).toBe(0o600);
  });

  it('keeps the other lines of an existing .env', () => {
    const v = view('e', false);
    writeProfileFiles({ profile: 'e', view: v, build: prepareProfileDir(root, 'e', v), config, values });
    writeFileSync(join(v.dir, '.env'), `${readFileSync(join(v.dir, '.env'), 'utf8')}EXTRA=1\n`);
    const again = view('e', true);
    writeProfileFiles({ profile: 'e', view: again, build: again.dir, config, values: { ...values, API_SERVER_KEY: 'key-2' } });
    const env = readEnvFile(join(v.dir, '.env'));
    expect(env['EXTRA']).toBe('1');
    expect(env['API_SERVER_KEY']).toBe('key-2');
  });
});
