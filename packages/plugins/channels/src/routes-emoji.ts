import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PluginTx } from '@manythreads/sdk';
import {
  AddCustomEmojiRequest,
  AddCustomEmojiResponse,
  CUSTOM_EMOJI_MAX_BYTES,
  CustomEmojiPathParams,
  DeleteCustomEmojiResponse,
  ListCustomEmojiResponse,
  addCustomEmojiRoute,
  customEmojiImageRoute,
  deleteCustomEmojiRoute,
  emojiImageInfo,
  emojiImageProblem,
  listCustomEmojiRoute,
  sniffEmojiImage,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route } from './http.ts';
import { CUSTOM_EMOJI_COLUMNS, toCustomEmoji, type CustomEmojiRow } from './rows.ts';
import type { Deps } from './service.ts';

async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can add or remove custom emoji.');
}

/**
 * Custom emoji (PLAN P14-02): the pictures a workspace admin adds, written `:name:`. Everyone in the workspace lists them and fetches a picture; adding and
 * removing need an owner or admin (the table's policies say so as well, so a route that forgot to check would still be refused). Each change is an
 * event, and the audit log shows it ("Added a custom emoji"). The picture is validated by its first bytes, never by the name the browser gives it.
 */
export function registerEmojiRoutes(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...listCustomEmojiRoute,
    schema: { response: ListCustomEmojiResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      const res = await tx.query<CustomEmojiRow>(`SELECT ${CUSTOM_EMOJI_COLUMNS} FROM app.custom_emoji ORDER BY name`);
      return json(ListCustomEmojiResponse.parse({ items: res.rows.map(toCustomEmoji) }));
    }),
  });

  ctx.http.route({
    ...addCustomEmojiRoute,
    schema: { body: AddCustomEmojiRequest, response: AddCustomEmojiResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const body = AddCustomEmojiRequest.parse(req.body);
      await requireWorkspaceAdmin(tx);
      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length > CUSTOM_EMOJI_MAX_BYTES) throw invalid(`data: a picture is at most ${CUSTOM_EMOJI_MAX_BYTES / 1024} KiB`);
      const type = sniffEmojiImage(bytes);
      if (type === null) throw invalid('data: that file is not a PNG, JPEG, GIF or WebP picture');
      if (type !== body.contentType) throw invalid(`contentType: the file is ${type}, not ${body.contentType}`);
      // the header's size and frame count (nothing is decoded): a "small" emoji stays small, and an animation cannot be a long video
      const sizeProblem = emojiImageProblem(emojiImageInfo(bytes)!);
      if (sizeProblem) throw invalid(`data: ${sizeProblem}`);
      const taken = await tx.query('SELECT 1 FROM app.custom_emoji WHERE name = $1', [body.name]);
      if (taken.rows.length > 0) throw conflict(`:${body.name}: is already a custom emoji. Choose another name.`);
      // the count cap and the name's uniqueness are the table's too (a trigger and a unique index): a race ends in the same sentence
      const res = await tx.query<CustomEmojiRow>(
        `INSERT INTO app.custom_emoji (workspace_id, name, content_type, bytes, created_by)
         VALUES (app.workspace_id(), $1, $2, $3, app.actor()) RETURNING ${CUSTOM_EMOJI_COLUMNS}`,
        [body.name, type, bytes],
      );
      const row = res.rows[0]!;
      await ctx.audit.emit(tx, {
        type: 'channel.custom_emoji.changed',
        workspaceId: tx.actor.workspaceId,
        emojiId: row.id,
        name: row.name,
        change: 'added',
        changedBy: tx.actor.id,
        at: ctx.runtime.now().toISOString(),
      });
      return json(AddCustomEmojiResponse.parse(toCustomEmoji(row)), 201);
    }),
  });

  ctx.http.route({
    ...deleteCustomEmojiRoute,
    schema: { response: DeleteCustomEmojiResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { emojiId } = CustomEmojiPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const res = await tx.query<{ id: string; name: string }>('DELETE FROM app.custom_emoji WHERE id = $1 RETURNING id, name', [emojiId]);
      const gone = res.rows[0];
      if (gone) {
        await ctx.audit.emit(tx, {
          type: 'channel.custom_emoji.changed',
          workspaceId: tx.actor.workspaceId,
          emojiId: gone.id,
          name: gone.name,
          change: 'deleted',
          changedBy: tx.actor.id,
          at: ctx.runtime.now().toISOString(),
        });
      }
      return json(DeleteCustomEmojiResponse.parse({ deleted: gone !== undefined }));
    }),
  });

  // The picture. The bytes are sniffed again on the way out (a row can only hold what the route let in, but the answer must never be anything else), the
  // browser may not guess another type, and the answer carries a policy that makes it inert even if it were opened on its own.
  ctx.http.route({
    ...customEmojiImageRoute,
    rateLimit: { limit: 1200, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { emojiId } = CustomEmojiPathParams.parse(req.params);
      const row = (await tx.query<{ bytes: Buffer; content_type: string }>('SELECT bytes, content_type FROM app.custom_emoji WHERE id = $1', [emojiId])).rows[0];
      if (!row) throw notFound('There is no such emoji.');
      const type = sniffEmojiImage(row.bytes);
      if (type === null || type !== row.content_type) throw notFound('There is no such emoji.');
      // the browser may keep it but asks each time (the ETag answers 304): a removed emoji must stop being served, not linger for a day in a cache
      const etag = `"${createHash('sha256').update(row.bytes).digest('hex').slice(0, 32)}"`;
      const headers: Record<string, string> = {
        etag,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      };
      if ((req.headers['if-none-match'] ?? '').split(',').some((t) => t.trim() === etag)) return { status: 304, headers };
      return {
        status: 200,
        body: Readable.from([row.bytes]),
        headers: {
          ...headers,
          'content-type': type,
          'content-length': String(row.bytes.length),
          'content-disposition': 'inline',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      };
    }),
  });
}
