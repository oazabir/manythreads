import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('lists at most 50 knowledge bases, and says so in plain words (the database holds no more per bot)', () => {
    const many = (n: number) => ({ ...coder, knowledge: Array.from({ length: n }, (_, i) => ({ base: `base-${String(i)}` })) });
    expect(BotFrontmatter.safeParse(many(50)).success).toBe(true);
    const over = BotFrontmatter.safeParse(many(51));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe('A bot can list at most 50 knowledge bases.');
  });

  describe('placement.runs_on (a runner by name)', () => {
    const placed = (placement: Record<string, unknown>) => BotFrontmatter.safeParse({ ...coder, placement });
    it('accepts a runner name, alone or with requires and isolation', () => {
      expect(placed({ runs_on: 'host' }).success).toBe(true);
      expect(placed({ runs_on: 'team-pod', requires: ['chrome'], isolation: 'shared' }).success).toBe(true);
    });
    it('refuses a name that is not a runner name', () => {
      for (const bad of ['Host', 'two words', 'https://gw.example', '', 'a'.repeat(64), '-x']) expect(placed({ runs_on: bad }).success).toBe(false);
    });
    it('refuses runs_on together with gateway, node or runner, naming the field', () => {
      for (const other of [{ gateway: { connection: 'managed' } }, { node: 'build-01' }, { runner: 'server-1' }]) {
        const r = placed({ runs_on: 'host', ...other });
        expect(r.success).toBe(false);
        expect(r.error?.issues.some((i) => i.path.join('.') === 'placement.runs_on' && /cannot be combined/.test(i.message))).toBe(true);
      }
    });
    it('keeps the older placements valid on their own', () => {
      expect(placed({ gateway: { connection: 'managed' } }).success).toBe(true);
      expect(placed({ node: 'build-01' }).success).toBe(true);
      expect(placed({ runner: 'server-1' }).success).toBe(true);
    });
  });

  it('allows at most one team-bank grant', () => {
    const grants = [
      { bank: 'team:engineering', access: 'read' },
      { bank: 'team:ops', access: 'read' },
    ];
    expect(BotFrontmatter.safeParse({ ...coder, memory: { grants } }).success).toBe(false);
  });
});

describe('capabilities: native and connections never share a tool (PLAN P8-28)', () => {
  const withCaps = (capabilities: unknown) => BotFrontmatter.safeParse({ ...coder, capabilities });
  const issue = (result: ReturnType<typeof withCaps>) => (result.success ? undefined : result.error.issues[0]);

  it('refuses a tool that is in both lists, naming the field and the tool', () => {
    const result = withCaps({ native: ['email.send'], connections: [{ name: 'support-mail', tools: ['email.read', 'email.send'] }] });
    expect(result.success).toBe(false);
    expect(issue(result)?.path).toEqual(['capabilities', 'connections', 0, 'tools', 1]);
    expect(issue(result)?.message).toContain('email.send');
    expect(issue(result)?.message).toContain('capabilities.native');
  });

  it('a namespace wildcard in native covers the connection’s tool too', () => {
    const result = withCaps({ native: ['email.*'], connections: [{ name: 'support-mail', tools: ['email.read'] }] });
    expect(result.success).toBe(false);
    expect(issue(result)?.message).toContain('email.*');
    // a wildcard of another namespace does not
    expect(withCaps({ native: ['messages.*'], connections: [{ name: 'support-mail', tools: ['email.read'] }] }).success).toBe(true);
    // and `email.*` does not cover a tool of a namespace that merely starts the same way
    expect(withCaps({ native: ['email.*'], connections: [{ name: 'x', tools: ['emailer.read'] }] }).success).toBe(true);
  });

  it('refuses the same tool through two different connections (one grant per tool), but not twice through the person’s own', () => {
    const twice = withCaps({ connections: [{ name: 'mail-a', tools: ['email.read'] }, { name: 'mail-b', tools: ['email.read'] }] });
    expect(twice.success).toBe(false);
    expect(issue(twice)?.path).toEqual(['capabilities', 'connections', 1, 'tools', 0]);
    expect(issue(twice)?.message).toContain('mail-a');
    expect(withCaps({ connections: [{ name: 'mail-a', tools: ['email.read'] }, { name: 'person:*', tools: ['email.read'] }] }).success).toBe(true);
  });

  it('accepts the lists when they do not overlap', () => {
    expect(withCaps({ native: ['messages.*', 'tasks.read'], connections: [{ name: 'support-mail', tools: ['email.read', 'email.send'] }] }).success).toBe(true);
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

  it('committed file matches the Zod schema (re-run gen:json-schema if this fails)', () => {
    expect(botFrontmatterJsonSchema).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(BotFrontmatter, { io: 'input' }))));
  });
});
