import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const compose = read('deploy/compose/docker-compose.yml');
const overlay = read('deploy/compose/docker-compose.test.yml');

/** The service names under the top-level `services:` key (2-space indent, nothing after the colon). */
function serviceNames(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'services:');
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** The text of one service block. */
function serviceBlock(text: string, name: string): string {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l === `  ${name}:`);
  const rest = lines.slice(from + 1);
  const len = rest.findIndex((l) => /^ {0,2}\S/.test(l) && !/^ {2}#/.test(l) && !l.startsWith('    '));
  return rest.slice(0, len < 0 ? rest.length : len).join('\n');
}

describe('deploy/compose/docker-compose.yml', () => {
  it('has exactly the five long-running services', () => {
    expect(serviceNames(compose)).toEqual(['postgres', 'litellm', 'hindsight', 'manythreads', 'hermes']);
  });

  it('has no fake or fixed password, key or token: every secret comes from the .env file and stops the start when it is missing', () => {
    const env = compose
      .split('\n')
      .filter((l) => /^\s+[A-Z][A-Z0-9_]*:\s/.test(l) && /(PASSWORD|KEY|SALT|TOKEN|SECRET)/.test(l.split(':')[0] ?? ''));
    expect(env.length).toBeGreaterThan(10);
    for (const line of env) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      // A reference to a variable, or a flag that is not a secret.
      expect(value, line).toMatch(/^"?\$\{[A-Z0-9_]+(:\?[^}]*)?\}/);
    }
    // the ones that must be set by the person say so
    for (const name of [
      'POSTGRES_PASSWORD',
      'MANYTHREADS_APP_PASSWORD',
      'MANYTHREADS_SYSTEM_PASSWORD',
      'MANYTHREADS_KMS_KEY',
      'MANYTHREADS_LITELLM_MASTER_KEY',
      'MANYTHREADS_LITELLM_SALT_KEY',
      'MANYTHREADS_HINDSIGHT_API_KEY',
      'MANYTHREADS_HINDSIGHT_DB_PASSWORD',
      'MANYTHREADS_HINDSIGHT_LLM_KEY',
      'MANYTHREADS_HERMES_API_KEY',
      'MANYTHREADS_HERMES_LLM_KEY',
    ]) {
      expect(compose, name).toContain('${' + name + ':?');
    }
    expect(compose).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
    expect(compose).not.toMatch(/compose-test/);
    expect(compose).not.toMatch(/dev-master|manythreads_owner:manythreads@|hindsight:hindsight@/);
  });

  it('has no test stand-in in it (the fake LLM lives in the overlay only)', () => {
    expect(compose).not.toMatch(/fake/i);
    expect(serviceNames(overlay)).toEqual(['fake-llm', 'manythreads']);
  });

  it('keeps Hindsight on the memory network alone, with no published port; only the web port is published', () => {
    expect(serviceBlock(compose, 'hindsight')).toMatch(/networks: \[memory\]/);
    expect(serviceBlock(compose, 'hindsight')).not.toMatch(/ports:/);
    expect(serviceBlock(compose, 'hermes')).not.toMatch(/memory/);
    for (const name of ['postgres', 'litellm', 'hermes']) expect(serviceBlock(compose, name), name).not.toMatch(/ports:/);
    expect(serviceBlock(compose, 'manythreads')).toMatch(/ports:\n\s+- "\$\{MANYTHREADS_BIND:-127\.0\.0\.1\}:/);
  });

  it('gives every service a health check', () => {
    for (const name of serviceNames(compose)) expect(serviceBlock(compose, name), name).toContain('healthcheck:');
  });

  it('shares the profile volume between the manythreads and hermes containers', () => {
    expect(serviceBlock(compose, 'manythreads')).toContain('hermes_profiles:/hermes-profiles');
    expect(serviceBlock(compose, 'hermes')).toContain('hermes_profiles:/home/node/.hermes/profiles');
  });

  it('is understood by docker compose when it is installed', () => {
    let version = '';
    try {
      version = execFileSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return; // no docker here: the text checks above are all this test can do
    }
    expect(version).not.toBe('');
    const env = {
      ...process.env,
      ...Object.fromEntries(
        read('tools/compose-test/test.env')
          .split('\n')
          .filter((l) => /^[A-Z]/.test(l))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      ),
    };
    const out = execFileSync('docker', ['compose', '-f', 'deploy/compose/docker-compose.yml', '-f', 'deploy/compose/docker-compose.test.yml', 'config', '--services'], {
      cwd: root,
      env,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(out).toEqual(['fake-llm', 'hermes', 'hindsight', 'litellm', 'manythreads', 'postgres']);
    // without the .env file the supported file refuses to start and names what is missing
    const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MANYTHREADS_') && k !== 'POSTGRES_PASSWORD'));
    let message = '';
    try {
      execFileSync('docker', ['compose', '--project-directory', 'deploy/compose', '-f', 'deploy/compose/docker-compose.yml', 'config', '--quiet'], { cwd: root, env: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      message = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(message).toMatch(/is not set/);
  });
});

describe('the files around it', () => {
  it('has an .env.example that names every variable the compose file requires, with no value', () => {
    const example = read('deploy/compose/.env.example');
    const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1] as string);
    expect(required.length).toBeGreaterThan(8);
    for (const name of new Set(required)) expect(example, name).toMatch(new RegExp(`^${name}=$`, 'm'));
  });

  it('make-env.sh writes every variable the compose file requires', () => {
    const script = read('deploy/compose/make-env.sh');
    for (const name of new Set([...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1] as string))) expect(script, name).toContain(`${name}=`);
  });

  it('has a test.env with a value for every required variable, and only there', () => {
    const fixed = read('tools/compose-test/test.env');
    for (const name of new Set([...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1] as string))) expect(fixed, name).toMatch(new RegExp(`^${name}=.+`, 'm'));
    const key = /^MANYTHREADS_KMS_KEY=(.+)$/m.exec(fixed)?.[1] ?? '';
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  it('keeps the shell scripts executable', () => {
    for (const file of ['deploy/compose/make-env.sh', 'deploy/compose/postgres-init.sh', 'deploy/compose/hermes-entrypoint.sh', 'tools/compose-test/run.sh']) {
      expect(statSync(join(root, file)).mode & 0o111, file).not.toBe(0);
    }
  });

  it('writes no secret in any file of the install except the test files', () => {
    const files = ['deploy/compose/.env.example', 'deploy/compose/make-env.sh', 'deploy/compose/postgres-init.sh', 'deploy/compose/hermes-entrypoint.sh', 'deploy/compose/litellm.selfhost.yaml'];
    for (const file of files) expect(read(file), file).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(readdirSync(join(root, 'deploy/compose')).filter((f) => f === '.env')).toEqual([]);
  });
});
