import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, noSidewaysScroll, openOn, PHONE } from '../support/stack-browser.ts';

/*
 * Workspace → Runners → Servers (PLAN P26-13, P26-14, P26-15, P26-16b), with no real machine and no real login. The site is a real stack; the machine is the real bridge program
 * (`tools/agent-bridge/src/main.ts`, started in server mode as a child process) that dials the site over the tunnel and drives the fake ACP agent. What the installer does with a
 * code is done here by the same two calls the script makes (`--print-hello`, then `POST /api/bridge/enrol`); the script itself is read by shellcheck and not run here.
 *
 * Shown: Add a server gives one command with a code, the careful way with the script's hash and the variant that asks for the code; the page waits and then lists the machine and its
 * agents; the agents became runners; Codex is signed in through the tunnel from the page; Rotate key gives a new key and the bridge goes on; Remove server cuts the connection and deletes the
 * runners; a plain member cannot reach the routes; the dialog fits a phone.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PATH = '/settings/workspace/runners';
const ROOT = join(import.meta.dirname, '..', '..');
const MAIN = join(ROOT, 'tools', 'agent-bridge', 'src', 'main.ts');
const BUILD = join(ROOT, 'tools', 'agent-bridge', 'install', 'build.mjs');
const FAKE_CLI = join(ROOT, 'tools', 'fake-acp-agent', 'src', 'cli.ts');
const TSX = createRequire(import.meta.url).resolve('tsx/esm');
const PASS = ['FAKE_ACP_SCRIPT_JSON', 'FAKE_ACP_FLAVOR', 'FAKE_ACP_STATE_DIR'];
const DEVICE_CODE = 'SRV4-12345'; // one group on each side of the dash: the bridge reads the code with /([A-Z0-9]{3,6}-[A-Z0-9]{3,8})/
const SERVER = 'build-box';

let dir: string;
let stack: Stack;
let bridge: ChildProcess | null = null;
let bridgeLog = '';
let code = '';

const fakeEnv = (): Record<string, string> => ({
  FAKE_ACP_FLAVOR: 'codex',
  FAKE_ACP_STATE_DIR: join(dir, 'fake-codex'),
  FAKE_ACP_SCRIPT_JSON: JSON.stringify({
    flavor: 'codex',
    auth: { signedIn: false, url: 'https://auth.example.test/device', deviceCode: DEVICE_CODE, pendingMs: 1500 },
    scenarios: { hello: [{ do: 'text', text: 'hi' }] },
    default: 'hello',
  }),
});

const configFile = (): string => {
  const acp = { command: process.execPath, args: ['--import', TSX, FAKE_CLI] };
  const root = join(dir, 'srv');
  const signin = (agent: string, home: string) => ({ agent, driver: 'acp', workdir: join(root, 'work', '.signin'), authHome: join(root, 'auth', home), passEnv: PASS, acp });
  const file = join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      profiles: { 'claude-signin': signin('claude-code', 'claude'), 'codex-signin': signin('codex', 'codex') },
      killGraceSeconds: 0.5,
      server: {
        root,
        agents: {
          claude: { authHome: join(root, 'auth', 'claude'), passEnv: PASS, acp },
          codex: { authHome: join(root, 'auth', 'codex'), passEnv: PASS, acp },
        },
        instructions: 'You work in {workdir}.',
      },
    }),
  );
  return file;
};

const bridgeArgs = (extra: string[]): string[] => ['--import', TSX, MAIN, '--config', join(dir, 'config.json'), '--state-dir', join(dir, 'state'), ...extra];

function startBridge(): void {
  bridgeLog = '';
  bridge = spawn(process.execPath, bridgeArgs(['--site', stack.origin, '--insecure-for-tests', '--key-file', join(dir, 'key')]), {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', HOME: dir, ...fakeEnv() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout?.on('data', (c: Buffer) => (bridgeLog += c.toString('utf8')));
  bridge.stderr?.on('data', (c: Buffer) => (bridgeLog += c.toString('utf8')));
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-servers-'));
  mkdirSync(join(dir, 'install'));
  execFileSync(process.execPath, [BUILD, '--out', join(dir, 'install')], { stdio: 'pipe' });
  configFile();
  stack = await startStack({ NODE_ENV: 'test', MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_BRIDGE_INSTALL_DIR: join(dir, 'install') });
});

test.afterAll(async () => {
  bridge?.kill('SIGTERM');
  await stack?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const section = (page: Page) => page.getByTestId('servers-section');
const row = (page: Page) => page.locator(`[data-testid="server-row"][data-server="${SERVER}"]`);

test('Add a server gives one command, the careful way and a variant that asks for the code', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(section(page).getByTestId('server-none')).toBeVisible();
    await section(page).getByTestId('server-add').click();
    const form = page.getByRole('dialog', { name: 'Add a server' });
    await form.getByLabel('Display name').fill('Build box');
    await expect(form.getByLabel('Short name')).toHaveValue(SERVER);
    await form.getByTestId('server-add-submit').click();

    const dialog = page.getByRole('dialog', { name: 'Install on Build box' });
    const command = await dialog.getByTestId('server-command-text').innerText();
    expect(command).toMatch(new RegExp(`^curl -fsSL ${stack.origin.replace(/[.]/g, '\\.')}/install/bridge\\.sh \\| sudo bash -s -- --enrol mte_[0-9a-f]+$`));
    code = /--enrol (\S+)$/.exec(command)![1]!;
    await dialog.getByText('The careful way').click();
    const careful = await dialog.getByTestId('server-careful-text').innerText();
    expect(careful).toMatch(/sha256sum -c -/);
    const sha = /echo "([0-9a-f]{64}) {2}bridge\.sh"/.exec(careful)?.[1];
    expect(sha).toBeTruthy();
    // the hash on the page is the hash of the script the site serves
    const served = await (await page.request.get(`${stack.origin}/install/bridge.sh`)).text();
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(served).digest('hex')).toBe(sha);
    await dialog.getByText('Keep the code out of your shell history').click();
    await expect(dialog.getByTestId('server-ask-text')).toHaveText(/--enrol -$/);
    await expect(dialog.getByTestId('server-wait')).toContainText('Waiting for build-box to connect');
    await dialog.getByTestId('server-command-done').click();
    await expect(row(page).getByTestId('server-state')).toHaveText('Waiting for the installer');
  } finally {
    await context.close();
  }
});

test('the installer redeems the code and the bridge dials in: the page lists the machine and its agents, and the agents are runners', async ({ browser, playwright }) => {
  // what bridge.sh does: print the hello, redeem the code once, keep the key
  const hello = JSON.parse(execFileSync(process.execPath, bridgeArgs(['--print-hello']), { cwd: ROOT, env: { PATH: process.env['PATH'] ?? '', HOME: dir, ...fakeEnv() }, encoding: 'utf8' })) as {
    bridgeVersion: string;
    host: unknown;
    agents: unknown[];
    allowFullAccess: boolean;
  };
  expect(hello.agents).toHaveLength(2);
  const res = await fetch(`${stack.origin}/api/bridge/enrol`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, bridgeVersion: hello.bridgeVersion, host: hello.host, agents: hello.agents, allowFullAccess: hello.allowFullAccess }),
  });
  expect(res.status).toBe(200);
  const { key } = (await res.json()) as { key: string };
  writeFileSync(join(dir, 'key'), `${key}\n`, { mode: 0o600 });
  // the same code does not work twice
  const again = await fetch(`${stack.origin}/api/bridge/enrol`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, bridgeVersion: hello.bridgeVersion, host: hello.host, agents: hello.agents, allowFullAccess: false }),
  });
  expect(again.status).toBeGreaterThanOrEqual(400);
  startBridge();

  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(row(page).getByTestId('server-state')).toHaveText('Connected', { timeout: 40_000 });
    await expect(row(page).getByTestId('server-agents')).toContainText('Claude Code');
    await expect(row(page).getByTestId('server-agents')).toContainText('Codex');
    await expect(row(page).getByTestId('server-host')).toContainText('bridge');
    // one runner per agent, named after the server
    for (const name of [`${SERVER}-claude`, `${SERVER}-codex`]) await expect(page.locator(`[data-testid="runner-row"][data-runner="${name}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="runner-row"][data-runner="${SERVER}-codex"]`).getByTestId('runner-state')).toHaveText(/Waiting for sign-in/);
    // the reach note is on the page, and no key or code is
    await expect(page.getByTestId('server-reach-note')).toContainText('Put only teams you trust together');
    await expect(page.locator('body')).not.toContainText(key);
    await expect(page.locator('body')).not.toContainText(code);
  } finally {
    await context.close();
  }
});

test('Codex is signed in from the page through the tunnel, and the runner turns Ready', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await row(page).locator('[data-agent="codex"]').getByTestId('server-agent-signin').click();
    const dialog = page.getByRole('dialog', { name: /Sign-in for Build box · Codex/ });
    await expect(dialog.getByTestId('agent-auth-status')).toContainText('Codex is not signed in.');
    await dialog.locator('[data-method="chat-gpt-device-code"]').click();
    await expect(dialog.getByTestId('agent-auth-code')).toHaveText(DEVICE_CODE);
    await expect(dialog.getByTestId('agent-auth-status')).toContainText('Codex is signed in.', { timeout: 20_000 });
    // the site learned it from the bridge's answer, then the page shows it
    await expect.poll(async () => (await stack.sql<{ status: string }>("SELECT status FROM app.bot_runners WHERE name = 'build-box-codex'"))[0]?.status, { timeout: 20_000 }).toBe('ready');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(`[data-testid="runner-row"][data-runner="${SERVER}-codex"]`).getByTestId('runner-state')).toHaveText(/Ready/, { timeout: 20_000 });
    // the sign-in landed in the bridge's own folder, not in a home
    expect(existsSync(join(dir, 'srv', 'auth', 'codex'))).toBe(true);
  } finally {
    await context.close();
  }
});

test('Rotate key gives the server a new key over its open connection, and it stays connected', async ({ browser, playwright }) => {
  const before = readFileSync(join(dir, 'key'), 'utf8').trim();
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await row(page).getByTestId('server-rotate').click();
    const dialog = page.getByRole('dialog', { name: 'Change this server’s key' });
    await expect(dialog).toContainText('Build box');
    await dialog.getByTestId('server-confirm-go').click();
    await expect(page.getByTestId('server-status')).toContainText('Build box has a new key.');
    // the bridge wrote the new key in its state folder (it wins over the installer's file) and reconnected with it
    await expect.poll(() => (existsSync(join(dir, 'state', 'key')) ? readFileSync(join(dir, 'state', 'key'), 'utf8').trim() : ''), { timeout: 20_000 }).toMatch(/^mtb_[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'state', 'key'), 'utf8').trim()).not.toBe(before);
    await expect(row(page).getByTestId('server-state')).toHaveText('Connected', { timeout: 40_000 });
    expect(bridgeLog).not.toContain(before);
  } finally {
    await context.close();
  }
});

test('a member cannot reach the routes, and the add dialog fits a phone', async ({ browser, playwright }) => {
  const member = await apiOn(playwright, stack, 'nadia');
  try {
    expect(await member.status('GET', '/api/admin/bot-servers')).toBe(403);
    expect(await member.status('POST', '/api/admin/bot-servers', { name: 'nope', label: 'Nope' })).toBe(403);
  } finally {
    await member.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH, { viewport: PHONE });
  try {
    await section(page).getByTestId('server-add').click();
    await expect(page.getByRole('dialog', { name: 'Add a server' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('Remove server cuts the connection and deletes its runners', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await row(page).getByTestId('server-remove').click();
    const dialog = page.getByRole('dialog', { name: 'Remove this server' });
    await expect(dialog).toContainText('--uninstall');
    await dialog.getByTestId('server-confirm-go').click();
    await expect(page.getByTestId('server-status')).toContainText('Build box was removed.');
    await expect(row(page)).toHaveCount(0);
    await expect(page.locator(`[data-testid="runner-row"][data-runner="${SERVER}-codex"]`)).toHaveCount(0);
    const rows = await stack.sql<{ n: string }>("SELECT count(*)::text AS n FROM app.bot_runners WHERE name LIKE 'build-box-%'");
    expect(rows[0]?.n).toBe('0');
    // the old key is refused from now on: the bridge says so in its log and does not keep hammering
    await expect.poll(() => bridgeLog, { timeout: 20_000 }).toMatch(/refus|1008|key/i);
  } finally {
    await context.close();
  }
});
