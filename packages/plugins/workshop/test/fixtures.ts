import type { SetupInventory } from '@manythreads/shared';

/** A team inventory as `describe_self` shows it, for the tests of grading and of the refusals. Override what a test is about. */
export function inventory(over: Partial<SetupInventory> = {}): SetupInventory {
  return {
    team: { slug: 'engineering', name: 'Engineering' },
    asker: { role: 'lead', canGrantDestructive: true, canAddBot: false },
    bots: [{ slug: 'brain', name: 'Brain', role: 'Answers from the team notes', kind: 'agent', runtime: 'hermes', status: 'active' }],
    knowledge: [{ slug: 'manuals', name: 'Manuals' }],
    skills: [{ slug: 'review' }],
    runners: [{ name: 'fast-model', label: 'Fast model', kind: 'llm_gateway', status: 'ready', isDefault: true }],
    models: [{ alias: 'smart' }, { alias: 'fast' }],
    channels: [{ name: 'general' }, { name: 'dev' }],
    roleTags: ['role:on-call'],
    capabilities: [
      { name: 'knowledge.search', destructive: false },
      { name: 'messages.post', destructive: false },
      { name: 'messages.search', destructive: false },
      { name: 'email.send', destructive: true },
    ],
    triggers: [
      { type: 'conversation', available: true },
      { type: 'mention', available: true },
      { type: 'channel_message', available: true },
      { type: 'task_assigned', available: true },
      { type: 'routine', available: true },
      { type: 'inbox', available: false, note: 'Needs a connection.' },
      { type: 'webhook', available: false, note: 'Needs a connection.' },
    ],
    runtimeAllowed: ['files'],
    guardDefault: 'standard',
    connections: [],
    connectionsNote: 'No connections exist in this release.',
    ...over,
  };
}

/** The asker as a member who may not grant anything dangerous. */
export const member = { role: 'member', canGrantDestructive: false, canAddBot: false } as const;
export const admin = { role: 'admin', canGrantDestructive: true, canAddBot: true } as const;

/** A BOT.md that passes every rule of the inventory above. */
export const GOOD_BOT_MD = `---
schema: 1
name: Manual helper
role: Answers questions from the manuals.
kind: agent
runtime: hermes
model:
  aliases: [smart, fast]
triggers:
  - type: conversation
capabilities:
  native: [knowledge.search, messages.post]
knowledge:
  - base: manuals
    answer_only_from: true
---

You answer questions from the manuals knowledge base. If it does not say, say so and ask a person.
`;
