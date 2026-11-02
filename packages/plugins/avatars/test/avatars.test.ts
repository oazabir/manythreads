import { AVATAR_PRESETS, BOT_ANIMAL_AVATAR_PRESETS, BOT_AVATAR_PRESETS, GetTeamRosterResponse, ListBotsResponse, OFFERED_AVATAR_PRESETS, PERSON_AVATAR_PRESETS, avatarSrc } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, lena, tariq, priya } = personas;

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
  it('offers 50 pictures: 15 men, 5 women, 5 women in a hijab, 19 animals and 6 for Brain, each with a picture file; the 40 first ones only keep drawing', () => {
    const count = (g: string): number => OFFERED_AVATAR_PRESETS.filter((p) => p.group === g).length;
    expect([count('man'), count('woman'), count('hijab'), count('bot'), count('brain')]).toEqual([15, 5, 5, 19, 6]);
    expect(AVATAR_PRESETS).toHaveLength(90);
    expect(new Set(AVATAR_PRESETS.map((p) => p.id)).size).toBe(90);
    expect(PERSON_AVATAR_PRESETS).toHaveLength(25);
    expect(BOT_AVATAR_PRESETS).toHaveLength(25);
    expect(avatarSrc('preset:man-20-casual')).toBe('/avatars/man-20-casual.svg');
    expect(avatarSrc('preset:man-1')).toBe('/avatars/man-1.webp');
    expect(avatarSrc('preset:nope')).toBeNull();
    expect(avatarSrc(null)).toBeNull();
  });

  it('every id of the library fits the bots column check (bot pictures start with bot-)', () => {
    for (const p of BOT_AVATAR_PRESETS) expect(`preset:${p.id}`, p.id).toMatch(/^preset:bot-[a-z0-9-]{1,36}$/);
    expect(BOT_ANIMAL_AVATAR_PRESETS).toHaveLength(19);
    expect(BOT_ANIMAL_AVATAR_PRESETS.some((p) => p.group === 'brain')).toBe(false);
  });
});

describe('a person chooses a built-in picture', () => {
  it('starts with none, and the roster shows the choice to the team', async () => {
    expect(await rosterAvatar(omar, nadia)).toBeNull();
    expect(ok<{ avatar: string }>(await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'hijab-30-formal' })).avatar).toBe('preset:hijab-30-formal');
    expect(await rosterAvatar(omar, nadia)).toBe('preset:hijab-30-formal');
    expect(await rosterAvatar(nadia, omar)).toBeNull();
  });

  it('refuses a bot picture, an unknown id and extra fields', async () => {
    expect((await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'bot-noto-panda' })).status).toBe(400);
    expect((await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'bot-brain-chip' })).status).toBe(400);
    expect((await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'man-99' })).status).toBe(400);
    expect((await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'man-30-formal', extra: 1 })).status).toBe(400);
    expect((await w.call(null, 'PUT', '/api/me/avatar', { preset: 'man-30-formal' })).status).toBe(401);
    // a picture of the first library is no longer offered, so it cannot be chosen again
    expect((await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'man-1' })).status).toBe(400);
    expect(await rosterAvatar(omar, nadia)).toBe('preset:hijab-30-formal');
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
    ok(await w.call(nadia, 'PUT', '/api/me/avatar', { preset: 'modest-20-formal' }));
    expect((await photo(omar, nadia)).status).toBe(404);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.person_photos WHERE person_id = $1', [nadia.personId])).rows.length)).toBe(0);
  });

  it('a person cannot write another person\'s picture', async () => {
    ok(await upload(omar, PNG_1X1));
    expect(await rosterAvatar(nadia, omar)).toMatch(/^photo:/);
    expect(await rosterAvatar(omar, nadia)).toBe('preset:modest-20-formal');
  });
});

describe('a picture of the first library', () => {
  it('keeps drawing for the person who chose it, in the roster the others read', async () => {
    await w.system((tx) => tx.query('UPDATE app.people SET avatar = $1 WHERE id = $2', ['preset:man-3', priya.personId]));
    expect(await rosterAvatar(omar, priya)).toBe('preset:man-3');
    expect(avatarSrc('preset:man-3')).toBe('/avatars/man-3.webp');
  });
});

describe("a bot's picture", () => {
  const botSlug = 'avatar-probe';
  const insertBot = (team: string, slug: string): Promise<void> =>
    w.system(async (tx) => {
      const teamId = (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [team])).rows[0]!.id;
      await tx.query(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, may_tag, model_aliases)
         VALUES ($1, $2, $3, $4, 'a probe', 'agent', 'hermes', 'team', $5, 'active', '{}', '{}')`,
        [omar.workspaceId, teamId, slug, slug, 'a'.repeat(64)],
      );
    });
  beforeAll(async () => {
    await insertBot('engineering', botSlug);
    await insertBot('marketing', 'probe-two');
    await insertBot('marketing', 'brain');
  });
  const set = (who: Persona, preset: string | null, team = 'engineering', slug = botSlug): Promise<ApiResult> =>
    w.call(who, 'PUT', `/api/teams/${team}/bots/${slug}/avatar`, { preset });
  const listed = async (who: Persona, team = 'engineering', slug = botSlug): Promise<string | null | undefined> =>
    ListBotsResponse.parse(ok(await w.call(who, 'GET', `/api/teams/${team}/bots`))).bots.find((b) => b.slug === slug)?.avatar;

  it("a workspace admin (or the team's lead) chooses one of the bot pictures; the roster shows it", async () => {
    expect(await listed(nadia)).toBeNull();
    expect(ok<{ avatar: string }>(await set(omar, 'bot-noto-panda')).avatar).toBe('preset:bot-noto-panda');
    expect(await listed(nadia)).toBe('preset:bot-noto-panda');
    // any bot may use a Brain picture: nothing is reserved
    expect(ok<{ avatar: string }>(await set(omar, 'bot-brain-orb')).avatar).toBe('preset:bot-brain-orb');
  });

  it('a member who is not a lead is refused, a person picture is not a bot picture, and null clears it', async () => {
    expect((await set(nadia, 'bot-noto-lion')).status).toBe(403);
    expect((await set(omar, 'man-20-casual')).status).toBe(400);
    expect((await set(omar, 'bot-nope')).status).toBe(400);
    // a picture of the first library is no longer offered
    expect((await set(omar, 'bot-panda')).status).toBe(400);
    expect(await listed(nadia)).toBe('preset:bot-brain-orb');
    expect(ok<{ avatar: null }>(await set(omar, null)).avatar).toBeNull();
    expect(await listed(nadia)).toBeNull();
  });

  it('a lead who is not a workspace admin changes an ordinary bot, but only a workspace admin changes Brain', async () => {
    expect(ok<{ avatar: string }>(await set(tariq, 'bot-noto-koala', 'marketing', 'probe-two')).avatar).toBe('preset:bot-noto-koala');
    expect((await set(tariq, 'bot-brain-glow', 'marketing', 'brain')).status).toBe(403);
    expect((await set(tariq, null, 'marketing', 'brain')).status).toBe(403);
    expect(await listed(tariq, 'marketing', 'brain')).toBeNull();
    expect(ok<{ avatar: string }>(await set(omar, 'bot-brain-glow', 'marketing', 'brain')).avatar).toBe('preset:bot-brain-glow');
    expect(await listed(tariq, 'marketing', 'brain')).toBe('preset:bot-brain-glow');
  });
});
