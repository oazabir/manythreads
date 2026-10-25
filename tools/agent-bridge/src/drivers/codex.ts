import { createHash } from 'node:crypto';
import { lastLine, redact } from '../process.ts';
import type { Driver, DriverJob, DriverResult, Usage } from './types.ts';

// The Codex driver: one `codex exec --json` process per run. NOT TESTED AGAINST A REAL CODEX INSTALL: the flags and config keys come from
// OpenAI's published Codex documentation (non-interactive mode, config reference, MCP page); the tests use a fake `codex` that prints
// the documented JSON lines.
//
//   codex exec --json --skip-git-repo-check -C <workdir> -c sandbox_mode="…" -c approval_policy="never"
//          [-c developer_instructions="…"] [-c mcp_servers.manythreads.url="…"]
//          [-c mcp_servers.manythreads.bearer_token_env_var="MANYTHREADS_RUN_TOKEN"] [-m model] -
//   codex exec resume --json … <thread id> -
//
// The prompt goes to stdin (`-`). The token goes only in the child's environment. A run with a files or shell grant gets
// `workspace-write`; any other run is `read-only`.

const MCP_NAME = 'manythreads';
/** Longer instructions than this are put before the prompt instead of in an argument (the OS limits argument sizes). */
const MAX_ARG_INSTRUCTIONS = 4 * 1024;

/** A TOML basic string: quotes, backslashes and control characters escaped, lone surrogates replaced by U+FFFD. */
export function toml(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
      out += s[i]! + s[i + 1]!;
      i += 1;
    } else if (c >= 0xd800 && c <= 0xdfff) out += '\\uFFFD';
    else if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0').toUpperCase()}`;
    else out += s[i]!;
  }
  return `${out}"`;
}

export function codexArgs(job: DriverJob, resumeId: string | null, instructionsInArg: boolean): string[] {
  const mt = job.request.manythreads;
  const writable = mt.tools.includes('files') || mt.tools.includes('shell');
  const args = ['exec'];
  if (resumeId !== null) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (resumeId === null) args.push('-C', job.profile.workdir);
  args.push('-c', `sandbox_mode=${toml(writable ? 'workspace-write' : 'read-only')}`, '-c', `approval_policy=${toml('never')}`);
  if (instructionsInArg && job.request.instructions !== null) args.push('-c', `developer_instructions=${toml(job.request.instructions)}`);
  if (mt.mcp !== null) {
    args.push('-c', `mcp_servers.${MCP_NAME}.url=${toml(mt.mcp.url)}`, '-c', `mcp_servers.${MCP_NAME}.bearer_token_env_var=${toml('MANYTHREADS_RUN_TOKEN')}`);
  }
  const alias = mt.model.alias;
  const mapped = alias !== null && job.profile.modelAliases && Object.hasOwn(job.profile.modelAliases, alias) ? job.profile.modelAliases[alias] : undefined;
  const model = mapped ?? job.profile.model;
  if (model !== undefined) args.push('-m', model);
  if (resumeId !== null) args.push(resumeId);
  args.push('-');
  return args;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toolOf(item: Record<string, unknown>): { name: string; preview: string } | null {
  switch (item['type']) {
    case 'command_execution':
      return { name: 'shell', preview: str(item['command']) };
    case 'mcp_tool_call':
      return { name: `mcp__${str(item['server']) || 'mcp'}__${str(item['tool']) || 'tool'}`, preview: '' };
    case 'file_change':
      return { name: 'file_change', preview: '' };
    case 'web_search':
      return { name: 'web_search', preview: str(item['query']) };
    default:
      return null;
  }
}

function itemFailed(item: Record<string, unknown>): boolean {
  if (item['status'] === 'failed') return true;
  if (item['type'] === 'command_execution' && typeof item['exit_code'] === 'number' && item['exit_code'] !== 0) return true;
  return item['error'] !== undefined && item['error'] !== null;
}

interface Attempt {
  result: DriverResult | null;
  threadId: string | null;
  emitted: boolean;
}

async function attempt(job: DriverJob, resumeId: string | null, token: string | null): Promise<Attempt> {
  const secrets = token === null ? [] : [token];
  const instr = job.request.instructions;
  const inArg = instr === null || instr.length <= MAX_ARG_INSTRUCTIONS;
  const prompt = !inArg && instr !== null ? `${instr}\n\n---\n\n${job.request.input}` : job.request.input;
  const env = job.baseEnv();
  if (token !== null) env['MANYTHREADS_RUN_TOKEN'] = token;

  const out: Attempt = { result: null, threadId: null, emitted: false };
  const open = new Map<string, { name: string; at: number }>();
  let lastMessage = '';
  let usage: Usage | null = null;
  let failure: string | null = null;

  const startTool = (id: string, item: Record<string, unknown>): void => {
    const tool = toolOf(item);
    if (!tool || open.has(id)) return;
    open.set(id, { name: tool.name, at: Date.now() });
    out.emitted = true;
    job.emit('tool.started', { tool: tool.name, preview: redact(tool.preview, secrets).slice(0, 200) });
  };

  const onLine = (line: string): void => {
    const t = line.trim();
    if (t === '' || t[0] !== '{') return;
    let ev: unknown;
    try {
      ev = JSON.parse(t);
    } catch {
      return;
    }
    if (!isRecord(ev)) return;
    switch (ev['type']) {
      case 'thread.started':
        if (typeof ev['thread_id'] === 'string') {
          out.threadId = ev['thread_id'];
          if (job.request.sessionId !== null) job.sessions.set(sessionKey(job), ev['thread_id']);
        }
        break;
      case 'item.started':
      case 'item.updated':
        if (isRecord(ev['item'])) startTool(str(ev['item']['id']), ev['item']);
        break;
      case 'item.completed': {
        const item = ev['item'];
        if (!isRecord(item)) break;
        if (item['type'] === 'agent_message') {
          const text = str(item['text']);
          if (text !== '') {
            lastMessage = text;
            out.emitted = true;
            job.emit('message.delta', { delta: redact(text, secrets) });
          }
          break;
        }
        const id = str(item['id']);
        startTool(id, item);
        const started = open.get(id);
        if (started) {
          open.delete(id);
          job.emit('tool.completed', { tool: started.name, duration: (Date.now() - started.at) / 1000, error: itemFailed(item) });
        }
        break;
      }
      case 'turn.completed': {
        const u = ev['usage'];
        if (isRecord(u)) {
          const input = num(u['input_tokens']);
          const output = num(u['output_tokens']);
          usage = { input_tokens: input, output_tokens: output, total_tokens: input + output };
        }
        break;
      }
      case 'turn.failed':
        failure = redact(isRecord(ev['error']) ? str(ev['error']['message']) : 'the turn failed', secrets).slice(0, 300);
        break;
      case 'error':
        failure ??= redact(str(ev['message']), secrets).slice(0, 300);
        break;
      default:
    }
  };

  const child = job.start(job.config.bin.codex, codexArgs(job, resumeId, inArg), { cwd: job.profile.workdir, env, stdin: prompt, onLine });
  const end = await child.done;
  if (end.spawnError !== null) out.result = { ok: false, error: `could not start "${job.config.bin.codex}" (${end.spawnError})` };
  else if (failure !== null) out.result = { ok: false, error: failure };
  else if (end.code === 0 && usage !== null) out.result = { ok: true, output: redact(lastMessage.trim(), secrets), usage };
  else if (end.code === 0) out.result = { ok: true, output: redact(lastMessage.trim(), secrets), usage: null };
  else {
    const why = lastLine(end.stderrTail, secrets);
    out.result = { ok: false, error: why !== '' ? why : `Codex exited with code ${String(end.code ?? end.signal)}` };
  }
  return out;
}

function sessionKey(job: DriverJob): string {
  return `codex:${createHash('sha1').update(`${job.profileName}\0${job.request.sessionId ?? ''}`).digest('hex')}`;
}

export const codexDriver: Driver = {
  async run(job): Promise<DriverResult> {
    const token = job.request.manythreads.mcp?.token ?? null;
    if (job.request.sessionId === null) return (await attempt(job, null, token)).result ?? { ok: false, error: 'no result' };
    const known = job.sessions.get(sessionKey(job));
    let a = await attempt(job, known ?? null, token);
    // A saved thread that Codex no longer has: start a new one once.
    if (known !== undefined && a.result?.ok !== true && !job.stopped() && !a.emitted) {
      job.sessions.delete(sessionKey(job));
      a = await attempt(job, null, token);
    }
    return a.result ?? { ok: false, error: 'no result' };
  },
};
