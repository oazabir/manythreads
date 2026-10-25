import {
  CreateHermesConnectionRequest,
  UpdateHermesConnectionRequest,
  type BotSummary,
  type HermesConnection,
  type HermesConnectionAgent,
} from '@manythreads/shared';

/** The words a lead sees for each agent, and the one line that tells them apart. */
export const AGENT_CHOICES: ReadonlyArray<{ id: HermesConnectionAgent; label: string; hint: string }> = [
  { id: 'hermes', label: 'Hermes gateway', hint: 'A Hermes server you run. Each bot is one profile on it, and Hermes keeps its own models and tools.' },
  { id: 'claude-code', label: 'Claude Code CLI', hint: 'The Claude Code command-line tool, started fresh for every run by a small bridge program on your machine.' },
  { id: 'codex', label: 'Codex CLI', hint: 'The Codex command-line tool, started fresh for every run by the same bridge program.' },
];

export const agentLabel = (a: HermesConnectionAgent): string => AGENT_CHOICES.find((c) => c.id === a)?.label ?? a;
export const kindLabel = (k: HermesConnection['kind']): string => (k === 'managed' ? 'Team pod' : 'Your own');

/** The bots whose BOT.md places them on this connection (`placement.gateway.connection`). Bots with no gateway placement are left out. */
export function botsOnConnection(bots: ReadonlyArray<BotSummary>, name: string): BotSummary[] {
  return bots.filter((b) => b.placement?.gateway?.connection === name);
}

/** Status in a sentence, from the last check. */
export function statusLine(c: Pick<HermesConnection, 'status' | 'lastCheckedAt' | 'lastError'>): string {
  if (c.status === 'unknown') return 'Not checked yet';
  return c.status === 'ok' ? 'Working' : 'Not working';
}

export type FormValues = { name: string; agent: HermesConnectionAgent; baseUrl: string; apiKey: string };
export type FormErrors = Partial<Record<'name' | 'baseUrl' | 'apiKey', string>>;

const firstIssues = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): FormErrors => {
  const out: FormErrors = {};
  for (const i of issues) {
    const k = i.path[0];
    if ((k === 'name' || k === 'baseUrl' || k === 'apiKey') && !out[k]) out[k] = i.message;
  }
  return out;
};

const FRIENDLY: Record<keyof FormErrors, string> = {
  name: 'Use lowercase letters, digits, ".", "_" or "-", and not "managed" (that name is the team pod).',
  baseUrl: 'Enter a web address starting with http:// or https://, with no password, query or # part.',
  apiKey: 'The key must be at least 8 characters.',
};

/** Check the add form with the server's own schema, so the page never accepts what the server would refuse. */
export function validateNew(v: FormValues): { ok: true; body: CreateHermesConnectionRequest } | { ok: false; errors: FormErrors } {
  const r = CreateHermesConnectionRequest.safeParse({ name: v.name.trim(), baseUrl: v.baseUrl.trim(), apiKey: v.apiKey, agent: v.agent });
  if (r.success) return { ok: true, body: r.data };
  const raw = firstIssues(r.error.issues);
  const errors: FormErrors = {};
  for (const k of Object.keys(raw) as Array<keyof FormErrors>) errors[k] = FRIENDLY[k];
  return { ok: false, errors };
}

/** Only what changed is sent. An empty key box keeps the stored key. */
export function validateEdit(current: Pick<HermesConnection, 'baseUrl' | 'agent'>, v: Omit<FormValues, 'name'>): { ok: true; body: UpdateHermesConnectionRequest; changed: boolean } | { ok: false; errors: FormErrors } {
  const draft: Record<string, string> = {};
  if (v.baseUrl.trim() !== (current.baseUrl ?? '')) draft['baseUrl'] = v.baseUrl.trim();
  if (v.apiKey !== '') draft['apiKey'] = v.apiKey;
  if (v.agent !== current.agent) draft['agent'] = v.agent;
  const r = UpdateHermesConnectionRequest.safeParse(draft);
  if (!r.success) {
    const raw = firstIssues(r.error.issues);
    const errors: FormErrors = {};
    for (const k of Object.keys(raw) as Array<keyof FormErrors>) errors[k] = FRIENDLY[k];
    return { ok: false, errors };
  }
  return { ok: true, body: r.data, changed: Object.keys(draft).length > 0 };
}

/** Switching a connection from Hermes to a command-line agent: the confirm text to show first, or null when nothing needs confirming. */
export function bridgeSwitchWarning(from: HermesConnectionAgent, to: HermesConnectionAgent, baseUrl: string): string | null {
  if (from !== 'hermes' || (to !== 'claude-code' && to !== 'codex')) return null;
  const where = baseUrl.trim() === '' ? 'the address' : baseUrl.trim();
  return `From now on ${where} receives a one-run MCP token (a key that lets the agent call the platform's tools for that run) with every run. It must be the agent bridge you run yourself, not a Hermes server or anything else.`;
}

/** The one address every agent's tools point at. */
export const mcpAddress = (origin: string): string => `${origin.replace(/\/+$/, '')}/mcp`;

/** The `mcp_servers:` block for one Hermes profile. The token is read from an environment variable, never pasted into the file. */
export function hermesProfileYaml(origin: string): string {
  return [
    'mcp_servers:',
    '  manythreads:',
    `    url: "${mcpAddress(origin)}"`,
    '    headers:',
    '      Authorization: "Bearer ${MANYTHREADS_MCP_TOKEN}"',
  ].join('\n');
}

export const BRIDGE_CONFIG = '{"profiles":{"default":{"agent":"claude-code","workdir":"/srv/bots"}}}';

export function bridgeCommand(listen: string): string {
  return `tsx tools/agent-bridge/src/main.ts --config bridge.json --listen ${listen}`;
}
