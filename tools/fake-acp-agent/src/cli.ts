import { createInterface } from 'node:readline';
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
  const lines = createInterface({ input: process.stdin });
  const iterator = lines[Symbol.asyncIterator]();
  const code = await runTerminalAuth(argv.slice(cliAt + 1), script, {
    write: (text) => void process.stdout.write(text),
    readLine: async () => {
      const next = await iterator.next();
      return next.done ? null : next.value;
    },
  });
  lines.close();
  process.exit(code);
} else {
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const fake = createFakeAcpAgent(script);
  const connection = fake.app.connect(stream);
  await connection.closed;
}
