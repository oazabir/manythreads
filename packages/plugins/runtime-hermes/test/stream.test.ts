import { describe, expect, it } from 'vitest';
import { parseHermesLine, replyText } from '../src/stream.ts';

// Hermes' own `--format stream-json` records (docs/reference/cli-commands.md, checked against version 0.21.5 on the devbox).
// Every line below is a shape the real CLI prints; the parser must read them and ignore everything else without failing a run.

describe('parseHermesLine', () => {
  it('reads a text delta', () => {
    expect(parseHermesLine('{"type":"text","text":"Half a sentence","timestamp":1}')).toEqual({ type: 'text', text: 'Half a sentence' });
  });

  it('reads a tool call and its result', () => {
    expect(parseHermesLine('{"type":"tool_use","name":"mcp_manythreads_messages_search","input":{"query":"deploy"}}')).toEqual({
      type: 'tool_use',
      name: 'mcp_manythreads_messages_search',
      input: { query: 'deploy' },
    });
    expect(parseHermesLine('{"type":"tool_result","name":"x","output":"…","duration_ms":12,"is_error":false}')).toEqual({
      type: 'tool_result',
      name: 'x',
      ok: true,
    });
    expect(parseHermesLine('{"type":"tool_result","name":"x","output":"…","is_error":true}')).toMatchObject({ ok: false });
  });

  it('reads the terminal result with its exit code and tokens', () => {
    const line =
      '{"type":"result","session_id":"s-1","exit_code":0,"text":"The deploy changed the loader.","tokens":{"input":1200,"output":80,"total":1280,"cache_read":0,"cache_write":0},"duration_ms":4200}';
    expect(parseHermesLine(line)).toEqual({
      type: 'result',
      text: 'The deploy changed the loader.',
      ok: true,
      exitCode: 0,
      tokens: { input: 1200, output: 80, total: 1280 },
    });
  });

  it('reads a failed turn as a result that is not ok, with its reason', () => {
    const parsed = parseHermesLine('{"type":"result","exit_code":1,"text":"partial","error":"the provider refused the request"}');
    expect(parsed).toMatchObject({ type: 'result', ok: false, error: 'the provider refused the request', exitCode: 1 });
  });

  it('reads an interrupted turn (exit 130) as not ok', () => {
    expect(parseHermesLine('{"type":"result","exit_code":130,"text":""}')).toMatchObject({ ok: false, exitCode: 130 });
  });

  it('ignores the records a run does not act on, and anything that is not JSON', () => {
    expect(parseHermesLine('{"type":"system","subtype":"init","model":"code","session_id":"s-1"}')).toBeNull();
    expect(parseHermesLine('{"type":"something-newer","text":"x"}')).toBeNull();
    expect(parseHermesLine('session_id: s-1')).toBeNull();
    expect(parseHermesLine('{"broken json')).toBeNull();
    expect(parseHermesLine('')).toBeNull();
    expect(parseHermesLine('[1,2,3]')).toBeNull();
  });
});

describe('replyText', () => {
  it('prefers the terminal record, and falls back to the deltas a truncated stream sent', () => {
    const result = parseHermesLine('{"type":"result","exit_code":0,"text":"The whole answer."}');
    expect(replyText(['The ', 'whole ', 'answer.'], result)).toBe('The whole answer.');
    expect(replyText(['half an ', 'answer'], null)).toBe('half an answer');
    expect(replyText([], null)).toBe('');
  });
});
