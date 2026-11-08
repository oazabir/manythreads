import { HttpError, type BlobStorage, type InboxDropper, type PluginContext, type TeamRow } from '@manythreads/sdk';
import { dropBytes } from './receive.ts';
import { holdItem } from './states.ts';
import { lockItem } from './util.ts';

// The `inbox.dropper` provider (PLAN P15-11): the meetings plugin files a finished voice room's notes and transcript into a team's memory inbox as one markdown item with
// origin `meeting`. It runs in the caller's system transaction and reuses the inbox's own `dropBytes`, so a meeting gets the same dedupe, the same events and the same
// first job as any other drop; the hold check and the data-loss rules that every drop meets run on it as well.
//
//  * `dropperIds` are the people the item came from (those who said yes to being transcribed). The item can name one dropper: the first of them that is a person of this
//    workspace. That person is told when it is filed or held, as for any drop of theirs.
//  * `hold: 'external'` means a guest was in the room. The item is held at once, before anything reads it, for a lead or admin to release; the database allows a fixed list of
//    hold reasons and "someone from outside the team" is the one this case belongs to (`unknown_sender`), with a sentence that says what happened.
//  * `sourcePath` (where the original transcript is kept) is told to the Archivist inside the item's text, which is how a concept it files comes to point at the transcript
//    and its line times. The platform stamps each concept's `sources` with the inbox original, as for every drop.

/** The most bytes of one meeting item: well over the transcript cap, so the notes and every line fit. */
const MEETING_ITEM_MAX_BYTES = 2_500_000;

const HELD_FOR_GUEST = 'Someone from outside the team was in this call. A lead or admin decides whether its notes are let into the team’s memory.';

export function createInboxDropper(ctx: PluginContext): InboxDropper {
  return {
    id: 'inbox.dropper',
    async drop(tx, input) {
      const team = (await tx.query<TeamRow>('SELECT id, workspace_id, archived_at FROM app.teams WHERE id = $1::uuid', [input.teamId])).rows[0];
      if (!team) throw new HttpError(404, 'not_found', 'That team does not exist');
      if (team.archived_at) throw new HttpError(409, 'conflict', 'This team is archived');
      const storage = ctx.providers.get<BlobStorage>('storage');
      if (!storage) throw new HttpError(503, 'internal', 'File storage is not available');
      const bytes = new TextEncoder().encode(input.markdown);
      if (bytes.length > MEETING_ITEM_MAX_BYTES) throw new HttpError(413, 'validation_failed', 'The meeting is too long to file in one piece');

      const dropper = (
        await tx.query<{ actor_id: string; display_name: string }>(
          `SELECT a.id AS actor_id, p.display_name
             FROM unnest($1::uuid[]) WITH ORDINALITY AS want(id, n)
             JOIN app.actors a ON a.id = want.id AND a.kind = 'person' AND a.workspace_id = $2::uuid
             JOIN app.people p ON p.id = a.ref_id
            ORDER BY want.n LIMIT 1`,
          [[...input.dropperIds], team.workspace_id],
        )
      ).rows[0];

      const done = await dropBytes(ctx, tx, team, storage, bytes, {
        origin: 'meeting',
        kind: 'markdown',
        name: input.name.slice(0, 200),
        teamOnly: false,
        dropperId: dropper?.actor_id ?? null,
        dropperName: dropper?.display_name ?? null,
      });
      if (done.duplicate || input.hold !== 'external') return { itemId: done.item.id, state: done.item.state };

      const row = await lockItem(tx, done.item.id);
      if (!row) return { itemId: done.item.id, state: done.item.state };
      await holdItem(ctx, tx, row, 'unknown_sender', HELD_FOR_GUEST);
      return { itemId: done.item.id, state: 'held' };
    },
  };
}
