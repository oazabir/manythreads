import { describe, expect, it } from 'vitest';
import { BOT_SECTIONS, BotFrontmatter, BotSection, botFrontmatterJsonSchema } from '../src/index.ts';

// SPEC §7.1 example, verbatim.
const coder = {
  name: 'Coder',
  role: 'Owns a task\'s branch',
  kind: 'agent',
  runtime: 'hermes',
  model: { aliases: ['code', 'fast'], effort: 'medium' },
  visibility: 'team',
  triggers: [
    { type: 'task_assigned' },
    { type: 'mention', source: { channels: ['#dev', '#releases'] } },
    { type: 'conversation' },
  ],
  capabilities: {
    native: [
      'tasks.read', 'tasks.claim', 'tasks.complete', 'tasks.handoff', 'messages.*', 'memory.recall',
      'memory.retain', 'files.*', 'pages.write', 'knowledge.search',
    ],
    runtime: ['shell', 'files', 'git'],
    connections: [
      { name: 'github-kahf', tools: ['github.read', 'github.push_branch', 'github.pr.create', 'github.pr.comment'] },
    ],
  },
  knowledge: [{ base: 'architecture-docs' }, { base: 'runbooks' }],
  memory: {
    file: 'memory.md',
    maxLines: 2000,
    people: 'people/<id>.md',
    grants: [{ bank: 'team:engineering', access: 'readwrite' }],
  },
  skills: ['git-hygiene', 'pr-etiquette'],
  guard: { preset: 'strict-egress', gate: ['credential rotation', 'licence change', 'delete production data'] },
  approvals: { needsApproval: [], approvers: ['role:on-call'] },
  handover: { mayTag: ['reviewer', 'tester'], toPerson: ['role:on-call'] },
  placement: { node: 'build-01', isolation: 'shared' },
  limits: { sessionMinutes: 45, hops: 3 },
  contract: { outputs: { sha: 'string', pr: 'url' } },
  evals: { set: 'coder-20', minScore: 0.9 },
};

describe('BotFrontmatter', () => {
  it('accepts the spec example and implies schema 1', () => {
    const parsed = BotFrontmatter.parse(coder);
    expect(parsed.schema).toBe(1);
    expect(parsed.name).toBe('Coder');
  });

  it('accepts an explicit schema: 1 and rejects other versions', () => {
    expect(BotFrontmatter.parse({ ...coder, schema: 1 }).schema).toBe(1);
    expect(BotFrontmatter.safeParse({ ...coder, schema: 2 }).success).toBe(false);
  });

  it('accepts the minimal bot', () => {
    expect(BotFrontmatter.safeParse({ name: 'Echo', role: 'Echoes', kind: 'automation', runtime: 'rules' }).success).toBe(true);
  });

  it('rejects unknown keys at the top level and nested (strict)', () => {
    const top = BotFrontmatter.safeParse({ ...coder, mode: 'autonomous' });
    expect(top.success).toBe(false);
    expect(top.error?.issues[0]?.code).toBe('unrecognized_keys');
    const nested = BotFrontmatter.safeParse({ ...coder, limits: { hops: 3, retries: 1 } });
    expect(nested.success).toBe(false);
    expect(nested.error?.issues[0]?.path).toEqual(['limits']);
  });

  it('rejects bad enum values and a model with neither or both of aliases/subscription', () => {
    expect(BotFrontmatter.safeParse({ ...coder, kind: 'robot' }).success).toBe(false);
    expect(BotFrontmatter.safeParse({ ...coder, model: { effort: 'low' } }).success).toBe(false);
    expect(BotFrontmatter.safeParse({ ...coder, model: { aliases: ['code'], subscription: 'codex' } }).success).toBe(false);
    expect(BotFrontmatter.safeParse({ ...coder, model: { subscription: 'claude-code' } }).success).toBe(true);
  });

  it('allows at most one team-bank grant', () => {
    const grants = [
      { bank: 'team:engineering', access: 'read' },
      { bank: 'team:ops', access: 'read' },
    ];
    expect(BotFrontmatter.safeParse({ ...coder, memory: { grants } }).success).toBe(false);
  });
});

describe('BOT sections', () => {
  it('lists the fourteen §7.2 sections', () => {
    expect(BOT_SECTIONS).toHaveLength(14);
    expect(BotSection.parse('Placement & limits')).toBe('Placement & limits');
    expect(BotSection.safeParse('Mode').success).toBe(false);
  });
});

describe('BotFrontmatter JSON Schema', () => {
  it('is generated and strict', () => {
    expect(botFrontmatterJsonSchema.additionalProperties).toBe(false);
    expect(Object.keys(botFrontmatterJsonSchema.properties)).toContain('capabilities');
  });
});
