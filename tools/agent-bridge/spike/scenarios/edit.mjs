import { boot, prompt, show, textOf, state, WORK } from './lib.mjs';
const agent = process.argv[2];
const { a } = await boot(agent, 'edit', { extraEnv: agent === 'codex' ? { INITIAL_AGENT_MODE: 'workspace-write' } : {} });
const opts =
  agent === 'claude'
    ? {
        _meta: {
          claudeCode: {
            options: {
              settingSources: [],
              tools: ['Read', 'Write', 'Edit'],
              allowedTools: ['Read', 'Write', 'Edit'],
              extraArgs: { restricted: null, 'strict-mcp-config': null },
              allowDangerouslySkipPermissions: false,
            },
          },
        },
      }
    : {};
const n = await a.request('session/new', { cwd: WORK, mcpServers: [], ...opts });
const sid = n.result.sessionId;
if (agent === 'claude') await a.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'haiku' });
else await a.request('session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: 'low' });
const text =
  agent === 'claude'
    ? 'Create the file edit-me.txt containing two lines (one, two) with the Write tool, then change the line "two" to "three" with the Edit tool. Answer ok.'
    : 'Using your patch/edit tool (apply_patch, not the shell), create the file edit-me.txt with two lines (one, two), then change "two" to "three". Answer ok.';
const p = await prompt(a, sid, text);
show(p.notes, { full: true });
console.log('text:', textOf(p.notes), p.resp.result?.stopReason, p.ms, 'perms', state.permLog.length);
await a.stop();
