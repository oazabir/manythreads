import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { HttpError, forbidden, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  AVATAR_PHOTO_MAX_BYTES,
  MyAvatarResponse,
  PersonIdParams,
  SetMyAvatarRequest,
  UploadMyPhotoRequest,
  personAvatarRoute,
  removeMyAvatarRoute,
  setMyAvatarRoute,
  uploadMyPhotoRoute,
} from '@manythreads/shared';
import { MAX_SIDE, declaredSize, sniffPhoto } from './image.ts';

const refuse = (message: string): HttpError => new HttpError(400, 'validation_failed', message);

/** Writes the caller's own `people.avatar` and answers what is stored now. A person may change only their own (row-level security); a bot or the system has none. */
async function setOwn(tx: PluginTx, avatar: string | null): Promise<string | null> {
  const res = await tx.query<{ avatar: string | null }>('UPDATE app.people SET avatar = $1::text, updated_at = now() WHERE id = app.person_id() RETURNING avatar', [avatar]);
  if (res.rows.length === 0) throw forbidden('Only a person has a profile picture');
  return res.rows[0]!.avatar;
}

/**
 * Profile pictures of people (PLAN P14-23): pick a built-in one, upload a photo, or remove the choice. The bytes of a photo stay in `person_photos`; every
 * member who can see the person can load them. A bot's picture is the bots plugin's route.
 */
export function registerAvatarRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...setMyAvatarRoute,
    schema: { body: SetMyAvatarRequest, response: MyAvatarResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { preset } = SetMyAvatarRequest.parse(req.body);
      const avatar = await setOwn(tx, `preset:${preset}`);
      await tx.query('DELETE FROM app.person_photos WHERE person_id = app.person_id()');
      return json(MyAvatarResponse.parse({ avatar }));
    }),
  });

  ctx.http.route({
    ...uploadMyPhotoRoute,
    schema: { body: UploadMyPhotoRequest, response: MyAvatarResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const body = UploadMyPhotoRequest.parse(req.body);
      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length < 12 || bytes.length > AVATAR_PHOTO_MAX_BYTES) throw refuse(`The photo must be smaller than ${String(AVATAR_PHOTO_MAX_BYTES / 1024)} KB. Choose a smaller picture.`);
      // the first bytes decide what it is; the type the browser declared must agree, and an SVG or anything else is never a photo here
      const type = sniffPhoto(bytes);
      if (type === null || type !== body.contentType) throw refuse('That file is not a PNG, JPEG or WebP picture.');
      const size = declaredSize(bytes, type);
      if (size === null || size.width < 1 || size.height < 1 || size.width > MAX_SIDE || size.height > MAX_SIDE) {
        throw refuse(`The picture must be at most ${String(MAX_SIDE)} pixels wide and high.`);
      }
      const sha = createHash('sha256').update(bytes).digest('hex');
      const own = await tx.query('SELECT 1 FROM app.people WHERE id = app.person_id()');
      if (own.rows.length === 0) throw forbidden('Only a person has a profile picture');
      await tx.query(
        `INSERT INTO app.person_photos (person_id, workspace_id, content_type, bytes, sha256)
         VALUES (app.person_id(), app.workspace_id(), $1, $2, $3)
         ON CONFLICT (person_id) DO UPDATE SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, updated_at = now()`,
        [type, bytes, sha],
      );
      const avatar = await setOwn(tx, `photo:${sha.slice(0, 16)}`);
      return json(MyAvatarResponse.parse({ avatar }));
    }),
  });

  ctx.http.route({
    ...removeMyAvatarRoute,
    schema: { response: MyAvatarResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await setOwn(tx, null);
      await tx.query('DELETE FROM app.person_photos WHERE person_id = app.person_id()');
      return json(MyAvatarResponse.parse({ avatar: null }));
    }),
  });

  // The photo, served from this server. Row-level security decides who may read it; the answer carries headers that stop a browser treating it as anything
  // else. The address carries `?v=<hash>`, so the browser may keep it, and a changed photo has a new address.
  ctx.http.route({
    ...personAvatarRoute,
    rateLimit: { limit: 1200, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { personId } = PersonIdParams.parse(req.params);
      const row = (await tx.query<{ bytes: Buffer; content_type: string; sha256: string }>('SELECT bytes, content_type, sha256 FROM app.person_photos WHERE person_id = $1::uuid', [personId])).rows[0];
      if (!row) throw notFound('There is no such photo.');
      const type = sniffPhoto(row.bytes);
      if (type === null || type !== row.content_type) throw notFound('There is no such photo.');
      const etag = `"${row.sha256.slice(0, 32)}"`;
      const headers: Record<string, string> = {
        etag,
        'cache-control': 'private, max-age=86400, must-revalidate',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      };
      if ((req.headers['if-none-match'] ?? '').split(',').some((t) => t.trim() === etag)) return { status: 304, headers };
      return {
        status: 200,
        body: Readable.from([row.bytes]),
        headers: { ...headers, 'content-type': type, 'content-length': String(row.bytes.length), 'content-disposition': 'inline', 'content-security-policy': "default-src 'none'; sandbox" },
      };
    }),
  });
}
