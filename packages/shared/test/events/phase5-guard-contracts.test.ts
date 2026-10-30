import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { eventRegistry, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contracts of the guardrails and the gate (PLAN P5-11, P5-21; `pnpm test:events`): each has a registered v1 schema and carries ids, names and
// stages, never the text that was checked.

const at = '2026-10-12T09:00:00.000Z';
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('guardrails.dlp.decided', () => {
  const valid = { type: 'guardrails.dlp.decided', schemaVersion: 1, workspaceId: uuid(1), destination: 'email', botId: null, preset: 'standard', outcome: 'redact', rules: ['api-key'], at };

  it('is registered at version 1 and accepts what the hook emits', () => {
    expect(Object.keys(eventRegistry['guardrails.dlp.decided'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(parseEvent({ ...valid, botId: uuid(2), outcome: 'block', preset: 'customer-facing' })).toMatchObject({ outcome: 'block' });
  });

  it.each([
    ['outcome', { outcome: 'allow' }], // nothing is recorded for an allowed call
    ['outcome', { outcome: 'deny' }],
    ['preset', { preset: 'paranoid' }],
    ['rules', { rules: [] }], // a decision names what it found
    ['destination', { destination: '' }],
    ['botId', { botId: 'bot' }],
    ['at', { at: 'yesterday' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('guardrails.egress.decided', () => {
  const valid = { type: 'guardrails.egress.decided', schemaVersion: 1, workspaceId: uuid(1), destination: 'email', botId: null, preset: 'strict-egress', outcome: 'block', target: 'smtp', host: 'mail.example.org', at };

  it('is registered at version 1 and accepts what the hook emits, with or without a known host', () => {
    expect(Object.keys(eventRegistry['guardrails.egress.decided'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(parseEvent({ ...valid, host: null })).toMatchObject({ host: null });
  });

  it.each([
    ['outcome', { outcome: 'redact' }], // a destination is allowed or blocked, never partly
    ['preset', { preset: 'open' }],
    ['target', { target: '' }],
    ['host', { host: 4 }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('runtime.gate.held', () => {
  const valid = {
    type: 'runtime.gate.held',
    schemaVersion: 1,
    workspaceId: uuid(1),
    teamId: uuid(2),
    botId: uuid(3),
    runId: uuid(4),
    stage: 'exact',
    entry: 'credential rotation',
    approvalId: uuid(5),
    at,
  };

  it('is registered at version 1 and accepts a hit by the list, by the classifier, and one that could not be checked or filed', () => {
    expect(Object.keys(eventRegistry['runtime.gate.held'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(parseEvent({ ...valid, stage: 'classifier', entry: null })).toMatchObject({ stage: 'classifier' });
    expect(parseEvent({ ...valid, stage: 'classifier_unavailable', entry: null, approvalId: null })).toMatchObject({ approvalId: null });
  });

  it.each([
    ['stage', { stage: 'semantic' }],
    ['entry', { entry: undefined }],
    ['approvalId', { approvalId: 'later' }],
    ['runId', { runId: null }],
    ['teamId', { teamId: null }],
    ['botId', { botId: 'coder' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('runtime.task.not_woken', () => {
  const valid = { type: 'runtime.task.not_woken', schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), taskId: uuid(3), botId: uuid(4), reason: 'no_thread' };

  it('is registered at version 1 and carries ids and a reason code, nothing else', () => {
    expect(Object.keys(eventRegistry['runtime.task.not_woken'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(parseEvent({ ...valid, reason: 'wake_limit' })).toMatchObject({ reason: 'wake_limit' });
    expect(failsAt({ ...valid, reason: 'because' })).toContain('reason');
    expect(failsAt({ ...valid, note: 'card text' })).not.toBe('');
  });
});

describe('guardrails.dlp.decided and guardrails.egress.decided: the team (P10-04)', () => {
  it('carry the team of the bot when there is one, and still read without it', () => {
    const dlp = { type: 'guardrails.dlp.decided', schemaVersion: 1, workspaceId: uuid(1), destination: 'mcp', botId: uuid(2), teamId: uuid(3), preset: 'standard', outcome: 'block', rules: ['api-key'], at };
    expect(parseEvent(dlp)).toEqual(dlp);
    expect(parseEvent({ ...dlp, teamId: null })).toMatchObject({ teamId: null });
    const older: Record<string, unknown> = { ...dlp };
    delete older['teamId'];
    expect(parseEvent(older)).toEqual(older);
    expect(failsAt({ ...dlp, teamId: 'eng' })).toContain('teamId');
    const egress = { type: 'guardrails.egress.decided', schemaVersion: 1, workspaceId: uuid(1), destination: 'mcp', botId: uuid(2), teamId: uuid(3), preset: 'standard', outcome: 'block', target: 'web', host: 'evil.example', at };
    expect(parseEvent(egress)).toEqual(egress);
  });
});

describe('guardrails.policy.updated', () => {
  const valid = { type: 'guardrails.policy.updated', schemaVersion: 1, workspaceId: uuid(1), kind: 'dlp', change: 'rule_added', subject: 'customer-id', teamId: null, changedBy: uuid(2), at };

  it('is registered at version 1 and names what changed by a short code, never a pattern or a host', () => {
    expect(Object.keys(eventRegistry['guardrails.policy.updated'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(parseEvent({ ...valid, kind: 'egress', change: 'team_list', subject: null, teamId: uuid(3) })).toMatchObject({ kind: 'egress', teamId: uuid(3) });
  });

  it.each([
    ['kind', { kind: 'models' }],
    ['change', { change: 'edited' }],
    ['subject', { subject: 'x'.repeat(61) }],
    ['changedBy', { changedBy: 'omar' }],
    ['teamId', { teamId: 'eng' }],
    ['at', { at: 'today' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});
