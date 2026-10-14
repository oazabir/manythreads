import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { BotSlug, PersonId } from '@manythreads/shared';

// Platform writes to a bot's private memory files (SPEC §7.2, §12; PLAN P5-23): `bots/<slug>/lessons.md`
// (the Workshop's lessons file) and `bots/<slug>/people/<id>.md` (per-person notes, e.g. Brain's notes on
// how each person likes answers). Both go through the ONE repo writer as the system actor — never through a
// bot's file capability: the broker's path guard and the writer both deny bot writes under `bots/` whatever
// the grant, while people (team role) and the system are not subject to it. `memory.retain` (the bank) is the
// memory-hindsight plugin's; the bot-facing `memory.write` tool is P5-26.

/** One platform lesson/note: bounded so an entry is linear-time text work, never a megabyte. */
export const PLATFORM_ENTRY_MAX_CHARS = 2000;

/** `bots/<slug>/lessons.md`. The slug is validated so the path cannot name anything outside the bot's folder. */
export function lessonPath(botSlug: string): string {
  return `bots/${BotSlug.parse(botSlug)}/lessons.md`;
}

/** `bots/<slug>/people/<id>.md`. Both segments are validated uuid-or-slug shapes, never raw text. */
export function personNotePath(botSlug: string, personId: string): string {
  return `bots/${BotSlug.parse(botSlug)}/people/${PersonId.parse(personId)}.md`;
}

interface TeamRow extends Record<string, unknown> {
  archived_at: Date | null;
}

const teamLive = async (tx: PluginTx, teamId: string): Promise<boolean> =>
  (await tx.query<TeamRow>('SELECT archived_at FROM app.teams WHERE id = $1::uuid', [teamId])).rows[0]?.archived_at === null;

interface WriterRefusal {
  status?: unknown;
  conflicts?: unknown;
}

const isFileConflict = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as WriterRefusal).status === 409 && Array.isArray((err as WriterRefusal).conflicts) && ((err as WriterRefusal).conflicts as unknown[]).length > 0;

const isRefConflict = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as WriterRefusal).status === 409 && !isFileConflict(err);

const WRITE_ATTEMPTS = 3;

const checkEntry = (text: string): void => {
  if (text.trim() === '') throw new Error('memory: a lesson or note must not be empty');
  if (text.length > PLATFORM_ENTRY_MAX_CHARS) throw new Error(`memory: a lesson or note is at most ${PLATFORM_ENTRY_MAX_CHARS} characters`);
};

const checkSystem = (tx: PluginTx): void => {
  if (tx.actor.kind !== 'system') throw new Error('memory: platform writes run as the system actor, never as a bot or person');
};

/**
 * Append one lesson to the bot's lessons file, as the system, through the one writer. Idempotent per call
 * only in the sense that an append always adds: callers dedupe (P7-06 files a lesson once per correction).
 * A `noop` (identical tail) still commits nothing and returns `{ sha, noop: true }`.
 */
export async function appendLesson(ctx: PluginContext, tx: PluginTx, teamId: string, botSlug: string, text: string): Promise<{ sha: string; noop: boolean }> {
  checkSystem(tx);
  checkEntry(text);
  if (!(await teamLive(tx, teamId))) return { sha: '', noop: true };
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('memory: no repo provider is loaded');
  const path = lessonPath(botSlug);
  const entry = `- ${ctx.runtime.now().toISOString().slice(0, 10)}: ${text.trim()}\n`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await repo.write(tx, teamId, { id: tx.actor.id, kind: 'system' }, [{ path, op: 'append', content: entry }], `memory: lesson for ${botSlug}`);
      return { sha: res.sha, noop: res.noop };
    } catch (err) {
      if ((isFileConflict(err) || isRefConflict(err)) && attempt < WRITE_ATTEMPTS) continue;
      throw err;
    }
  }
}

/**
 * Append one dated note to the bot's file on a person, as the system, through the one writer. The file is
 * the person's own notes (how they like answers, what was learned talking to them) — never team knowledge,
 * never another person's.
 */
export async function appendPersonNote(
  ctx: PluginContext,
  tx: PluginTx,
  teamId: string,
  botSlug: string,
  personId: string,
  text: string,
): Promise<{ sha: string; noop: boolean }> {
  checkSystem(tx);
  checkEntry(text);
  if (!(await teamLive(tx, teamId))) return { sha: '', noop: true };
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('memory: no repo provider is loaded');
  const path = personNotePath(botSlug, personId);
  const entry = `## ${ctx.runtime.now().toISOString().slice(0, 10)}\n${text.trim()}\n`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await repo.write(tx, teamId, { id: tx.actor.id, kind: 'system' }, [{ path, op: 'append', content: entry }], `memory: note for ${botSlug} on a person`);
      return { sha: res.sha, noop: res.noop };
    } catch (err) {
      if ((isFileConflict(err) || isRefConflict(err)) && attempt < WRITE_ATTEMPTS) continue;
      throw err;
    }
  }
}
