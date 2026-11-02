import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { splitBotMd } from './render.ts';

// The setup profile (PLAN P7-02, `templates/_setup/PROFILE.md`): what the "Add a bot" helper is told and which tools it may use. It is a file with a frontmatter
// block and a prompt, like a BOT.md, but it is not a bot: no actor, no grants, no triggers. The tools are a fixed list the server implements; the file can
// only leave some out, never add one.

/** The only tools the helper has. `knowledge_search` is the platform's read-only `knowledge.search`; a model provider accepts no dot in a tool name. */
export const SETUP_TOOLS = ['describe_self', 'knowledge_search', 'ask_clarification', 'propose_config'] as const;
export const SetupTool = z.enum(SETUP_TOOLS);
export type SetupTool = z.infer<typeof SetupTool>;

const Alias = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

export const SetupProfile = z.strictObject({
  schema: z.literal(1).default(1),
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(200),
  /** The model aliases to try in order; the first one the workspace has bound is used. */
  model: z.strictObject({ aliases: z.array(Alias).min(1).max(3) }),
  tools: z.array(SetupTool).min(1).max(SETUP_TOOLS.length),
  limits: z.strictObject({ steps: z.number().int().min(1).max(12).optional() }).optional(),
});
export type SetupProfile = z.infer<typeof SetupProfile>;

export type SetupProfileResult = { ok: true; profile: SetupProfile; prompt: string } | { ok: false; message: string };

/** Reads the profile file. The prompt is everything after the frontmatter. */
export function parseSetupProfile(content: string): SetupProfileResult {
  const split = splitBotMd(content);
  if (!split.ok) return { ok: false, message: split.failure.message.replace('BOT.md', 'PROFILE.md') };
  let doc: unknown;
  try {
    doc = parseYaml(split.frontmatter, { maxAliasCount: 20 });
  } catch (err) {
    return { ok: false, message: `frontmatter: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = SetupProfile.safeParse(doc);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'profile'}: ${i.message}`).join('; ') };
  if (new Set(parsed.data.tools).size !== parsed.data.tools.length) return { ok: false, message: 'tools: a tool is listed twice' };
  const prompt = split.body.trim();
  if (prompt === '') return { ok: false, message: 'the profile has no prompt' };
  return { ok: true, profile: parsed.data, prompt };
}
