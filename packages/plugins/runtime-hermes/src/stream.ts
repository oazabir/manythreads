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
  | { type: 'tool_result'; name: string; ok: boolean }
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
    case 'tool_result':
      return { type: 'tool_result', name: str(raw['name']), ok: raw['is_error'] !== true };
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
