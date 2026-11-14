import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeScript } from './script.ts';

/*
 * The adapter's terminal sign-in program (`--cli auth login --claudeai`), as measured under a pseudo-terminal: it prints the page to
 * open and a prompt, waits for the pasted code, then signs in. It shares the sign-in with the fake agent through `stateDir/auth.json`.
 */

export interface TerminalIo {
  write(text: string): void;
  /** One line typed or pasted by the person; `null` at end of input. */
  readLine(): Promise<string | null>;
}

/** Returns the exit code. `args` are what follows `--cli`: `auth login --claudeai`, `auth login --console` or `auth logout`. */
export async function runTerminalAuth(args: string[], script: FakeScript, io: TerminalIo): Promise<number> {
  const stateDir = script.stateDir;
  const authFile = stateDir ? join(stateDir, 'auth.json') : null;
  if (args[0] !== 'auth') {
    io.write(`Unknown command: ${args.join(' ')}\n`);
    return 2;
  }
  if (args[1] === 'logout') {
    if (authFile) {
      mkdirSync(stateDir as string, { recursive: true });
      writeFileSync(authFile, JSON.stringify({ signedIn: false, kind: 'none' }));
    }
    io.write('Logged out.\n');
    return 0;
  }
  if (args[1] !== 'login') {
    io.write(`Unknown command: ${args.join(' ')}\n`);
    return 2;
  }
  const url = script.auth?.url ?? 'https://claude.example.test/cai/oauth/authorize?code=true&client_id=fake';
  io.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\n`);
  io.write('Paste code here if prompted > ');
  const code = (await io.readLine())?.trim();
  if (!code) {
    io.write('\nLogin cancelled.\n');
    return 1;
  }
  if (authFile) {
    mkdirSync(stateDir as string, { recursive: true });
    writeFileSync(authFile, JSON.stringify({ signedIn: true, kind: 'account' }));
  }
  io.write('\nLogin successful.\n');
  return 0;
}

/** Removes the stored sign-in (a test's clean-up). */
export function forgetSignIn(stateDir: string): void {
  rmSync(join(stateDir, 'auth.json'), { force: true });
}
