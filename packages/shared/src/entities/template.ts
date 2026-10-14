import { z } from 'zod';

// Team templates (PLAN.md P2-08, SPEC §5.3, §13). A template is data: channel names, a board and bot
// names as text. Channels are created when phase 3 applies it and bots when phase 5 does.
// `teamMd` is read from templates/<id>/TEAM.md by the kernel loader; template.yaml holds the rest.
// `files` (PLAN P5-19) are the bot definitions the template ships, read from templates/<id>/bots/<slug>/: BOT.md and
// evals/<set>.yaml. They are written into the team's first commit with TEAM.md (SPEC §5.3: "a template is a folder of
// BOT.md files"), where the bots loader picks them up like any other commit.

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

/** A file a template adds to a new team's first commit besides TEAM.md: a bot's definition or one of its scenario sets, one folder deep. */
export const TEMPLATE_FILE_PATH = /^bots\/[a-z][a-z0-9-]{0,39}\/(BOT\.md|evals\/[a-z0-9][a-z0-9._-]{0,63}\.yaml)$/;
/** Longest template file (UTF-16 code units) and most files a template ships. */
export const TEMPLATE_FILE_MAX_CHARS = 64 * 1024;
export const TEMPLATE_FILES_MAX = 60;

const TemplateFiles = z
  .record(z.string().regex(TEMPLATE_FILE_PATH, 'bots/<slug>/BOT.md or bots/<slug>/evals/<set>.yaml'), z.string().min(1).max(TEMPLATE_FILE_MAX_CHARS))
  .refine((files) => Object.keys(files).length <= TEMPLATE_FILES_MAX, { message: `at most ${TEMPLATE_FILES_MAX} files` });

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
    /** Absent on a template read from an older definition and on the copy a team stores (`templateDefinitionOf`). */
    files: TemplateFiles.optional(),
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
    const botSlugs = new Set(t.bots.map((b) => b.slug));
    for (const path of Object.keys(t.files ?? {})) {
      const slug = path.split('/')[1] ?? '';
      if (!botSlugs.has(slug)) ctx.addIssue({ code: 'custom', path: ['files', path], message: `"${slug}" is not one of the template's bots` });
    }
    dupes(t.channels.map((c) => c.name), 'channels');
    dupes(t.bots.map((b) => b.slug), 'bots');
    dupes(t.roleTags, 'roleTags');
  });
export type TeamTemplate = z.infer<typeof TeamTemplate>;

/**
 * The copy a team keeps of its template (`app.teams.template_definition`): everything but the bot files, which live in the team's repository once its
 * first commit is made and would only be repeated, in full, in every response that carries the team.
 */
export function templateDefinitionOf(template: TeamTemplate): Omit<TeamTemplate, 'files'> {
  const { files, ...rest } = template;
  void files;
  return rest;
}
