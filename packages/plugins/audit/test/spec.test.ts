import { AUDIT_ACTIONS, eventRegistry, parseEvent } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { AUDITED_EVENT_TYPES, MAPPERS, clip, memoryReason, memoryTarget, pathLabel } from '../src/spec.ts';

// The mapping from events to console rows (PLAN P10-05). The rule it must keep: a row names people, bots, teams and things and holds fixed phrases;
// it never carries text a person wrote or a secret. Each event below has a value in the fields that can hold such text (a message, a file name, a
// commit subject, a command, an email address, an IP address, a URL, the failure detail of an approved action), and none of it may come out.

const C = 'CANARY-SECRET-TEXT';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-10-30T08:00:00.000Z';
const W = id(1);

/** A valid payload per audited event type, with the canary in every free-text field the schema has. */
const FIXTURES: Record<string, Record<string, unknown>> = {
  'identity.session.signed_in': { personId: id(10), sessionId: id(11), method: 'password', ip: `203.0.113.7 ${C}` },
  'identity.session.sign_in_failed': { personId: id(10), method: 'password', reason: 'wrong_password', ip: '203.0.113.7' },
  'identity.session.signed_out': { personId: id(10), sessionId: id(11), scope: 'everywhere', revoked: 3 },
  'identity.oidc.signed_in': { personId: id(10), sessionId: id(11), providerId: id(12), kind: 'google', createdPerson: true, ip: '203.0.113.7' },
  'identity.oidc.refused': { providerId: id(12), kind: 'google', reason: 'email_not_verified', email: `someone-${C}@example.com`, ip: '203.0.113.7' },
  'identity.password.changed': { personId: id(10), revokedSessions: 2 },
  'identity.password.reset': { personId: id(10) },
  'identity.password.admin_set': { personId: id(10), sessionsRevoked: 1 },
  'identity.provider.changed': { providerId: id(12), kind: 'google', change: 'enabled', enabled: true, personId: id(10) },
  'identity.workspace.bootstrapped': { personId: id(10), workspaceName: 'Kahf' },
  'workspace.member.role_changed': { personId: id(10), previousRole: 'member', role: 'admin', changedBy: id(13) },
  'workspace.invitation.created': { teamId: id(20), invitationId: id(14), email: `invitee-${C}@example.com`, role: 'member', teamRole: 'member' },
  'workspace.invitation.accepted': { teamId: null, invitationId: id(14), personId: id(10), role: 'member', teamRole: null, createdPerson: true },
  'workspace.team.created': { teamId: id(20), slug: 'eng', name: 'Engineering', template: 'engineering' },
  'workspace.team.renamed': { teamId: id(20), previousName: 'Eng', name: 'Engineering' },
  'workspace.team.archived': { teamId: id(20) },
  'workspace.team.unarchived': { teamId: id(20) },
  'team.member.added': { teamId: id(20), personId: id(10), role: 'member' },
  'team.member.removed': { teamId: id(20), personId: id(10), role: 'member', tags: [`role:${C}`] },
  'team.role.changed': { teamId: id(20), personId: id(10), previousRole: 'member', role: 'lead' },
  'workspace.settings.updated': { personId: id(10), changes: { name: `Name ${C}`, selfSignup: true } },
  'proposals.proposal.created': { teamId: id(20), proposalId: id(30), path: 'skills/review/SKILL.md', op: 'put', authorId: id(13), authorKind: 'person', checksOk: true, at: AT },
  'proposals.proposal.applied': { teamId: id(20), proposalId: id(30), path: 'TEAM.md', op: 'put', authorId: id(13), actorId: id(13), selfApplied: true, commitSha: 'a'.repeat(40), at: AT },
  'proposals.proposal.rejected': { teamId: id(20), proposalId: id(30), path: 'TEAM.md', authorId: id(13), actorId: id(15), reason: 'rejected', at: AT },
  'files.file.uploaded': { channelId: id(40), teamId: id(20), fileId: id(41), uploaderId: id(13), name: `${C}.pdf`, size: 2048, mime: 'application/pdf' },
  'files.file.deleted': { channelId: id(40), teamId: id(20), fileId: id(41), deletedBy: id(13) },
  'channel.channel.created': { channelId: id(40), teamId: id(20), name: 'dev', kind: 'channel', private: false },
  'channel.channel.archived': { channelId: id(40), teamId: id(20), archived: true },
  'channel.member.added': { channelId: id(40), teamId: id(20), personId: id(10), self: false },
  'channel.member.removed': { channelId: id(40), teamId: id(20), personId: id(10), self: true },
  'channel.message.deleted': { channelId: id(40), teamId: id(20), messageId: id(42), deletedBy: id(13), threadRootId: null },
  'approvals.approval.requested': { teamId: id(20), approvalId: id(50), source: 'dispatch', tool: 'files.write', botId: id(60), runId: id(61), requesterId: id(62) },
  'approvals.approval.decided': { teamId: id(20), approvalId: id(50), source: 'dispatch', tool: 'files.write', botId: id(60), requesterId: id(62), deciderId: id(13), decision: 'denied' },
  'approvals.approval.resumed': { teamId: id(20), approvalId: id(50), source: 'dispatch', tool: 'files.write', botId: id(60), outcome: 'failed', detail: `disk said ${C}` },
  'bots.bot.loaded': { teamId: id(20), botId: id(60), slug: 'helper', path: 'bots/helper/BOT.md', definitionSha: 'b'.repeat(64), mayTag: [] },
  'bots.bot.removed': { teamId: id(20), botId: id(60), slug: 'helper' },
  'bots.pairing.rotated': { teamId: id(20), botId: id(60), actorId: id(13), revoked: 1, at: AT },
  'llm.key.changed': { botId: id(60), action: 'minted', keyPrefix: `sk-${C}` },
  'runners.token.minted': { teamId: id(20), runnerId: id(70), actorId: id(13), at: AT },
  'runners.token.revoked': { teamId: id(20), runnerId: id(70), actorId: id(13), revoked: 1, at: AT },
  'hermes.connection.created': { teamId: id(20), connectionId: id(71), name: 'office-gateway', kind: 'external', actorId: id(13), at: AT },
  'hermes.connection.updated': { teamId: id(20), connectionId: id(71), name: 'office-gateway', baseUrlChanged: true, keyChanged: true, actorId: id(13), at: AT },
  'hermes.connection.deleted': { teamId: id(20), connectionId: id(71), name: 'office-gateway', actorId: id(13), at: AT },
  'webhooks.hook.created': { teamId: id(20), channelId: id(40), webhookId: id(72), actorId: id(13), at: AT },
  'webhooks.hook.revoked': { teamId: id(20), channelId: id(40), webhookId: id(72), actorId: id(13), at: AT },
  'webhooks.hook.rotated': { teamId: id(20), channelId: id(40), webhookId: id(72), actorId: id(13), at: AT },
  'webhooks.hook.signing_changed': { teamId: id(20), channelId: id(40), webhookId: id(72), actorId: id(13), enabled: true, at: AT },
  'kernel.capability.denied': { actorId: id(60), actorKind: 'bot', runId: null, capability: 'files.write', reason: 'not_granted', path: 'bots/helper/BOT.md', trigger: `mention ${C}` },
  'guardrails.dlp.decided': { destination: 'llm', botId: id(60), preset: 'standard', outcome: 'redact', rules: ['aws_access_key'], at: AT },
  'guardrails.policy.updated': { kind: 'dlp', change: 'rule_added', subject: 'office-wifi', teamId: null, changedBy: id(13), at: AT },
  'guardrails.egress.decided': { destination: 'http', botId: id(60), preset: 'standard', outcome: 'block', target: `https://evil.example/?token=${C}`, host: 'evil.example', at: AT },
  'llm.guard.decided': { botId: id(60), alias: 'smart', preset: 'standard', outcome: 'block', rules: ['private_key'], reason: 'dlp', at: AT },
  'llm.budget.exceeded': { scope: 'bot', teamId: id(20), botId: id(60), sessionId: null, reason: 'budget', window: 'day', limitUsd: 5, requestsPerMinute: null, spentUsd: 5.1, retryAfterMs: null, alias: 'smart', at: AT },
  'runtime.gate.held': { teamId: id(20), botId: id(60), runId: id(61), stage: 'exact', entry: `rm -rf ${C}`, approvalId: id(50), at: AT },
  'answer.answer.posted': { botId: id(60), runId: id(61), askerPersonId: id(10), channelId: id(40), messageId: id(42), threadRootId: null, citationCount: 2, droppedCount: 1, reachedCount: 3 },
  'answer.answer.shared': { kind: 'channel', personId: id(10), botId: id(60), runId: id(61), messageId: id(42), channelId: id(40), copyMessageId: id(43), keptCount: 1, maskedCount: 1, removedCount: 1, maskedNumbers: [2], removedNumbers: [3] },
  'llm.config.applied': { providers: 2, aliases: 3, fallbacks: 1, appliedAt: AT },
  'llm.alias.tested': { alias: 'smart', outcome: 'failed', cause: 'model_not_found', testedBy: id(13), at: AT },
  'onboarding.step.marked': { step: 'code', kind: 'skipped', markedBy: id(13), at: AT },
  'onboarding.goal.launched': { teamId: id(20), channelId: id(40), launchedBy: id(13), at: AT },
  'onboarding.checklist.dismissed': { dismissedBy: id(13), at: AT },
  'retention.settings.changed': { changedBy: id(13), runLogDays: { from: 30, to: 60 }, memoryLogDays: { from: 30, to: 30 }, changedAt: AT },
  'retention.sweep.completed': { sweepId: id(80), dryRun: false, runLogCutoff: AT, memoryLogCutoff: AT, counts: { runs: 0, runsSkipped: 0, runSourceLines: 0, runTokens: 0, runMemos: 0, memoryLogLines: 0, memosRemoved: 0 }, durationMs: 5 },
  'audit.export.created': { exportedBy: id(13), rowCount: 12, truncated: false, from: null, to: null, keyId: 'abcdef0123456789', exportedAt: AT },
};

describe('the audited event types', () => {
  it('are all registered events, and every one has a fixture here', () => {
    for (const type of AUDITED_EVENT_TYPES) expect(Object.keys(eventRegistry), type).toContain(type);
    expect(Object.keys(FIXTURES).sort()).toEqual([...AUDITED_EVENT_TYPES].sort());
  });

  it.each(Object.entries(FIXTURES))('%s: maps to a known action, and nothing a person wrote comes through', (type, fields) => {
    const full = { type, schemaVersion: 1, workspaceId: W, ...fields };
    // the fixture is a valid event of its type, so the mapping is tested on what the log really holds
    let parsed: Record<string, unknown>;
    try {
      parsed = parseEvent(full) as unknown as Record<string, unknown>;
    } catch (e) {
      throw new Error(`${type}: fixture is not a valid event: ${(e as Error).message}`);
    }
    const mapped = MAPPERS[type]!(parsed);
    expect(mapped, type).not.toBeNull();
    expect(Object.keys(AUDIT_ACTIONS), type).toContain(mapped!.action);
    expect(JSON.stringify(mapped), type).not.toContain('CANARY');
    expect(JSON.stringify(mapped), type).not.toMatch(/203\.0\.113|@example\.com|evil\.example\/|sk-/);
  });

  it('keeps hostile text out even when a field the mapping reads is hostile', () => {
    // a capability name or reason that is not a plain identifier is dropped, never copied
    const m = MAPPERS['kernel.capability.denied']!({ actorId: id(60), actorKind: 'bot', capability: `files.write ${C}`, reason: `because ${C}`, path: null });
    expect(JSON.stringify(m)).not.toContain('CANARY');
    expect(m).toMatchObject({ outcome: 'denied', reason: 'Refused' });
    // a rule name that is not an identifier is dropped from the reason
    const g = MAPPERS['guardrails.dlp.decided']!({ destination: 'llm', botId: id(60), outcome: 'redact', rules: [`aws ${C}`, 'github_token'] });
    expect(g!.reason).toBe('Redacted by the data-loss check: github_token');
  });

  it('marks what the platform held back as withheld, and a refusal as denied', () => {
    const outcome = (type: string): string | undefined => MAPPERS[type]!(parseEvent({ type, schemaVersion: 1, workspaceId: W, ...FIXTURES[type] }) as unknown as Record<string, unknown>)?.outcome;
    expect(outcome('guardrails.dlp.decided')).toBe('withheld');
    expect(outcome('llm.guard.decided')).toBe('withheld');
    expect(outcome('runtime.gate.held')).toBe('withheld');
    expect(outcome('answer.answer.posted')).toBe('withheld');
    expect(outcome('answer.answer.shared')).toBe('withheld');
    expect(outcome('approvals.approval.decided')).toBe('denied');
    expect(outcome('identity.session.sign_in_failed')).toBe('denied');
    expect(outcome('proposals.proposal.applied')).toBeUndefined(); // undefined means ok
  });

  it('leaves out what is routine: an allowed model call, an answer with nothing dropped, a direct-message channel', () => {
    expect(MAPPERS['llm.guard.decided']!({ outcome: 'allow', botId: id(60) })).toBeNull();
    expect(MAPPERS['answer.answer.posted']!({ ...FIXTURES['answer.answer.posted'], droppedCount: 0 })).toBeNull();
    expect(MAPPERS['channel.channel.created']!({ ...FIXTURES['channel.channel.created'], kind: 'dm' })).toBeNull();
  });
});

describe('memory log lines', () => {
  it('become a short phrase from a fixed code, never free text', () => {
    expect(memoryReason('private_source')).toBe('Private source');
    expect(memoryReason(`private ${C}`)).toBe('Not kept');
    expect(memoryTarget('message', 'abc-123')).toEqual({ kind: 'message', id: 'abc-123', label: null });
    expect(memoryTarget('message', `has spaces ${C}`).id).toBeNull();
  });
});

describe('repo paths in a row', () => {
  it('shows a guarded definition by its name and any other path by its top folder only', () => {
    expect(pathLabel('TEAM.md')).toBe('TEAM.md');
    expect(pathLabel('bots/helper/BOT.md')).toBe('bots/helper/BOT.md');
    expect(pathLabel('skills/review/SKILL.md')).toBe('skills/review/SKILL.md');
    // a path that can name something private shows its folder and nothing else
    expect(pathLabel(`memory/people/${C}.md`)).toBe('memory');
    expect(pathLabel(`channels/${id(1)}/${C}-salary.pdf`)).toBe('channels');
    expect(pathLabel(`${C}.txt`)).toBeNull();
    // a guarded folder with an odd part is not shown whole
    expect(pathLabel(`bots/${C} with space/BOT.md`)).toBe('bots');
    expect(pathLabel('Bots/x/BOT.md')).toBeNull();
    expect(pathLabel(null)).toBeNull();
  });

  it('keeps a canary in the path of a refused capability or a proposal out of the row', () => {
    for (const type of ['kernel.capability.denied', 'proposals.proposal.created']) {
      const m = MAPPERS[type]!({ ...FIXTURES[type], path: `memory/${C}/${C}.md`, proposalId: id(30), teamId: id(20), authorId: id(13), capability: 'files.write', actorId: id(60), actorKind: 'bot' });
      expect(JSON.stringify(m), type).not.toContain('CANARY');
    }
  });
});

describe('cutting a text short', () => {
  it('never splits a character outside the basic plane, so the row can be stored as JSON', () => {
    const text = `${'a'.repeat(198)}😀😀`;
    const cut = clip(text);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(() => JSON.parse(JSON.stringify(cut))).not.toThrow();
    // no lone half remains
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false);
    expect(clip('short')).toBe('short');
  });
});
