import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../../../packages/plugins/guardrails-dlp/src/dlp.ts';
import { lastLine, redact } from '../src/process.ts';
import { events, harness, KEY, start, type Harness } from './support.ts';

// P19-12: what the bridge scrubs from an answer before it leaves. The run token and the secrets it was told about are hidden by name; the sign-in token SHAPES (the ones the platform's
// data-protection step calls `signin-token`) are hidden by their form, so a token the bridge was never told about does not reach a thread either. Every sample is made up.

const CANARY = 'CANARY-BRIDGE-2d90';
const b64 = (s: string): string => Buffer.from(s).toString('base64url');
const jwt = (pad = 0): string => `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify({ plan: CANARY, pad: 'x'.repeat(pad) }))}.${b64(`sig-${CANARY}`)}`;

const SHAPES: Array<[string, string]> = [
  ['an Anthropic access token', `sk-ant-oat01-${'Ab3_-'.repeat(20)}${CANARY}`],
  ['an Anthropic refresh token', `sk-ant-ort01-${'Zy9-_'.repeat(20)}${CANARY}`],
  ['a ChatGPT id_token', jwt()],
  ['a long ChatGPT access_token', jwt(3000)],
  ['a ChatGPT refresh token (the form first guessed)', `rt_${'Qw8Er7'.repeat(8)}.${'Ty6Ui5'.repeat(8)}`],
  // MEASURED on a real auth.json (Codex 0.166.0, 2026-11-10): `rt.1.` and 191 URL-safe base64 characters. This sample has the same form; the characters are made up.
  ['a ChatGPT refresh token (the measured form)', `rt.1.${'Qw8Er7-_'.repeat(23)}${CANARY}`],
];

describe('redact', () => {
  for (const [label, token] of SHAPES) {
    it(`hides ${label} in an answer, with no secret told to it`, () => {
      const out = redact(`The login is ${token}, keep it safe.`, []);
      expect(out).toBe('The login is [hidden], keep it safe.');
      expect(out).not.toContain(CANARY);
    });
  }

  it('hides the value of the sign-in file\'s own fields whatever it looks like, and keeps the field', () => {
    const out = redact(`{"claudeAiOauth":{"accessToken":"made-up-${CANARY}-0123456789","refresh_token": "another-${CANARY}-9876543210"}}`, []);
    expect(out).not.toContain(CANARY);
    expect(out).toContain('"accessToken":"[hidden]"');
    expect(out).toContain('"refresh_token": "[hidden]"');
  });

  it('still hides the named secrets, a Bearer token and keeps ordinary text', () => {
    expect(redact('token=abcd1234-run and Bearer abcdefgh12345678 here', ['abcd1234-run'])).toBe('token=[hidden] and Bearer [hidden] here');
    expect(redact('call rt_cleanup_handler_for_old_sessions_list when idle', [])).toBe('call rt_cleanup_handler_for_old_sessions_list when idle');
    expect(redact('{"refresh_token": null, "accessToken": "short"}', [])).toBe('{"refresh_token": null, "accessToken": "short"}');
  });

  it('a long token after "Bearer" goes whole (the old cap left a tail)', () => {
    const out = redact(`Authorization: Bearer ${jwt(3000)}`, []);
    expect(out).toBe('Authorization: Bearer [hidden]');
  });

  it('lastLine (a failed run\'s one stderr line) hides them too', () => {
    expect(lastLine(`warming up\nrefused: ${SHAPES[0]![1]}\n`, [])).toBe('refused: [hidden]');
  });

  it('runs in linear time on hostile input', () => {
    for (const text of ['eyJ-'.repeat(260_000), 'sk-ant-oat01-'.repeat(80_000), 'rt_'.repeat(350_000), 'rt.1.'.repeat(200_000), '"refresh_token":'.repeat(65_000), `eyJ${'a'.repeat(1_000_000)}`]) {
      const started = performance.now();
      redact(text, []);
      expect(performance.now() - started).toBeLessThan(2500);
    }
  });
});

describe('the bridge scrub and the platform scan name the same shapes', () => {
  // If one learns a shape and the other does not, a token passes one of the two doors. Same samples, both doors.
  const samples = [
    ...SHAPES.map(([, token]) => token),
    `{"claudeAiOauth":{"accessToken":"made-up-${CANARY}-0123456789"}}`,
    `{"tokens":{"refresh_token":"made-up-${CANARY}-0123456789"}}`,
  ];
  for (const sample of samples) {
    it(`both hide ${sample.slice(0, 24)}…`, () => {
      expect(scan(sample).some((f) => f.rule === 'signin-token')).toBe(true);
      expect(redact(sample, [])).not.toContain(CANARY);
    });
  }
  for (const benign of ['call rt.1.2 in the notes', 'call rt_cleanup_handler_for_old_sessions_list when idle', 'eyJhbGciOiJIUzI1NiJ9 is a header', '{"refresh_token": "short"}', 'sk-ant-oat01 names a shape']) {
    it(`neither touches "${benign.slice(0, 30)}"`, () => {
      expect(scan(benign).some((f) => f.rule === 'signin-token')).toBe(false);
      expect(redact(benign, [])).toBe(benign);
    });
  }
});

describe('the final answer of a run through the real bridge', () => {
  let h: Harness | undefined;
  let tmp = '';
  afterEach(async () => {
    await h?.close();
    h = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  /** A `claude` that answers with the text after the word SAY in its prompt (stream-json, like the real one), and prints the same text on stderr when the prompt says FAIL. */
  function sayingClaude(): string {
    tmp = mkdtempSync(join(tmpdir(), 'bridge-say-'));
    const file = join(tmp, 'say-claude.mjs');
    writeFileSync(
      file,
      [
        '#!/usr/bin/env node',
        "let stdin = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) stdin += c;",
        "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "const said = stdin.split('SAY ')[1] ?? 'nothing';",
        "out({ type: 'system', subtype: 'init', session_id: 's1', tools: [] });",
        "if (stdin.includes('FAIL')) { process.stderr.write('refused: ' + said + '\\n'); process.exit(2); }",
        "out({ type: 'assistant', message: { content: [{ type: 'text', text: 'about to say it: ' + said }] } });",
        "out({ type: 'result', subtype: 'success', is_error: false, result: said, session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } });",
      ].join('\n'),
    );
    chmodSync(file, 0o755);
    return file;
  }

  for (const [label, token] of SHAPES) {
    it(`never sends ${label} out, in the streamed text, the final output or the stored run`, async () => {
      h = await harness({ bin: { claude: sayingClaude(), codex: 'codex' } }, 'claude-code');
      const res = await start(h, { input: `SAY the login is ${token} ok`, manythreads: { tools: [] } });
      const { run_id } = (await res.json()) as { run_id: string };
      const evs = await events(h, run_id);
      expect(JSON.stringify(evs)).not.toContain(CANARY);
      const done = evs.at(-1)!.data;
      expect(done['event']).toBe('run.completed');
      expect(done['output']).toBe('the login is [hidden] ok');
      const stored = await (await fetch(`${h.bridge.url}/p/default/v1/runs/${run_id}`, { headers: { authorization: `Bearer ${KEY}` } })).text();
      expect(stored).not.toContain(CANARY);
    });
  }

  it('hides a token in the one stderr line a failed run reports', async () => {
    h = await harness({ bin: { claude: sayingClaude(), codex: 'codex' } }, 'claude-code');
    const res = await start(h, { input: `FAIL SAY ${SHAPES[0]![1]}`, manythreads: { tools: [] } });
    const { run_id } = (await res.json()) as { run_id: string };
    const evs = await events(h, run_id);
    expect(JSON.stringify(evs)).not.toContain(CANARY);
    expect(evs.at(-1)!.data['event']).toBe('run.failed');
  });
});
