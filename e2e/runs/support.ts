import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { SEED_RUNS } from '@manythreads/test-utils';
import { parseConfig } from '../../tools/agent-bridge/src/config.ts';
import { startBridge, type Bridge } from '../../tools/agent-bridge/src/server.ts';
import type { Action } from '../../tools/fake-acp-agent/src/script.ts';
import { startRunnersWorld, type RunnersWorld } from '../runners/support.ts';

/*
 * Shared by the run card specs (PLAN P25-12): a real agent bridge in this process whose profiles start tools/fake-acp-agent (so what the platform, the bridge's ACP driver, the run's
 * record and the web client do is all real; only the agent's work is a script), and the `runs` stack (seed v25) pointed at that bridge through the test seam of claude-pods.
 */

const FAKE_CLI = join(import.meta.dirname, '..', '..', 'tools', 'fake-acp-agent', 'src', 'cli.ts');
const TSX = createRequire(import.meta.url).resolve('tsx/esm');
export const BRIDGE_KEY = 'e2e-runs-bridge-key-0001';
const PASS = ['FAKE_ACP_SCRIPT_JSON', 'FAKE_ACP_FLAVOR', 'FAKE_ACP_STATE_DIR'];

export interface RunsWorld extends RunnersWorld {
  bridge: Bridge;
  /** What the agent does in the next run: the whole of its script. */
  script(actions: Action[]): void;
  /** The bot's id and actor id. */
  bot(slug: string): Promise<{ id: string; actorId: string }>;
  close(): Promise<void>;
}

export async function startRunsWorld(): Promise<RunsWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-runs-'));
  process.env['FAKE_ACP_FLAVOR'] = 'claude';
  process.env['FAKE_ACP_STATE_DIR'] = join(dir, 'fake-state');
  const profiles: Record<string, unknown> = {};
  for (const b of SEED_RUNS.bots) {
    profiles[`${SEED_RUNS.team}--${b.slug}`] = {
      agent: 'claude-code',
      driver: 'acp',
      workdir: join(dir, 'work', b.slug),
      passEnv: PASS,
      acp: { command: process.execPath, args: ['--import', TSX, FAKE_CLI] },
    };
  }
  const config = parseConfig({ profiles, killGraceSeconds: 0.5, budgetGraceSeconds: 0.2, cancelGraceSeconds: 2 });
  const bridge = await startBridge({ config, apiKey: BRIDGE_KEY, stateDir: join(dir, 'state'), port: 0, log: () => undefined, tmpRoot: dir });
  const world = await startRunnersWorld({
    NODE_ENV: 'test',
    MANYTHREADS_STACK_SEED: 'runs',
    // the runners seed under this one (v19) places a Hermes gateway runner at this address; the allow-list keeps it valid
    MANYTHREADS_HERMES_ALLOWED_HOSTS: '127.0.0.1,192.168.50.20',
    MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL: bridge.url,
    MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY: BRIDGE_KEY,
  });
  return {
    ...world,
    bridge,
    script: (actions) => {
      process.env['FAKE_ACP_SCRIPT_JSON'] = JSON.stringify({ flavor: 'claude', scenarios: { default: actions }, default: 'default' });
    },
    bot: async (slug) => {
      const row = (await world.stack.sql<{ id: string; actor: string }>(`SELECT b.id, a.id AS actor FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.slug = $1`, [slug]))[0];
      expect(row, `the bot ${slug}`).toBeTruthy();
      return { id: row!.id, actorId: row!.actor };
    },
    close: async () => {
      for (const k of PASS) delete process.env[k];
      await world.stop();
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The words of one run card or one folded line, for a message when an assertion fails. */
export async function cardText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="run-card"], [data-testid="run-end"]').allInnerTexts()).join(' | ');
}
