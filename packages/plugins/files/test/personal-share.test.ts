import { randomUUID } from 'node:crypto';
import { CopyPersonalFileToTeamResponse, PersonalFile, PersonalShareCheckResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ApiResult, type FilesWorld } from './world.ts';

// P20-14: sending a Personal file to a team. The workspace's data rules look first; a copy is a commit to the team repo by the caller.

const { nadia, sameera, lena } = personas;
const KEY = `sk-${'ab3dEf6hIj'.repeat(3)}`;

let w: FilesWorld;
beforeAll(async () => {
  w = await createWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const put = async (body: string | Uint8Array, name: string, type = 'text/markdown'): Promise<PersonalFile> => {
  const res = await w.uploadPersonal(nadia, 'Notes', body, { name, type, conflict: 'rename' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return PersonalFile.parse(res.body);
};
const check = (who: typeof nadia | null, id: string, body: unknown): Promise<ApiResult> => w.call(who, 'POST', `/api/me/files/${id}/share-check`, body);
const copy = (who: typeof nadia | null, id: string, body: unknown): Promise<ApiResult> => w.call(who, 'POST', `/api/me/files/${id}/copy-to-team`, body);
const setPreset = (preset: string): Promise<unknown> =>
  w.system((tx) =>
    tx.query(
      `INSERT INTO app.llm_settings (workspace_id, preset) VALUES ($1, $2) ON CONFLICT (workspace_id) DO UPDATE SET preset = EXCLUDED.preset`,
      [nadia.workspaceId, preset],
    ),
  );
const repoText = async (path: string): Promise<string> => {
  const res = await w.raw(nadia, 'GET', `/api/teams/engineering/repo/content?path=${encodeURIComponent(path)}`);
  expect(res.status).toBe(200);
  return res.bytes.toString();
};
const team = { teamSlug: 'engineering' };

describe('share-check and copy-to-team', () => {
  it('a clean text file: allow, copied as written, the original stays', async () => {
    const f = await put('# Plan\nNothing secret here.\n', 'plan.md');
    const c = PersonalShareCheckResponse.parse((await check(nadia, f.id, { destination: 'team_files', ...team })).body);
    expect(c).toEqual({ outcome: 'allow', rules: [] });
    const res = await copy(nadia, f.id, { ...team, path: 'pages/from-personal/plan.md' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = CopyPersonalFileToTeamResponse.parse(res.body);
    expect(body).toMatchObject({ path: 'pages/from-personal/plan.md', redacted: false });
    expect(body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await repoText('pages/from-personal/plan.md')).toBe('# Plan\nNothing secret here.\n');
    const mine = await w.raw(nadia, 'GET', '/api/me/files/tree?path=Notes');
    expect(mine.bytes.toString()).toContain('plan.md');
  });

  it('a file with a key: the standard preset redacts; the check says so by rule name and the copy commits redacted text', async () => {
    await setPreset('standard');
    const f = await put(`token ${KEY} end\n`, 'keys.md');
    const c = PersonalShareCheckResponse.parse((await check(nadia, f.id, { destination: 'team_files', ...team })).body);
    expect(c.outcome).toBe('redact');
    expect(c.rules).toContain('api-key');
    expect(JSON.stringify(c)).not.toContain(KEY);
    const res = await copy(nadia, f.id, { ...team, path: 'pages/from-personal/keys.md' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(CopyPersonalFileToTeamResponse.parse(res.body).redacted).toBe(true);
    const stored = await repoText('pages/from-personal/keys.md');
    expect(stored).not.toContain(KEY);
    expect(stored).toContain('token');
  });

  it('a preset that refuses: block answers 409 and nothing reaches the repo', async () => {
    await setPreset('customer-facing');
    try {
      const f = await put(`token ${KEY} end\n`, 'blocked.md');
      const c = PersonalShareCheckResponse.parse((await check(nadia, f.id, { destination: 'team_files', ...team })).body);
      expect(c.outcome).toBe('block');
      const res = await copy(nadia, f.id, { ...team, path: 'pages/from-personal/blocked.md' });
      expect(res.status).toBe(409);
      expect((await w.raw(nadia, 'GET', `/api/teams/engineering/repo/content?path=${encodeURIComponent('pages/from-personal/blocked.md')}`)).status).toBe(404);
    } finally {
      await setPreset('standard');
    }
  });

  it('the inbox destination is checked by the same rules', async () => {
    const f = await put(`token ${KEY} end\n`, 'inbox.md');
    const c = PersonalShareCheckResponse.parse((await check(nadia, f.id, { destination: 'team_inbox', ...team })).body);
    expect(c.outcome).toBe('redact');
    const clean = await put('hello\n', 'inbox-clean.md');
    expect(PersonalShareCheckResponse.parse((await check(nadia, clean.id, { destination: 'team_inbox', ...team })).body).outcome).toBe('allow');
  });

  it('refuses what the repo cannot hold, and a path that is taken', async () => {
    const bin = await put(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), 'pic.png', 'image/png');
    const r = await copy(nadia, bin.id, { ...team, path: 'pages/from-personal/pic.md' });
    expect(r.status).toBe(422);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('attachment_not_in_repo');
    expect((await check(nadia, bin.id, { destination: 'team_files', ...team })).status).toBe(422);
    const big = await put('a'.repeat(1024 * 1024 + 1), 'big.md');
    expect((await copy(nadia, big.id, { ...team, path: 'pages/from-personal/big.md' })).status).toBe(422);

    const f = await put('x\n', 'taken.md');
    expect((await copy(nadia, f.id, { ...team, path: 'pages/from-personal/taken.md' })).status).toBe(200);
    expect((await copy(nadia, f.id, { ...team, path: 'pages/from-personal/taken.md' })).status).toBe(409);
  });

  it('only the owner, only a member, and only where the caller can write', async () => {
    const f = await put('mine\n', 'own.md');
    // Somebody else's file is not theirs to send (and not visible to them).
    expect((await copy(sameera, f.id, { ...team, path: 'pages/from-personal/own.md' })).status).toBe(403);
    expect((await check(sameera, f.id, { destination: 'team_files', ...team })).status).toBe(403);
    // A guest has no Personal space; nobody signed in is 401.
    expect((await check(lena, f.id, { destination: 'team_files', ...team })).status).toBe(403);
    expect((await copy(lena, f.id, { ...team, path: 'pages/x.md' })).status).toBe(403);
    expect((await copy(null, f.id, { ...team, path: 'pages/x.md' })).status).toBe(401);
    // A bot is not a person with a Personal space.
    const bot = await fetch(`${w.server.url}/api/me/files/${f.id}/share-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: randomUUID(), workspaceId: nadia.workspaceId }) },
      body: JSON.stringify({ destination: 'team_files', ...team }),
    });
    expect([401, 403]).toContain(bot.status);
    // A path the repo writer guards is refused.
    expect([403, 422]).toContain((await copy(nadia, f.id, { ...team, path: 'TEAM.md' })).status);
    // Bad bodies.
    expect((await check(nadia, f.id, { destination: 'elsewhere', ...team })).status).toBe(400);
    expect((await copy(nadia, f.id, { ...team, path: '../etc/passwd' })).status).toBe(400);
  });
});
