import { SearchResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';

// P20-02: a Personal file never shows up in search: not for its owner, and not for an admin who has opened the space.
const { omar, nadia } = personas;

let w: FilesWorld;
beforeAll(async () => {
  w = await createWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const find = async (who: typeof nadia, q: string): Promise<SearchResponse> =>
  SearchResponse.parse(ok(await w.call(who, 'GET', `/api/search?q=${encodeURIComponent(q)}&scope=files`)));

describe('files search leaves Personal files out', () => {
  it('neither the owner nor an admin during an open finds a Personal file by its name', async () => {
    const name = 'zebrafinch-diary.md';
    ok(await w.uploadPersonal(nadia, 'Notes', 'dear diary', { name, type: 'text/markdown' }), 201);
    expect((await find(nadia, 'zebrafinch')).files).toEqual([]);
    // A live open, recorded the way app.open_personal_space does (the system role writes the table).
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.personal_space_access (workspace_id, person_id, admin_actor_id, reason, expires_at) VALUES ($1, $2, $3, 'checking search', now() + interval '1 hour')`,
        [omar.workspaceId, nadia.personId, omar.actorId],
      ),
    );
    expect((await find(omar, 'zebrafinch')).files).toEqual([]);
  });
});
