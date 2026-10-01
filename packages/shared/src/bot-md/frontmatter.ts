import { z } from 'zod';

// BOT.md frontmatter (SPEC §7.1). Everything a bot author writes is strict (PLAN.md B.2 rule 4).

/** Section names of SPEC §7.2. */
export const BOT_SECTIONS = [
  'Identity',
  'Behaviour',
  'Triggers',
  'Capabilities',
  'Knowledge',
  'Memory',
  'Model',
  'Guard',
  'Approvals',
  'Handover',
  'Placement & limits',
  'Contract',
  'Evals',
  'Audit',
] as const;
export const BotSection = z.enum(BOT_SECTIONS);
export type BotSection = z.infer<typeof BotSection>;

/** Lower-case slug used for aliases, presets, bases, skills, nodes. */
const Slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"');
/** Channel reference such as "#dev". */
const ChannelRef = z.string().regex(/^#[a-z0-9][a-z0-9._-]*$/, 'a channel reference like "#dev"');
/** `role:on-call` or `person:<id>`. */
const Principal = z.string().regex(/^(role|person):[^\s:]+$/, 'role:<name> or person:<id>');
/** `namespace.verb`, optionally `namespace.*`. */
const CapabilityName = z.string().regex(/^[a-z][a-z0-9_]*(\.([a-z][a-z0-9_]*|\*))+$/, 'namespace.verb or namespace.*');

export const BotKind = z.enum(['agent', 'automation']);
export type BotKind = z.infer<typeof BotKind>;

export const BotRuntime = z.enum(['hermes', 'rules']);
export type BotRuntime = z.infer<typeof BotRuntime>;

export const BotVisibility = z.enum(['team', 'workspace']);
export type BotVisibility = z.infer<typeof BotVisibility>;

const Source = z.strictObject({ channels: z.array(ChannelRef).min(1) });

export const BotTrigger = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('conversation') }),
  z.strictObject({ type: z.literal('mention'), source: Source.optional() }),
  z.strictObject({ type: z.literal('routine'), routine: Slug.optional(), cron: z.string().min(1).optional() }),
  z.strictObject({ type: z.literal('task_assigned') }),
  z.strictObject({
    type: z.literal('inbox'),
    connection: Slug.optional(),
    folder: z.string().min(1).optional(),
    filter: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal('channel_message'), source: Source.optional() }),
  z.strictObject({ type: z.literal('webhook'), connection: Slug.optional(), event: z.string().min(1).optional() }),
]);
export type BotTrigger = z.infer<typeof BotTrigger>;

const ModelBudgets = z.strictObject({
  dailyUsd: z.number().nonnegative().optional(),
  monthlyUsd: z.number().nonnegative().optional(),
  maxTokensPerRun: z.number().int().positive().optional(),
});

export const BotModelConfig = z
  .strictObject({
    aliases: z.array(Slug).min(1).optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
    fallbacks: z.array(Slug).optional(),
    budgets: ModelBudgets.optional(),
    rateLimit: z.strictObject({ requestsPerMinute: z.number().int().positive() }).optional(),
    /** Binds a subscription runtime (SPEC §10.3) instead of gateway aliases. */
    subscription: z.enum(['claude-code', 'codex']).optional(),
  })
  .refine((m) => (m.aliases === undefined) !== (m.subscription === undefined), {
    message: 'set either aliases or subscription, not both and not neither',
    path: ['aliases'],
  });
export type BotModelConfig = z.infer<typeof BotModelConfig>;

export const BotCapabilities = z.strictObject({
  native: z.array(CapabilityName).optional(),
  runtime: z.array(Slug).optional(),
  connections: z
    .array(
      z.strictObject({
        /** `person:*` means the asking person's own connections. */
        name: z.union([Slug, z.literal('person:*')]),
        tools: z.array(CapabilityName).min(1),
      }),
    )
    .optional(),
});
export type BotCapabilities = z.infer<typeof BotCapabilities>;

export const BotKnowledgeEntry = z.strictObject({
  base: Slug,
  answer_only_from: z.boolean().optional(),
});
export type BotKnowledgeEntry = z.infer<typeof BotKnowledgeEntry>;

export const BotMemory = z.strictObject({
  file: z.string().min(1).optional(),
  maxLines: z.number().int().positive().optional(),
  people: z.string().min(1).optional(),
  /** One team-bank grant (SPEC §7.2); the bank is derived by the platform, never chosen by the bot. */
  grants: z
    .array(z.strictObject({ bank: z.string().regex(/^team:[a-z0-9][a-z0-9-]*$/), access: z.enum(['read', 'readwrite']) }))
    .max(1)
    .optional(),
});
export type BotMemory = z.infer<typeof BotMemory>;

export const BotGuard = z.strictObject({
  preset: Slug.optional(),
  rules: z.array(z.string().min(1)).optional(),
  gate: z.array(z.string().min(1)).optional(),
});
export type BotGuard = z.infer<typeof BotGuard>;

export const BotApprovals = z.strictObject({
  needsApproval: z.array(CapabilityName).optional(),
  approvers: z.array(Principal).optional(),
});
export type BotApprovals = z.infer<typeof BotApprovals>;

export const BotHandover = z.strictObject({
  mayTag: z.array(Slug).optional(),
  toPerson: z.array(Principal).optional(),
  escalation: z
    .strictObject({ to: z.array(Principal).min(1), afterMinutes: z.number().int().positive().optional() })
    .optional(),
});
export type BotHandover = z.infer<typeof BotHandover>;

export const BotPlacement = z
  .strictObject({
    node: Slug.optional(),
    runner: Slug.optional(),
    requires: z.array(Slug).optional(),
    isolation: Slug.optional(),
  })
  .refine((p) => p.node === undefined || p.runner === undefined, {
    message: 'set either node or runner, not both',
    path: ['runner'],
  });
export type BotPlacement = z.infer<typeof BotPlacement>;

export const BotLimits = z.strictObject({
  sessionMinutes: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  hops: z.number().int().nonnegative().optional(),
});
export type BotLimits = z.infer<typeof BotLimits>;

export const ContractValueType = z.enum(['string', 'number', 'boolean', 'url', 'datetime']);
export type ContractValueType = z.infer<typeof ContractValueType>;

export const BotContract = z.strictObject({
  outputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), ContractValueType),
});
export type BotContract = z.infer<typeof BotContract>;

export const BotEvals = z.strictObject({
  set: Slug,
  minScore: z.number().min(0).max(1),
});
export type BotEvals = z.infer<typeof BotEvals>;

export const BotFrontmatter = z.strictObject({
  /** Implied 1; a later version writes the key explicitly (PLAN.md B.4 rule 5). */
  schema: z.literal(1).default(1),
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(200),
  kind: BotKind,
  runtime: BotRuntime,
  model: BotModelConfig.optional(),
  visibility: BotVisibility.optional(),
  triggers: z.array(BotTrigger).optional(),
  capabilities: BotCapabilities.optional(),
  knowledge: z.array(BotKnowledgeEntry).optional(),
  memory: BotMemory.optional(),
  skills: z.array(Slug).optional(),
  guard: BotGuard.optional(),
  approvals: BotApprovals.optional(),
  handover: BotHandover.optional(),
  placement: BotPlacement.optional(),
  limits: BotLimits.optional(),
  contract: BotContract.optional(),
  evals: BotEvals.optional(),
});
export type BotFrontmatter = z.infer<typeof BotFrontmatter>;
