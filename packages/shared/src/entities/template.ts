import { z } from 'zod';

// Team templates (PLAN.md P2-08, SPEC §5.3, §13). A template is data: channel names, a board and bot
// names as text. Channels are created when phase 3 applies it and bots when phase 5 does.
// `teamMd` is read from templates/<id>/TEAM.md by the kernel loader; template.yaml holds the rest.

const TemplateChannel = z
  .object({
    name: z.string().regex(/^#[a-z0-9][a-z0-9-]{0,62}$/, "channel name like '#general'"),
    private: z.boolean().optional(),
    purpose: z.string().min(1).max(250),
  })
  .strict();

const TemplateBoard = z
  .object({
    name: z.string().min(1).max(80),
    columns: z.array(z.string().min(1).max(40)).min(1).max(12),
  })
  .strict();

const TemplateBot = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase slug'),
    name: z.string().min(1).max(80),
    role: z.string().min(1).max(500),
    automation: z.boolean().optional(),
  })
  .strict();

export const TeamTemplate = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase slug'),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    version: z.number().int().positive(),
    channels: z.array(TemplateChannel).min(1).max(30),
    board: TemplateBoard,
    bots: z.array(TemplateBot).min(1).max(30),
    roleTags: z.array(z.string().regex(/^role:[a-z][a-z0-9-]*$/, "role tag like 'role:on-call'")).max(20),
    teamMd: z.string().min(1),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!t.bots.some((b) => b.slug === 'brain')) {
      ctx.addIssue({ code: 'custom', path: ['bots'], message: 'every team template includes Brain (slug "brain")' });
    }
    const dupes = (keys: string[], path: string): void => {
      const seen = new Set<string>();
      for (const k of keys) {
        if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [path], message: `duplicate ${k}` });
        seen.add(k);
      }
    };
    dupes(t.channels.map((c) => c.name), 'channels');
    dupes(t.bots.map((b) => b.slug), 'bots');
    dupes(t.roleTags, 'roleTags');
  });
export type TeamTemplate = z.infer<typeof TeamTemplate>;
