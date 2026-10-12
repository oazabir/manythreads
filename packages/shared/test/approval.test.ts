import { describe, expect, it } from 'vitest';
import {
  ApprovalResume,
  GUARD_RULE_DLP_APPROVAL,
  approvalSourceFor,
  approvalSummary,
  approversFromPrincipals,
  previewArgs,
} from '../src/index.ts';

// P5-20: the pure pieces every caller of the one approvals handler shares.

describe('approvalSourceFor', () => {
  it('names nothing when nothing says a person must decide', () => {
    expect(approvalSourceFor({})).toBeNull();
    expect(approvalSourceFor({ grantNeedsApproval: false, environmentProtected: false })).toBeNull();
  });

  it('names the one source that applies', () => {
    expect(approvalSourceFor({ grantNeedsApproval: true })).toBe('grant');
    expect(approvalSourceFor({ dlpRequiresApproval: true })).toBe('dlp');
    expect(approvalSourceFor({ dispatchStrict: true })).toBe('dispatch');
    expect(approvalSourceFor({ environmentProtected: true })).toBe('environment');
  });

  it('a call that is several things at once is one approval, named by the first source in the order environment, dispatch, dlp, grant', () => {
    expect(approvalSourceFor({ grantNeedsApproval: true, dlpRequiresApproval: true })).toBe('dlp');
    expect(approvalSourceFor({ grantNeedsApproval: true, dlpRequiresApproval: true, dispatchStrict: true })).toBe('dispatch');
    expect(approvalSourceFor({ grantNeedsApproval: true, environmentProtected: true, dispatchStrict: true })).toBe('environment');
  });
});

describe('approversFromPrincipals', () => {
  it('splits role tags from people and says nothing about leads when someone is named', () => {
    expect(approversFromPrincipals(['role:on-call', 'person:0190c1d2-0000-7000-8000-000000000001', 'role:on-call'])).toEqual({
      roles: ['role:on-call'],
      people: ['0190c1d2-0000-7000-8000-000000000001'],
      leads: false,
    });
  });

  it('names the team\'s leads when no one is named', () => {
    expect(approversFromPrincipals([])).toEqual({ roles: [], people: [], leads: true });
  });
});

describe('previewArgs', () => {
  it('clips what an approver is shown and hides every key that names a secret', () => {
    const preview = previewArgs({
      to: 'm.okafor@example.com',
      body: 'x'.repeat(1000),
      apiKey: 'sk-live-123',
      headers: { Authorization: 'Bearer abc', accept: 'json' },
      nested: { a: { b: { c: 'too deep' } } },
      list: Array.from({ length: 14 }, (_, i) => i),
      password: 'hunter2',
    });
    expect(preview['to']).toBe('m.okafor@example.com');
    expect((preview['body'] as string).length).toBe(301);
    expect(preview['apiKey']).toBe('[hidden]');
    expect(preview['password']).toBe('[hidden]');
    expect(preview['headers']).toEqual({ Authorization: '[hidden]', accept: 'json' });
    expect(preview['nested']).toEqual({ a: { b: '[…]' } });
    expect((preview['list'] as unknown[]).length).toBe(11);
    expect(JSON.stringify(preview)).not.toMatch(/sk-live|hunter2|Bearer abc/);
  });

  it('keeps at most twenty keys and survives values that are not JSON', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const preview = previewArgs({ ...many, fn: () => 1, nothing: undefined, big: 10n, inf: Infinity });
    expect(Object.keys(preview).length).toBeLessThanOrEqual(21);
    expect(() => JSON.stringify(preview)).not.toThrow();
  });
});

describe('approvalSummary', () => {
  it('says the tool and, when the arguments name one, what it is about', () => {
    expect(approvalSummary('email.send', { to: 'm.okafor', body: 'hi' })).toBe('email.send · m.okafor');
    expect(approvalSummary('pages.write', { path: 'pages/x.md' })).toBe('pages.write · pages/x.md');
    expect(approvalSummary('tasks.handoff', { taskId: 't-1' })).toBe('tasks.handoff');
    expect(approvalSummary('x.y', { subject: 'a'.repeat(200) }).length).toBeLessThan(100);
  });
});

describe('ApprovalResume', () => {
  it('is a tool call to re-run or a payload to hand back, and nothing else', () => {
    expect(ApprovalResume.safeParse({ kind: 'tool', capability: 'pages.write', args: {}, trigger: 'mention' }).success).toBe(true);
    expect(ApprovalResume.safeParse({ kind: 'handoff', payload: { a: 1 } }).success).toBe(true);
    expect(ApprovalResume.safeParse({ kind: 'tool', capability: 'nope', args: {}, trigger: 'mention' }).success).toBe(false);
    expect(ApprovalResume.safeParse({ kind: 'job', queue: 'x', payload: {} }).success).toBe(false);
  });

  it('the guard rule a bot sets to hold DLP findings has one spelling', () => {
    expect(GUARD_RULE_DLP_APPROVAL).toBe('dlp:require_approval');
  });
});
