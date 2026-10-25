import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastLine, redact } from '../process.ts';
import { sessionUuid } from '../sessions.ts';
import type { Driver, DriverJob, DriverResult, Usage } from './types.ts';

// The Claude Code driver: one `claude -p` process per run (flags checked against Claude Code 2.1.310's `--help`).
//
//   claude -p --output-format stream-json --verbose --strict-mcp-config
//          [--mcp-config <runDir>/mcp.json] [--append-system-prompt-file <runDir>/instructions.md]
//          --tools <built-ins the bot may use> [--allowedTools <the same, plus the manythreads MCP tools>]
//          [--model m] [--effort e] (--session-id <uuid> | --resume <uuid> | --no-session-persistence)
//
// The prompt goes to stdin. Permissions stay in the default mode: a tool that is not pre-approved is refused (nobody is there to
// answer), and the bypass flags are never passed.

export const MCP_SERVER_NAME = 'manythreads';
const MCP_ALLOW = `mcp__${MCP_SERVER_NAME}__*`;

const TOOL_GROUPS: Record<string, string[]> = {
  files: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit'],
  shell: ['Bash'],
  web: ['WebFetch', 'WebSearch'],
  'web-search': ['WebFetch', 'WebSearch'],
  browser: [],
  vision: [],
};

/** The run's tool grants as Claude Code's `--tools` (what exists) and `--allowedTools` (what needs no question). */
export function claudeToolFlags(grants: readonly string[], extraAllowed: readonly string[] = []): { tools: string[]; allowed: string[] } {
  const tools: string[] = [];
  for (const g of grants) for (const t of (Object.hasOwn(TOOL_GROUPS, g) ? TOOL_GROUPS[g] : undefined) ?? []) if (!tools.includes(t)) tools.push(t);
  const allowed = [...tools];
  for (const extra of extraAllowed) {
    const base = extra.split('(')[0]!.trim();
    if (base !== '' && !tools.includes(base) && !base.startsWith('mcp__')) tools.push(base);
    if (!allowed.includes(extra)) allowed.push(extra);
  }
  allowed.push(MCP_ALLOW);
  return { tools, allowed };
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function claudeArgs(job: DriverJob, mode: 'new' | 'resume' | 'none', uuid: string | null, files: { mcp: string | null; instructions: string | null }): string[] {
  const mt = job.request.manythreads;
  const { tools, allowed } = claudeToolFlags(mt.tools, job.profile.extraAllowedTools);
  // `--restricted`: the user's, project's and local settings files are ignored (so the operator's own CLAUDE.md, memory and hooks never reach a
  // bot), file tools stay inside the working directory, and bypassing permissions is refused. Only the tools `--tools` names are available.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config'];
  if (files.mcp !== null) args.push('--mcp-config', files.mcp);
  if (files.instructions !== null) args.push('--append-system-prompt-file', files.instructions);
  args.push('--tools', tools.join(','));
  args.push('--allowedTools', allowed.join(','));
  const alias = mt.model.alias;
  const mapped = alias !== null && job.profile.modelAliases && Object.hasOwn(job.profile.modelAliases, alias) ? job.profile.modelAliases[alias] : undefined;
  const model = mapped ?? job.profile.model;
  if (model !== undefined) args.push('--model', model);
  if (mt.model.effort !== null && EFFORTS.has(mt.model.effort)) args.push('--effort', mt.model.effort);
  if (mode === 'new' && uuid !== null) args.push('--session-id', uuid);
  else if (mode === 'resume' && uuid !== null) args.push('--resume', uuid);
  else args.push('--no-session-persistence');
  return args;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function preview(input: unknown, secrets: readonly string[]): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? '';
  } catch {
    text = '';
  }
  return redact(text, secrets).slice(0, 200);
}

function usageOf(raw: unknown): Usage | null {
  if (!isRecord(raw)) return null;
  // Cache reads and writes are input the model was billed for, so they count as input.
  const input = num(raw['input_tokens']) + num(raw['cache_creation_input_tokens']) + num(raw['cache_read_input_tokens']);
  const output = num(raw['output_tokens']);
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

interface Attempt {
  result: DriverResult | null;
  missingSession: boolean;
  sessionInUse: boolean;
  emitted: boolean;
  exited: { code: number | null; spawnError: string | null };
}

function writeFile0600(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function attempt(job: DriverJob, mode: 'new' | 'resume' | 'none', uuid: string | null, files: { mcp: string | null; instructions: string | null }, token: string | null): Promise<Attempt> {
  const secrets = token === null ? [] : [token];
  const args = claudeArgs(job, mode, uuid, files);
  const env = job.baseEnv();
  if (token !== null && !job.config.mcpTokenInFile) env['MANYTHREADS_RUN_TOKEN'] = token;

  const out: Attempt = { result: null, missingSession: false, sessionInUse: false, emitted: false, exited: { code: null, spawnError: null } };
  const open = new Map<string, { name: string; at: number }>();
  const texts: string[] = [];
  let turns = 0;
  const maxTurns = job.request.manythreads.maxTurns;

  const onLine = (line: string): void => {
    const t = line.trim();
    if (t === '' || t[0] !== '{') return;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    const content = isRecord(msg['message']) && Array.isArray(msg['message']['content']) ? (msg['message']['content'] as unknown[]) : [];
    switch (msg['type']) {
      case 'system':
        if (msg['subtype'] === 'init' && uuid !== null) job.sessions.set(`claude:${uuid}`, new Date().toISOString());
        break;
      case 'assistant': {
        turns += 1;
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
            texts.push(block['text']);
            out.emitted = true;
            job.emit('message.delta', { delta: redact(block['text'], secrets) });
          } else if (block['type'] === 'tool_use') {
            const name = typeof block['name'] === 'string' ? block['name'] : 'tool';
            if (typeof block['id'] === 'string') open.set(block['id'], { name, at: Date.now() });
            out.emitted = true;
            job.emit('tool.started', { tool: name, preview: preview(block['input'], secrets) });
          }
        }
        // Claude Code 2.1.310 has no `--max-turns`, so the bridge counts the model's turns itself.
        if (maxTurns !== null && turns > maxTurns) job.abort('turn limit exceeded');
        break;
      }
      case 'user':
        for (const block of content) {
          if (!isRecord(block) || block['type'] !== 'tool_result') continue;
          const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '';
          const started = open.get(id);
          open.delete(id);
          out.emitted = true;
          job.emit('tool.completed', { tool: started?.name ?? 'tool', duration: started ? (Date.now() - started.at) / 1000 : 0, error: block['is_error'] === true });
        }
        break;
      case 'result': {
        const text = typeof msg['result'] === 'string' ? msg['result'] : '';
        const failed = msg['is_error'] === true || (typeof msg['subtype'] === 'string' && msg['subtype'] !== 'success');
        if (failed) {
          if (/no conversation found/i.test(text)) out.missingSession = true;
          else if (/already in use/i.test(text)) out.sessionInUse = true;
          const why = redact(text, secrets).replace(/\s+/g, ' ').trim().slice(0, 300);
          out.result = { ok: false, error: why !== '' ? why : `Claude Code ended with ${String(msg['subtype'] ?? 'an error')}` };
        } else {
          out.result = { ok: true, output: redact((text.trim() !== '' ? text : texts.join('')).trim(), secrets), usage: usageOf(msg['usage']) };
        }
        break;
      }
      default:
    }
  };

  const child = job.start(job.config.bin.claude, args, { cwd: job.profile.workdir, env, stdin: job.request.input, onLine });
  const end = await child.done;
  out.exited = { code: end.code, spawnError: end.spawnError };
  if (out.result === null && !job.stopped()) {
    if (/no conversation found/i.test(end.stderrTail)) out.missingSession = true;
    else if (/already in use/i.test(end.stderrTail)) out.sessionInUse = true;
    if (end.spawnError !== null) out.result = { ok: false, error: `could not start "${job.config.bin.claude}" (${end.spawnError})` };
    else {
      const why = lastLine(end.stderrTail, secrets);
      out.result = { ok: false, error: why !== '' ? why : `Claude Code exited with code ${String(end.code ?? end.signal)} and no result` };
    }
  }
  return out;
}

export const claudeCodeDriver: Driver = {
  async run(job): Promise<DriverResult> {
    const mt = job.request.manythreads;
    const instructionsPath = job.request.instructions !== null ? join(job.runDir, 'instructions.md') : null;
    if (instructionsPath !== null && job.request.instructions !== null) writeFile0600(instructionsPath, job.request.instructions);

    let mcpPath: string | null = null;
    const token = mt.mcp?.token ?? null;
    if (mt.mcp !== null) {
      mcpPath = join(job.runDir, 'mcp.json');
      // The default keeps the token out of the file: Claude Code expands `${MANYTHREADS_RUN_TOKEN}` from the child's environment.
      const bearer = job.config.mcpTokenInFile ? mt.mcp.token : '${MANYTHREADS_RUN_TOKEN}';
      const config = { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mt.mcp.url, headers: { Authorization: `Bearer ${bearer}` } } } };
      writeFile0600(mcpPath, JSON.stringify(config));
    }
    const files = { mcp: mcpPath, instructions: instructionsPath };

    if (job.request.sessionId === null) {
      return (await attempt(job, 'none', null, files, token)).result ?? { ok: false, error: 'no result' };
    }
    const uuid = sessionUuid(job.profileName, job.request.sessionId);
    const key = `claude:${uuid}`;
    let mode: 'new' | 'resume' = job.sessions.has(key) ? 'resume' : 'new';
    let a = await attempt(job, mode, uuid, files, token);
    // One retry when our record and Claude Code's own disk disagree (sessions deleted, or state lost).
    if (a.result?.ok !== true && !job.stopped() && !a.emitted && ((mode === 'resume' && a.missingSession) || (mode === 'new' && a.sessionInUse))) {
      if (mode === 'resume') job.sessions.delete(key);
      mode = mode === 'resume' ? 'new' : 'resume';
      a = await attempt(job, mode, uuid, files, token);
    }
    if (a.result?.ok === true) job.sessions.set(key, new Date().toISOString());
    return a.result ?? { ok: false, error: 'no result' };
  },
};
