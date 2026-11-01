import { AVATAR_PRESETS, GetTeamRosterResponse, ListBotsResponse, avatarSrc } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, lena } = personas;

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

// A 1x1 PNG, a 2000x2000 PNG header (small file, huge bitmap) and an SVG.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const hugePng = (): Buffer => {
  const b = Buffer.from(PNG_1X1);
  b.writeUInt32BE(2000, 16);
  b.writeUInt32BE(2000, 20);
  return b;
};
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const rosterAvatar = async (viewer: Persona, of: Persona): Promise<string | null | undefined> =>
  GetTeamRosterResponse.parse(ok(await w.call(viewer, 'GET', '/api/teams/engineering/roster'))).members.find((m) => m.personId === of.personId)?.avatar;
const upload = (who: Persona, bytes: Buffer, contentType = 'image/png'): Promise<ApiResult> =>
  w.call(who, 'PUT', '/api/me/avatar/photo', { contentType, data: bytes.toString('base64') });
const photo = (who: Persona, of: Persona, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${w.server.url}/api/people/${of.personId}/avatar`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }), ...headers } });

describe('the catalogue', () => {
  it('has 40 pictures: 10 men, 5 women in a hijab, 5 other women and 20 for bots, each with a picture file', () => {
    const count = (g: string): number => AVATAR_PRESETS.filter((p) => p.group === g).length;
    expect([count('man'), count('hijab'), count('woman'), count('bot')]).toEqual([10, 5, 5, 20]);
    expect(new Set(AVATAR_PRESETS.map((p) => p.id)).size).toBe(40);
    expect(avatarSrc('preset:man-1')).toBe('/avatars/man-1.webp');
    expect(avatarSrc('preset:nope')).toBeNull();
    expect(avatarSrc(null)).toBeNull();
  });
});

describe('a person chooses a built-in picture', () => {
  it('starts with none, and the roster shows the choice to the team', async () => {
    expect(await rosterAvatar(omar, nadia)).toBeNull();
    expect(ok<{ avatar: string }>(await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'hijab-3' })).avatar).toBe('preset:hijab-3');
    expect(await rosterAvatar(omar, nadia)).toBe('preset:hijab-3');
    expect(await rosterAvatar(nadia, omar)).toBeNull();
  });

  it('refuses a bot picture, an unknown id and extra fields', async () => {
    expect((await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'bot-panda' })).status).toBe(400);
    expect((await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'man-99' })).status).toBe(400);
    expect((await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'man-1', extra: 1 })).status).toBe(400);
    expect((await w.call(null, 'PUT', '/api/me/avatar', { preset: 'man-1' })).status).toBe(401);
    expect(await rosterAvatar(omar, nadia)).toBe('preset:hijab-3');
  });

  it('can be removed: the initials are drawn again', async () => {
    expect(ok<{ avatar: null }>(await w.call(nadia, 'DELETE', '/api/me/avatar')).avatar).toBeNull();
    expect(await rosterAvatar(omar, nadia)).toBeNull();
  });
});

describe('a person uploads a photo', () => {
  it('stores it, shows it in the roster and serves it to a member (with a cache check)', async () => {
    const res = ok<{ avatar: string }>(await upload(nadia, PNG_1X1));
    expect(res.avatar).toMatch(/^photo:[0-9a-f]{16}$/);
    expect(await rosterAvatar(omar, nadia)).toBe(res.avatar);
    const got = await photo(omar, nadia);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG_1X1)).toBe(true);
    const again = await photo(omar, nadia, { 'if-none-match': got.headers.get('etag')! });
    expect(again.status).toBe(304);
  });

  it('a guest cannot load a member\'s photo; nobody can load a photo that does not exist', async () => {
    expect((await photo(lena, nadia)).status).toBe(404);
    expect((await photo(omar, omar)).status).toBe(404);
  });

  it('refuses an SVG, a file whose type is wrong, a huge bitmap and text', async () => {
    expect((await upload(nadia, SVG, 'image/png')).status).toBe(400);
    expect((await w.call(nadia, 'PUT', '/api/me/avatar/photo', { contentType: 'image/svg+xml', data: SVG.toString('base64') })).status).toBe(400);
    expect((await upload(nadia, PNG_1X1, 'image/jpeg')).status).toBe(400);
    expect((await upload(nadia, hugePng())).status).toBe(400);
    expect((await upload(nadia, Buffer.from('this is not a picture at all'))).status).toBe(400);
    expect((await upload(nadia, Buffer.concat([PNG_1X1, Buffer.alloc(262_144)]))).status).toBe(400);
  });

  it('choosing a built-in picture afterwards removes the photo', async () => {
    ok(await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'woman-2' }));
    expect((await photo(omar, nadia)).status).toBe(404);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.person_photos WHERE person_id = $1', [nadia.personId])).rows.length)).toBe(0);
  });

  it('a person cannot write another person\'s picture', async () => {
    ok(await upload(omar, PNG_1X1));
    expect(await rosterAvatar(nadia, omar)).toMatch(/^photo:/);
    expect(await rosterAvatar(omar, nadia)).toBe('preset:woman-2');
  });
});

describe('a bot\'s picture', () => {
  const botSlug = 'avatar-probe';
  beforeAll(async () => {
    await w.system(async (tx) => {
      const team = (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id;
      await tx.query(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, may_tag, model_aliases)
         VALUES ($1, $2, $3, 'Avatar probe', 'a probe', 'agent', 'hermes', 'team', $4, 'active', '{}', '{}')`,
        [omar.workspaceId, team, botSlug, 'a'.repeat(64)],
      );
    });
  });
  const set = (who: Persona, preset: string | null, extra: Record<string, unknown> = {}): Promise<ApiResult> =>
    w.call(who, 'PUT', `/api/teams/engineering/bots/${botSlug}/avatar`, { preset, ...extra });
  const listed = async (who: Persona): Promise<string | null | undefined> =>
    ListBotsResponse.parse(ok(await w.call(who, 'GET', '/api/teams/engineering/bots'))).bots.find((b) => b.slug === botSlug)?.avatar;

  it('a workspace admin (or the team\'s lead) chooses one of the bot pictures; the roster shows it', async () => {
    expect(await listed(nadia)).toBeNull();
    expect(ok<{ avatar: string }>(await set(omar, 'bot-panda')).avatar).toBe('preset:bot-panda');
    expect(await listed(nadia)).toBe('preset:bot-panda');
  });

  it('a member who is not a lead is refused, a person picture is not a bot picture, and null clears it', async () => {
    expect((await set(nadia, 'bot-lion')).status).toBe(403);
    expect((await set(omar, 'man-1')).status).toBe(400);
    expect((await set(omar, 'bot-nope')).status).toBe(400);
    expect(await listed(nadia)).toBe('preset:bot-panda');
    expect(ok<{ avatar: null }>(await set(omar, null)).avatar).toBeNull();
    expect(await listed(nadia)).toBeNull();
  });
});
