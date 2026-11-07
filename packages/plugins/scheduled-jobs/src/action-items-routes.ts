import { type PersonalFilesProvider, type PluginContext, HttpError, conflict, forbidden, invalid, json, notFound, route } from '@manythreads/sdk';
import {
  ACTION_ITEMS_PATH,
  ChangeActionItemRequest,
  ChangeActionItemResponse,
  EMPTY_ACTION_ITEMS_FILE,
  ListActionItemsResponse,
  applyActionItemOp,
  changeActionItemRoute,
  listActionItemsRoute,
  parseActionItemsFile,
} from '@manythreads/shared';
import { requireMemberOrNull } from './personal-limits.ts';

// P20-12: the person's action items. The list is one file in their Personal space (`Action items/action-items.md`), kept by the person here and by the
// "keep my action items" routine; every change is a new version of that file, and a change made on a stale copy is refused so nobody's edit is lost.

/** The recipe id of the routine that keeps the list up to date; the list view shows whether it is on. */
export const ACTION_ITEMS_KEEPER_RECIPE = 'action-items';

export function registerActionItemRoutes(ctx: PluginContext): void {
  const filesOf = (): PersonalFilesProvider => {
    const files = ctx.providers.get<PersonalFilesProvider>('personal.files');
    if (!files) throw new HttpError(503, 'internal', 'Personal files are not available right now');
    return files;
  };

  ctx.http.route({
    ...listActionItemsRoute,
    schema: { response: ListActionItemsResponse },
    handler: route(async (_req, tx) => {
      const member = await requireMemberOrNull(tx);
      if (!member) throw forbidden('Action items are for members of the workspace');
      const file = await filesOf().read(tx, member.personId, ACTION_ITEMS_PATH);
      const keeper = (
        await tx.query<{ id: string }>('SELECT id FROM app.scheduled_jobs WHERE owner_person_id = $1::uuid AND recipe_id = $2 AND enabled ORDER BY created_at LIMIT 1', [
          member.personId,
          ACTION_ITEMS_KEEPER_RECIPE,
        ])
      ).rows[0];
      return json(
        ListActionItemsResponse.parse({
          items: file ? parseActionItemsFile(file.text).slice(0, 200) : [],
          fileId: file?.fileId ?? null,
          revision: file?.revision ?? null,
          updatedAt: file ? file.updatedAt : null,
          keeperRoutineId: keeper?.id ?? null,
        }),
      );
    }),
  });

  ctx.http.route({
    ...changeActionItemRoute,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { body: ChangeActionItemRequest, response: ChangeActionItemResponse },
    handler: route(async (req, tx) => {
      const member = await requireMemberOrNull(tx);
      if (!member) throw forbidden('Action items are for members of the workspace');
      const body = ChangeActionItemRequest.parse(req.body);
      const files = filesOf();
      const file = await files.read(tx, member.personId, ACTION_ITEMS_PATH);
      // a save made since the screen read the list: the screen reloads and the person does it again
      if ((file?.revision ?? null) !== body.revision) throw conflict('The list changed since you opened it. It has been reloaded; try again.');
      const applied = applyActionItemOp(file?.text ?? EMPTY_ACTION_ITEMS_FILE, body.change, ctx.runtime.now());
      if (!applied.ok) {
        if (applied.code === 'not_found') throw notFound(applied.message);
        throw invalid(applied.message);
      }
      const written = await files.write(tx, member.personId, ACTION_ITEMS_PATH, applied.text, {
        mode: file ? 'replace' : 'create',
        expectedRevision: file?.revision ?? undefined,
      });
      const keeper = (
        await tx.query<{ id: string }>('SELECT id FROM app.scheduled_jobs WHERE owner_person_id = $1::uuid AND recipe_id = $2 AND enabled ORDER BY created_at LIMIT 1', [
          member.personId,
          ACTION_ITEMS_KEEPER_RECIPE,
        ])
      ).rows[0];
      return json(
        ChangeActionItemResponse.parse({
          list: {
            items: parseActionItemsFile(applied.text).slice(0, 200),
            fileId: written.file.fileId,
            revision: written.file.revision,
            updatedAt: written.file.updatedAt,
            keeperRoutineId: keeper?.id ?? null,
          },
          id: applied.id,
        }),
      );
    }),
  });
}
