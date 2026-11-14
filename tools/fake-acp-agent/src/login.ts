import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeScript } from './script.ts';

/*
 * The adapter's terminal sign-in program (`--cli auth login --claudeai`), as measured against the real one (docs/spikes/acp-measured.md, "Sign-in and sign-out"):
 *  - the page is printed as an OSC 8 hyperlink: `ESC]8;;URL` (no string terminator: the next escape ends it), the URL in blue, then `ESC]8;;BEL`, then a line end;
 *  - the prompt "Paste code here if prompted > " has no line end, the terminal is in raw mode (no echo; a line feed and a carriage return both submit);
 *  - one wrong code ends the program with "Login failed: That code wasn't accepted. ..." and exit code 1 (the real program does not ask twice);
 *  - nothing is written to a sign-in file until a code is accepted.
 * It shares the sign-in with the fake agent through `stateDir/auth.json`, and writes its own process number to `stateDir/pids/login.pid` (a test checks it is gone after a cancel).
 */

export interface TerminalIo {
  write(text: string): void;
  /** One line typed or pasted by the person; `null` at end of input. */
  readLine(): Promise<string | null>;
  /** Waits (the URL printed in pieces). */
  sleep?(ms: number): Promise<void>;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** The code a script accepts: `auth.code` exactly, else any code that looks like the real one (`<random>#<state>`). */
const codeFits = (script: FakeScript, code: string): boolean => {
  const want = script.auth?.code;
  return want !== undefined ? code === want : /^[A-Za-z0-9_-]{8,}#[A-Za-z0-9_-]{3,}$/.test(code);
};

/** Records this process's number under the state folder. */
export function writePid(stateDir: string | undefined, name: string): void {
  if (!stateDir) return;
  mkdirSync(join(stateDir, 'pids'), { recursive: true });
  writeFileSync(join(stateDir, 'pids', `${name}.pid`), String(process.pid));
  // The sign-in folder this process was told about (a test checks a profile's own folder reaches the program).
  writeFileSync(join(stateDir, 'pids', `${name}.home`), process.env['CLAUDE_CONFIG_DIR'] ?? process.env['CODEX_HOME'] ?? '');
}

/** Returns the exit code. `args` are what follows `--cli`: `auth login --claudeai`, `auth login --console` or `auth logout`. */
export async function runTerminalAuth(args: string[], script: FakeScript, io: TerminalIo): Promise<number> {
  const stateDir = script.stateDir;
  const authFile = stateDir ? join(stateDir, 'auth.json') : null;
  if (args[0] !== 'auth') {
    io.write(`Unknown command: ${args.join(' ')}\n`);
    return 2;
  }
  writePid(stateDir, args[1] === 'logout' ? 'logout' : 'login');
  if (args[1] === 'logout') {
    if (script.faults?.logoutFails === true) {
      io.write('Logout failed: could not remove the sign-in of person@example.test (token sk-ant-oat01-FAKEFAKEFAKEFAKE)\n'); // secret-scan:ignore a made-up fixture
      return 1;
    }
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
  io.write("Opening browser to sign in…\nIf the browser didn't open, visit: ");
  // The real program wraps the address in a hyperlink: the address once inside the escape, once as the visible text.
  const pieces = script.auth?.urlSplitMs !== undefined && io.sleep ? [url.slice(0, Math.ceil(url.length / 3)), url.slice(Math.ceil(url.length / 3), Math.ceil((2 * url.length) / 3)), url.slice(Math.ceil((2 * url.length) / 3))] : [url];
  io.write(`${ESC}]8;;${url}${ESC}[94m`);
  for (let i = 0; i < pieces.length; i += 1) {
    if (i > 0 && io.sleep) await io.sleep(script.auth?.urlSplitMs ?? 0);
    io.write(pieces[i] as string);
  }
  io.write(`${ESC}[39m${ESC}]8;;${BEL}\n`);
  io.write('Paste code here if prompted > ');
  const code = (await io.readLine())?.trim();
  if (!code) {
    io.write('\nLogin cancelled.\n');
    return 1;
  }
  if (script.auth?.hangAfterCode === true) await new Promise<never>(() => undefined);
  if (!codeFits(script, code)) {
    // The real program says this and ends; some terminals echo what was typed, so this one repeats the code too, and names an account: the bridge must show neither.
    io.write(`\nLogin failed: That code wasn't accepted (${code}) for person@example.test, token sk-ant-oat01-FAKEFAKEFAKEFAKE. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n`); // secret-scan:ignore a made-up fixture
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
