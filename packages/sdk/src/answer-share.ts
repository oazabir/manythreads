import { createHash } from 'node:crypto';
import {
  AnswerPayload,
  citationNumbers,
  maskAnswer,
  type CitationVerdict,
  type MaskedAnswer,
} from '@manythreads/shared';
import { z } from 'zod';
import { invalid, notFound } from './http.ts';
import { HttpError, type PluginTx } from './types.ts';

// Sharing an answer of one's own conversation, as the plugins that do it see it (PLAN P5-17): `conversations` (share to a channel, hand to a bot)
// and `pages` (save as a page) arrive at the same copy through the same steps, so the steps are here once:
//
//   1. `loadShareView`: the answer and the database's verdicts on it against a target (`app.answer_share_view`, answer migration 0003) — or a 404;
//   2. `storedAnswer`, `checkRemove`: the stored payload, and the claims to remove, which must be citations the answer has;
//   3. `buildCopy`: the copy for the readers of the target, made by `maskAnswer` (shared) from the stored answer and nothing else;
//   4. `shareDigest`: what the person confirms (the target and the copy), as a hash the share takes back.
//
// A request names an answer by its message and says which claims to remove by number: nothing a request carries becomes text of the copy.

const UUID = z.uuid();

/** What `app.answer_share_view` answers, parsed once at the boundary: a change to the SQL that drops a field fails here, loudly. */
export const AnswerShareView = z.object({
  answer: z.object({
    messageId: UUID,
    channelId: UUID,
    threadRootId: UUID.nullable(),
    teamId: UUID,
    botId: UUID,
    personId: UUID,
    payload: z.unknown(),
  }),
  target: z
    .object({
      kind: z.string(),
      channelId: UUID.nullable(),
      name: z.string().nullable(),
      teamId: UUID.nullable(),
      private: z.boolean(),
      archived: z.boolean(),
      canPost: z.boolean(),
    })
    .nullable(),
  /** Who reads the target: `asker` (their own conversation alone), `team` (the answer's team and admins), `none` (somebody else may too). */
  reach: z.enum(['asker', 'team', 'none']),
  citations: z.array(z.object({ n: z.number().int(), kept: z.boolean(), label: z.string().nullable().optional(), at: z.string().nullable().optional() })),
  sources: z.array(z.object({ kept: z.boolean(), label: z.string().nullable().optional() })),
});
export type AnswerShareView = z.infer<typeof AnswerShareView>;

const iso = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * The caller's own answer and the verdicts of the database on it against `target`: a channel, `'page'` (the team's pages), or `null` (only "is this
 * answer the caller's"). 404 for anything else — a message that is not an answer, an answer of another person (an admin included), one that was
 * deleted, one in another channel than the address says: all alike, so the route is no way to learn that a message exists.
 */
export async function loadShareView(
  tx: PluginTx,
  params: { channelId: string; messageId: string },
  target: { channelId: string } | 'page' | null,
): Promise<AnswerShareView> {
  const raw = (
    await tx.query<{ v: unknown }>('SELECT app.answer_share_view($1::uuid, $2::uuid, $3::boolean) AS v', [
      params.messageId,
      target !== null && target !== 'page' ? target.channelId : null,
      target === 'page',
    ])
  ).rows[0]?.v;
  if (raw === null || raw === undefined) throw notFound('No such answer');
  const view = AnswerShareView.parse(raw);
  if (view.answer.channelId !== params.channelId) throw notFound('No such answer');
  return view;
}

/** The stored answer, read with the shared schema; an answer of a shape this server does not know is not shared (422). */
export function storedAnswer(view: AnswerShareView): AnswerPayload {
  const parsed = AnswerPayload.safeParse(view.answer.payload);
  if (!parsed.success) throw new HttpError(422, 'validation_failed', 'This answer is of a shape that cannot be shared.');
  return parsed.data;
}

/** The claims to remove must be citations the answer has (400 otherwise); the numbers come back unique and ascending. */
export function checkRemove(payload: AnswerPayload, remove: readonly number[]): number[] {
  const have = new Set(citationNumbers(payload));
  const unique = [...new Set(remove)].sort((a, b) => a - b);
  for (const n of unique) if (!have.has(n)) throw invalid(`remove: ${String(n)} is not a citation of this answer`);
  return unique;
}

/** The copy of the answer for the readers the view describes, with the claims taken out. 422 when nothing would be left. */
export function buildCopy(view: AnswerShareView, payload: AnswerPayload, remove: readonly number[]): MaskedAnswer & { copy: AnswerPayload } {
  const verdicts: CitationVerdict[] = view.citations.map((c) => ({ n: c.n, kept: c.kept, label: c.label ?? null, at: iso(c.at) }));
  const masked = maskAnswer(payload, verdicts, view.sources, remove);
  if (masked.copy === null) throw new HttpError(422, 'validation_failed', 'Removing those claims leaves nothing to share.');
  return { ...masked, copy: masked.copy };
}

/**
 * What the person confirms: the target and the copy, as one sha-256. A page's file name is not part of it (it carries the day), a channel is
 * `channel:<id>`, the pages are `page`.
 */
export const shareDigest = (target: string, messageId: string, copy: AnswerPayload): string =>
  createHash('sha256').update(JSON.stringify({ target, messageId, copy })).digest('hex');
