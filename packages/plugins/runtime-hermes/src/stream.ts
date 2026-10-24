// What `hermes chat --format stream-json` prints (Hermes' own documented shape, checked on the devbox): one JSON object per
// line on stdout, diagnostics on stderr, and a terminal `result` record whose `exit_code` matches the process exit code.
//
//   system       { subtype: "init", model, session_id }
//   text         { text }                                  — a streamed assistant text delta
//   tool_use     { name, input }
//   tool_result  { name, output, duration_ms, is_error }
//   result       { session_id, exit_code, text, tokens: { input, output, total, cache_read, cache_write }, duration_ms, error }
//
// Parsing is deliberately tolerant: a line that is not JSON, or a record type a newer Hermes adds, is skipped rather than
// failing a run that is already talking to a model. Only a missing `result` is an error, and the runner synthesises one.

/** One parsed record. `tokens` is what the spend ledger wants from the terminal record. */
export type HermesEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; reason?: string | undefined }
  | {
      type: 'result';
      text: string;
      ok: boolean;
      error?: string;
      exitCode: number | null;
      tokens: { input: number; output: number; total: number } | null;
    };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * A short, safe reason out of a failed tool's `output` (the MCP result, JSON text or an object): the tool's own `message`, else the text.
 * Links, long token-like strings and bearer values are removed and the rest is clipped to 200 characters.
 */
export function refusalReason(output: unknown): string | undefined {
  let value: unknown = output;
  for (let i = 0; i < 3 && value !== undefined; i += 1) {
    if (typeof value === 'string') {
      const t = value.trim();
      if (t[0] !== '{' && t[0] !== '[') break;
      try {
        value = JSON.parse(t);
      } catch {
        break;
      }
    } else if (isRecord(value) && Array.isArray(value['content'])) {
      value = (value['content'] as unknown[]).map((c) => (isRecord(c) ? c['text'] : undefined)).find((x) => typeof x === 'string');
    } else if (isRecord(value) && typeof value['message'] === 'string') {
      value = value['message'];
    } else if (isRecord(value) && typeof value['error'] === 'string') {
      value = value['error'];
    } else break;
  }
  if (typeof value !== 'string') return undefined;
  // Bounded first, then only patterns without nested quantifiers: a hostile output cannot make this slow.
  const clean = value
    .slice(0, 4000)
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/[\w.+-]{1,64}@[\w-]{1,64}(?:\.[\w-]{1,64}){1,4}/g, '[email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[hidden]')
    .replace(/\bbearer\s{1,3}\S{8,}/gi, 'bearer [hidden]')
    .replace(/\b(bearer|token|key|secret|password|passwd|api[_-]?key|authorization)\s{0,3}[:=]\s{0,3}\S+/gi, '$1 [hidden]')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, '[hidden]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean === '' ? undefined : clean.slice(0, 200);
}

/** One line of Hermes' stream-json, or null for a line we do not act on. */
export function parseHermesLine(line: string): HermesEvent | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed[0] !== '{') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw['type']) {
    case 'text':
      return { type: 'text', text: str(raw['text']) };
    case 'tool_use':
      return { type: 'tool_use', name: str(raw['name']), input: raw['input'] ?? null };
    case 'tool_result': {
      const ok = raw['is_error'] !== true;
      const reason = ok ? undefined : refusalReason(raw['output']);
      return { type: 'tool_result', name: str(raw['name']), ok, ...(reason ? { reason } : {}) };
    }
    case 'result': {
      const tokens = isRecord(raw['tokens']) ? raw['tokens'] : null;
      const exitCode = typeof raw['exit_code'] === 'number' ? raw['exit_code'] : null;
      const error = typeof raw['error'] === 'string' && raw['error'] !== '' ? raw['error'] : undefined;
      return {
        type: 'result',
        text: str(raw['text']),
        ok: exitCode === 0,
        ...(error === undefined ? {} : { error }),
        exitCode,
        tokens: tokens
          ? { input: num(tokens['input']), output: num(tokens['output']), total: num(tokens['total']) }
          : null,
      };
    }
    default:
      return null;
  }
}

/**
 * The reply text of a run: the terminal record's text when it has one, and otherwise the text deltas concatenated (Hermes
 * answers with deltas and a final record; a truncated stream still has the deltas it managed to send).
 */
export function replyText(deltas: readonly string[], result: HermesEvent | null): string {
  const final = result?.type === 'result' ? result.text : '';
  return (final.trim() !== '' ? final : deltas.join('')).trim();
}
