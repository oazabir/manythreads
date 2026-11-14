import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createFakeAcpAgent } from './agent.ts';
import { runTerminalAuth } from './login.ts';
import { loadScript } from './script.ts';

/*
 * The fake agent as a program, the way a bridge starts a real adapter: ACP over stdin and stdout, one JSON object per line.
 *
 *   tsx src/cli.ts [--script=file.json]                       the agent (script: --script, FAKE_ACP_SCRIPT, FAKE_ACP_SCRIPT_JSON, or built in)
 *   tsx src/cli.ts --cli auth login --claudeai                the terminal sign-in program (URL, then a pasted code)
 *   tsx src/cli.ts --cli auth logout
 *
 * FAKE_ACP_FLAVOR (claude | codex | hermes) and FAKE_ACP_STATE_DIR override the script's `flavor` and `stateDir`.
 */

const argv = process.argv.slice(2);
const script = loadScript(argv);
const cliAt = argv.indexOf('--cli');

if (cliAt >= 0) {
  // Like the real program: raw mode when there is a terminal (no echo, no translation of the carriage return), and a line ends at a line feed or a carriage return.
  const tty = process.stdin.isTTY === true;
  if (tty) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let pending = '';
  let ended = false;
  const waiting: Array<(line: string | null) => void> = [];
  const lines: string[] = [];
  const deliver = (): void => {
    while (waiting.length > 0 && (lines.length > 0 || ended)) (waiting.shift() as (line: string | null) => void)(lines.length > 0 ? (lines.shift() as string) : null);
  };
  process.stdin.on('data', (chunk: string) => {
    for (const ch of chunk) {
      if (ch === '\r' || ch === '\n') {
        // a CR followed by an LF (or the reverse) is one Enter: an empty line right after a line is dropped
        if (pending !== '') lines.push(pending);
        pending = '';
      } else pending += ch;
    }
    deliver();
  });
  process.stdin.on('end', () => {
    ended = true;
    deliver();
  });
  const code = await runTerminalAuth(argv.slice(cliAt + 1), script, {
    write: (text) => void process.stdout.write(text),
    readLine: () => new Promise<string | null>((resolve) => {
      waiting.push(resolve);
      deliver();
    }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  process.exit(code);
} else {
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const fake = createFakeAcpAgent(script);
  const connection = fake.app.connect(stream);
  await connection.closed;
}
