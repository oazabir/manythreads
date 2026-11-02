import { describe, expect, it } from 'vitest';
import { connectionEntries } from '../src/connection-entries.ts';

// Which tools of a connection wait for a person: `approvals.needsApproval` names a tool or a `namespace.*` wildcard (the rule the rest of the definition uses).

const fm = (needsApproval: string[]) => ({
  capabilities: { connections: [{ name: 'mailbox', tools: ['email.read', 'email.draft', 'email.send'] }] },
  approvals: { needsApproval },
});

describe('connectionEntries', () => {
  it('an exact name covers just that tool', () => {
    expect(connectionEntries(fm(['email.send']))).toEqual([{ connection: 'mailbox', tools: ['email.read', 'email.draft', 'email.send'], needsApproval: ['email.send'] }]);
  });

  it('a namespace wildcard covers every tool of the namespace', () => {
    expect(connectionEntries(fm(['email.*']))[0]?.needsApproval).toEqual(['email.read', 'email.draft', 'email.send']);
  });

  it('a wildcard of another namespace, or a prefix that is not a namespace, covers nothing', () => {
    expect(connectionEntries(fm(['drive.*']))[0]?.needsApproval).toEqual([]);
    expect(connectionEntries(fm(['emai.*']))[0]?.needsApproval).toEqual([]);
    expect(connectionEntries(fm([]))[0]?.needsApproval).toEqual([]);
  });

  it('a definition with no connections and no approvals gives nothing', () => {
    expect(connectionEntries({})).toEqual([]);
  });
});
