// The body of `POST /runs`, checked by hand (the bridge uses Node's built-ins only).

export interface RunRequest {
  input: string;
  sessionId: string | null;
  instructions: string | null;
  manythreads: {
    bot: string | null;
    runId: string | null;
    mcp: { url: string; token: string } | null;
    tools: string[];
    model: { alias: string | null; effort: string | null };
    budgetSeconds: number | null;
    maxTurns: number | null;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const optNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export function parseRunRequest(body: unknown): { ok: true; value: RunRequest } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'the body must be a JSON object' };
  if (typeof body['input'] !== 'string' || body['input'].trim() === '') return { ok: false, error: '"input" must be a non-empty string' };
  if (body['session_id'] !== undefined && body['session_id'] !== null && typeof body['session_id'] !== 'string') return { ok: false, error: '"session_id" must be a string' };
  if (body['instructions'] !== undefined && body['instructions'] !== null && typeof body['instructions'] !== 'string') return { ok: false, error: '"instructions" must be a string' };
  const mt = body['manythreads'] === undefined || body['manythreads'] === null ? {} : body['manythreads'];
  if (!isRecord(mt)) return { ok: false, error: '"manythreads" must be an object' };

  let mcp: { url: string; token: string } | null = null;
  if (mt['mcp'] !== undefined && mt['mcp'] !== null) {
    const m = mt['mcp'];
    if (!isRecord(m) || typeof m['url'] !== 'string' || typeof m['token'] !== 'string' || m['token'] === '') return { ok: false, error: '"manythreads.mcp" needs a url and a token' };
    let u: URL;
    try {
      u = new URL(m['url']);
    } catch {
      return { ok: false, error: '"manythreads.mcp.url" is not a URL' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: '"manythreads.mcp.url" must be http(s)' };
    mcp = { url: u.toString(), token: m['token'] };
  }
  const toolsRaw = mt['tools'] ?? [];
  if (!Array.isArray(toolsRaw) || toolsRaw.some((t) => typeof t !== 'string') || toolsRaw.length > 64) return { ok: false, error: '"manythreads.tools" must be a list of strings' };
  const model = isRecord(mt['model']) ? mt['model'] : {};
  return {
    ok: true,
    value: {
      input: body['input'],
      sessionId: optString(body['session_id']),
      instructions: optString(body['instructions']),
      manythreads: {
        bot: optString(mt['bot']),
        runId: optString(mt['runId']),
        mcp,
        tools: toolsRaw as string[],
        model: { alias: optString(model['alias']), effort: optString(model['effort']) },
        budgetSeconds: optNumber(mt['budgetSeconds']),
        maxTurns: optNumber(mt['maxTurns']),
      },
    },
  };
}
