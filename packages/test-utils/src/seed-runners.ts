import type { TestDatabase } from './db.ts';

/**
 * Seed v19 (PLAN P19-11, Bundle E decision E11): a populated Runners page with no real sign-in. OPT-IN: nothing calls this from `seedWorld`; only the e2e stack
 * with `MANYTHREADS_STACK_SEED=runners` (e2e/fixtures/stack-server.ts) runs it, so every other stack and baseline stays as it was.
 *
 * STUB (Bundle E WP-0): the signature is the contract the stack hook calls; WP-R2 fills the body. It will make, through the real routes of the running server,
 * five runners (a host Hermes gateway, a team pod, a Claude runner shared by Engineering and Marketing, a Claude runner for Customer support with another made-up
 * login, an LLM gateway runner on alias `fast`), one bot placed on each, and a Codex runner waiting for sign-in. Sign-in files are made-up shapes with canary
 * strings, never a real login.
 */
export interface SeedRunnersOptions {
  /** The running server's address (the stack's API port, not the front). */
  url: string;
  db: TestDatabase;
  log?: (line: string) => void;
}

export interface SeedRunnersResult {
  /** The runners made, by their short key (`host`, `teamPod`, `claudeShared`, `claudeSupport`, `gateway`, `codex`). Empty until WP-R2 fills the seed. */
  runners: Record<string, { id: string; name: string }>;
}

export async function seedRunners(options: SeedRunnersOptions): Promise<SeedRunnersResult> {
  options.log?.('not built yet (WP-R2): no runners made');
  return { runners: {} };
}
