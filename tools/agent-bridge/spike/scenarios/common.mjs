import { readFileSync } from 'node:fs';
import { AcpAgent, Recorder, makeSanitiser } from '../acp-probe.mjs';
// The scratch folder: the adapters are installed in it (npm i --save-exact, see docs/spikes/acp-measured.md), and so are the Hermes home and the work folder.
export const SPIKE = process.env.ACP_SPIKE_DIR ?? '/tmp/claude-0/acp-spike';
export const WORK = `${SPIKE}/work`;
export const FIX = new URL('../../test/fixtures/acp', import.meta.url).pathname;
const secrets = [];
try {
  for (const l of readFileSync(`${SPIKE}/hermes-home/.env`, 'utf8').split('\n')) if (l.startsWith('LITELLM_API_KEY=')) secrets.push(l.split('=', 2)[1].trim());
} catch {
  // no Hermes home yet: nothing to redact
}
export const MCP_TOKEN = 'spike-fake-token-0123456789abcdef';
secrets.push(MCP_TOKEN);
export const sanitise = makeSanitiser({
  secrets,
  replacements: [
    [WORK, '<cwd>'],
    [SPIKE, '<spike>'],
    [`${process.env.HOME}/.local/bin`, '<bin>'],
    [process.env.HOME, '<home>'],
  ],
});
const baseEnv = () => {
  const e = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'USER', 'SHELL']) if (process.env[k]) e[k] = process.env[k];
  return e;
};
export const AGENTS = {
  hermes: { cmd: 'hermes', args: ['acp'], env: () => ({ ...baseEnv(), HERMES_HOME: `${SPIKE}/hermes-home` }) },
  claude: {
    cmd: process.execPath,
    args: [`${SPIKE}/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`],
    env: () => ({ ...baseEnv(), CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE ?? `${process.env.HOME}/.local/bin/claude` }),
  },
  codex: {
    cmd: process.execPath,
    args: [`${SPIKE}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`],
    env: () => ({ ...baseEnv(), CODEX_PATH: process.env.CODEX_PATH ?? `${process.env.HOME}/.local/bin/codex` }),
  },
};
export function open(agent, scenario, { onRequest, cwd = WORK, extraEnv = {} } = {}) {
  const a = AGENTS[agent];
  const rec = new Recorder(`${FIX}/${agent}-${scenario}.jsonl`, sanitise);
  return new AcpAgent({ name: agent, cmd: a.cmd, args: a.args, env: { ...a.env(), ...extraEnv }, cwd, recorder: rec, onRequest });
}
