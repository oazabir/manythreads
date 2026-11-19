import type { ApprovalProvider, PluginContext } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { ASK_DETAILS_MAX, ASK_QUESTION_MAX, ASK_TOOL, registerAsk, resolveApprovers, type AskCandidates } from '../src/ask.ts';

// P29-05: what a bot's `approvals.ask` stores is the whole question and the whole context, not the 300-character preview of a generic call.

const NADIA = '00000000-0000-4000-8000-0000000000a1';
const RAFI = '00000000-0000-4000-8000-0000000000a2';

type Handler = (input: Record<string, unknown>, tx: unknown) => Promise<Record<string, unknown>>;
type Filed = { summary: string; argsPreview: Record<string, unknown>; argsTruncated: boolean; resume: unknown; approvers?: string[]; dedupeKey?: string };

function setup(): { ask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>; filed: Filed[] } {
  let handler: Handler | null = null;
  const filed: Filed[] = [];
  // the system read of who could decide: Nadia and Rafi can read the conversation; Rafi holds role:on-call
  const sys = {
    query: (sql: string) =>
      Promise.resolve({
        rows: sql.includes('role_members')
          ? [{ name: 'role:on-call', person_id: RAFI }]
          : [{ id: NADIA, display_name: 'Nadia Khan', email: 'nk.one@example.test' }, { id: RAFI, display_name: 'Rafi Ahmed', email: 'ra.two@example.test' }],
      }),
  };
  const ctx = {
    capabilities: { register: (name: string, fn: Handler) => (name === ASK_TOOL ? (handler = fn) : undefined) },
    db: { system: (fn: (tx: unknown) => Promise<unknown>) => fn(sys) },
  } as unknown as PluginContext;
  const approvals = {
    request: (_tx: unknown, input: Filed) => {
      filed.push(input);
      return Promise.resolve({ approvalId: 'a1', created: true, visibleTo: 'team' });
    },
  } as unknown as ApprovalProvider;
  registerAsk(ctx, approvals);
  const tx = { query: () => Promise.resolve({ rows: [{ id: 'run-1' }] }) };
  return { ask: (input) => handler!(input, tx), filed };
}

describe('approvals.ask keeps the whole question', () => {
  it('stores a long question and a long context unclipped, line breaks kept, and one short line for the list', async () => {
    const { ask, filed } = setup();
    const question = `Can the platform owner resolve the preview secret-read permission?\n${'The deployer needs read access to the preview secret. '.repeat(20)}`;
    const details = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: some context for the person who decides`).join('\n');
    const res = await ask({ question, details });
    expect(res['ok']).toBe(true);
    const f = filed[0]!;
    expect(f.argsPreview['question']).toBe(question.trim());
    expect(f.argsPreview['details']).toBe(details);
    expect((f.argsPreview['details'] as string).split('\n')).toHaveLength(40);
    expect(f.argsTruncated).toBe(false);
    expect(f.summary.length).toBeLessThanOrEqual(300);
    expect(f.summary).not.toContain('\n');
  });

  it('clips only past the bounds, and says so', async () => {
    const { ask, filed } = setup();
    await ask({ question: 'Is this fine?', details: 'x'.repeat(ASK_DETAILS_MAX + 50) });
    expect(filed[0]!.argsTruncated).toBe(true);
    expect((filed[0]!.argsPreview['details'] as string).length).toBe(ASK_DETAILS_MAX);
    await ask({ question: 'q'.repeat(ASK_QUESTION_MAX + 10) });
    expect(filed[1]!.argsTruncated).toBe(true);
  });

  it('still refuses a question of fewer than three characters', async () => {
    const { ask, filed } = setup();
    expect((await ask({ question: 'a' }))['ok']).toBe(false);
    expect(filed).toHaveLength(0);
  });
});

describe('approvals.ask names who decides (owner 2026-11-19)', () => {
  const people: AskCandidates = {
    people: [
      { id: NADIA, displayName: 'Nadia Khan', email: 'nk@example.test' },
      { id: RAFI, displayName: 'Rafi Ahmed', email: 'ra.two@example.test' },
      { id: '00000000-0000-4000-8000-0000000000a3', displayName: 'Nadia Rahman', email: 'nr.three@example.test' },
    ],
    roles: new Map([['role:on-call', [RAFI]]]),
  };

  it('turns @handles, person ids and role tags into the principals an approval stores, with names for the bot', () => {
    expect(resolveApprovers(['@nadia-khan', 'role:on-call', `person:${RAFI}`, 'rafi'], people)).toEqual({
      ok: true,
      principals: [`person:${NADIA}`, 'role:on-call', `person:${RAFI}`],
      names: ['Nadia Khan', 'role:on-call', 'Rafi Ahmed'],
    });
    // a first name works when only one person here has it, the email handle always
    expect(resolveApprovers(['nk'], people)).toMatchObject({ ok: true, principals: [`person:${NADIA}`] });
    expect(resolveApprovers(['nadia'], { ...people, people: people.people.slice(0, 2) })).toMatchObject({ ok: true, principals: [`person:${NADIA}`] });
  });

  it('refuses, never guesses: an ambiguous first name, nobody, an empty role, a person who cannot read the conversation, a bad list', () => {
    expect(resolveApprovers(['@nadia'], people)).toMatchObject({ ok: false, message: expect.stringMatching(/more than one person/) as unknown });
    expect(resolveApprovers(['@zed'], people)).toMatchObject({ ok: false });
    expect(resolveApprovers(['role:release-owner'], people)).toMatchObject({ ok: false, message: expect.stringMatching(/nobody .* holds role:release-owner/) as unknown });
    expect(resolveApprovers(['person:00000000-0000-4000-8000-0000000000ff'], people)).toMatchObject({ ok: false });
    for (const bad of [[], 'nadia', [1], Array.from({ length: 11 }, () => 'rafi')]) expect(resolveApprovers(bad, people)).toMatchObject({ ok: false });
  });

  it('files the question with those approvers, keys it apart from the same question for others, and tells the bot whom to mention', async () => {
    const { ask, filed } = setup();
    const res = await ask({ question: 'May I change the billing table?', approvers: ['@nadia-khan'] });
    expect(res['ok']).toBe(true);
    expect(filed[0]!.approvers).toEqual([`person:${NADIA}`]);
    expect(res['message']).toMatch(/Only Nadia Khan can answer it; mention them/);
    await ask({ question: 'May I change the billing table?' });
    expect(filed[1]!.approvers).toBeUndefined();
    expect(filed[1]!.dedupeKey).not.toBe(filed[0]!.dedupeKey);
  });

  it('a name it cannot place is an invalid input and files nothing', async () => {
    const { ask, filed } = setup();
    const res = await ask({ question: 'May I change the billing table?', approvers: ['@zed'] });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(filed).toHaveLength(0);
  });
});
