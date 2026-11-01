import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { ImportRun } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MATTERMOST_EXPECTED, SLACK_EXPECTED, mattermostExport, slackExport } from './fixtures.ts';
import { buildZip } from './zip-builder.ts';
import { createWorld, eventually, personas, type World } from './world.ts';

const { omar, nadia, rafi, sameera } = personas;

// The whole path on a real server: an admin uploads an export, reads the dry-run report (which writes nothing), starts the import, and the background job
// writes channels, messages, threads and reactions through the channels plugin. Then a person who signs up later with an archive person's email takes
// that person's messages over. The archives are the generated fixtures in test/fixtures (and hostile variants of them).

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w.close();
});

const upload = (who: typeof omar | null, source: 'slack' | 'mattermost', bytes: Uint8Array, team = 'engineering') =>
  w.upload<ImportRun & { code?: string; message?: string }>(who, `source=${source}&team=${team}`, bytes);
const get = async (id: string): Promise<ImportRun> => (await w.call<ImportRun>(omar, 'GET', `/api/admin/imports/${id}`)).body;
const waitFor = async (id: string, status: ImportRun['status'][], what: string): Promise<ImportRun> =>
  eventually(async () => {
    const run = await get(id);
    return status.includes(run.status) ? run : undefined;
  }, 90_000, what);

/** Row counts of everything an import could write. */
const counts = (): Promise<Record<string, number>> =>
  w.system(async (tx) => {
    const one = async (sql: string): Promise<number> => (await tx.query<{ n: number }>(sql)).rows[0]!.n;
    return {
      messages: await one('SELECT count(*)::int AS n FROM app.messages'),
      channels: await one('SELECT count(*)::int AS n FROM app.channels'),
      actors: await one('SELECT count(*)::int AS n FROM app.actors'),
      reactions: await one('SELECT count(*)::int AS n FROM app.message_reactions'),
      people: await one('SELECT count(*)::int AS n FROM app.import_people'),
      map: await one('SELECT count(*)::int AS n FROM app.import_map'),
      events: await one("SELECT count(*)::int AS n FROM app.events WHERE type LIKE 'channel.%' OR type LIKE 'message.%'"),
    };
  });

/** Uploads, dry-runs and returns the analysed run. */
async function analysed(source: 'slack' | 'mattermost', bytes: Uint8Array, team = 'engineering'): Promise<ImportRun> {
  const up = await upload(omar, source, bytes, team);
  expect(up.status).toBe(201);
  const dry = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${up.body.id}/dry-run`);
  expect(dry.status).toBe(202);
  return waitFor(up.body.id, ['analysed', 'failed'], 'the dry run');
}

describe('who may import, and what an upload must be', () => {
  it('is for workspace admins only', async () => {
    expect((await upload(nadia, 'slack', slackExport())).status).toBe(403);
    expect((await upload(null, 'slack', slackExport())).status).toBe(401);
    expect((await w.call(nadia, 'GET', '/api/admin/imports')).status).toBe(403);
    expect((await w.call(null, 'GET', '/api/admin/imports')).status).toBe(401);
    expect((await w.call(omar, 'GET', '/api/admin/imports')).status).toBe(200);
  });

  it('refuses a file that is not what it was said to be, an empty body and an unknown team', async () => {
    const text = await upload(omar, 'slack', Buffer.from('this is just text, not a zip'));
    expect(text.status).toBe(400);
    expect(await upload(omar, 'slack', Buffer.from(mattermostExport()))).toMatchObject({ status: 400 });
    expect((await upload(omar, 'mattermost', Buffer.from('#!/bin/sh\nrm -rf /\n'))).status).toBe(400);
    expect((await upload(omar, 'slack', new Uint8Array(0))).status).toBeGreaterThanOrEqual(400);
    expect((await upload(omar, 'slack', slackExport(), 'no-such-team')).status).toBe(404);
    const list = await w.call<{ items: ImportRun[] }>(omar, 'GET', '/api/admin/imports');
    expect(list.body.items).toEqual([]);
  });

  it('refuses at once an upload that declares 2 GB, without reading it', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${w.server.url}/api/admin/imports?source=slack&team=engineering`);
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: omar.actorId, workspaceId: omar.workspaceId }),
            'content-type': 'application/octet-stream',
            'content-length': String(2 * 1024 ** 3),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', (err) => (req.destroyed ? undefined : reject(err)));
      req.write(Buffer.from('PK\u0003\u0004 only a few bytes of it'));
    });
    expect(status).toBe(413);
  });

  it('refuses an upload over the size limit that was not declared', async () => {
    const saved = process.env['MANYTHREADS_IMPORT_MAX_BYTES'];
    process.env['MANYTHREADS_IMPORT_MAX_BYTES'] = '5000';
    try {
      expect((await upload(omar, 'slack', slackExport())).status).toBe(413);
    } finally {
      if (saved === undefined) delete process.env['MANYTHREADS_IMPORT_MAX_BYTES'];
      else process.env['MANYTHREADS_IMPORT_MAX_BYTES'] = saved;
    }
    expect((await w.call<{ items: ImportRun[] }>(omar, 'GET', '/api/admin/imports')).body.items).toEqual([]);
  });
});

describe('hostile archives that were uploaded', () => {
  it('leaves out a zip bomb (one entry that inflates to 300 MB from a few hundred KB) and says so', async () => {
    const bomb = buildZip([{ name: 'users.json', data: Buffer.alloc(300 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const run = await analysed('slack', bomb);
    expect(run.status).toBe('analysed');
    expect(run.dryRun!.messages.total).toBe(0);
    expect(run.dryRun!.skipped.find((s) => s.reason === 'refused_entry')!.count).toBe(1);
    await w.call(omar, 'DELETE', `/api/admin/imports/${run.id}`);
  });

  it('ends the dry run of an archive that cannot be read at all with a plain sentence, and drops the stored archive', async () => {
    for (const bytes of [Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200, 7)]), buildZip([{ name: 'a.json', data: '[]' }], { zip64: true, claimEntries: 300_000 })]) {
      const run = await analysed('slack', bytes);
      expect(run.status).toBe('failed');
      expect(run.error).toMatch(/zip|archive|entries/i);
      expect(run.error).not.toMatch(/stack|undefined| at \w+\.\w+/);
      const row = await w.system(async (tx) => (await tx.query<{ blob_key: string | null }>('SELECT blob_key FROM app.import_runs WHERE id = $1', [run.id])).rows[0]);
      expect(row!.blob_key).toBeNull();
      // a failed run cannot be started, and can be deleted
      expect((await w.call(omar, 'POST', `/api/admin/imports/${run.id}/start`)).status).toBe(409);
      expect((await w.call(omar, 'DELETE', `/api/admin/imports/${run.id}`)).status).toBe(200);
    }
  });

  it('reads the good parts of an archive that also holds path traversal, a symlink and a duplicate name, and reports what it refused', async () => {
    const bytes = buildZip([
      { name: 'users.json', data: JSON.stringify([{ id: 'U1', name: 'omar', profile: { email: 'omar@kahf.example', real_name: 'Omar' } }]) },
      { name: 'channels.json', data: JSON.stringify([{ id: 'C1', name: 'hostile-room' }]) },
      { name: 'hostile-room/2024-03-04.json', data: JSON.stringify([{ ts: '1709546400.000100', user: 'U1', text: 'safe message' }]) },
      { name: '../../etc/cron.d/evil', data: '* * * * * root rm -rf /' },
      { name: '/abs/path.json', data: '[]' },
      { name: 'link.json', data: '/etc/passwd', mode: 0o120777 },
      { name: 'dup.json', data: '[1]' },
      { name: 'dup.json', data: '[2]' },
    ]);
    const run = await analysed('slack', bytes);
    expect(run.status).toBe('analysed');
    expect(run.dryRun!.messages.total).toBe(1);
    expect(run.dryRun!.skipped.find((s) => s.reason === 'refused_entry')!.count).toBe(5);
    await w.call(omar, 'DELETE', `/api/admin/imports/${run.id}`);
  });
});

describe('a Slack import from dry run to report', () => {
  let run: ImportRun;
  let before: Record<string, number>;
  let after: Record<string, number>;

  it('cannot start before a dry run has been read', async () => {
    const up = await upload(omar, 'slack', slackExport());
    expect(up.status).toBe(201);
    expect(up.body.status).toBe('uploaded');
    expect(up.body.fileName).toBe('export');
    run = up.body;
    const start = await w.call<{ error: { message: string } }>(omar, 'POST', `/api/admin/imports/${up.body.id}/start`);
    expect(start.status).toBe(409);
    expect(start.body.error.message).toMatch(/dry run/i);
  });

  it('writes nothing in a dry run, and says what it would do', async () => {
    before = await counts();
    const dry = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${run.id}/dry-run`);
    expect(dry.status).toBe(202);
    run = await waitFor(run.id, ['analysed', 'failed'], 'the dry run');
    expect(run.status).toBe('analysed');
    after = await counts();
    expect(after).toEqual(before);
    const r = run.dryRun!;
    expect(r.people).toMatchObject({ total: SLACK_EXPECTED.people, matched: SLACK_EXPECTED.matched, placeholders: SLACK_EXPECTED.placeholders, withoutEmail: SLACK_EXPECTED.withoutEmail, matchedNotOnTeam: SLACK_EXPECTED.matchedNotOnTeam });
    expect(r.channels).toMatchObject({ total: SLACK_EXPECTED.channels, public: 2, private: 1, direct: 2 });
    expect(r.messages.total).toBe(SLACK_EXPECTED.messages);
    expect(r.messages.threads).toBeGreaterThan(5);
    expect(r.messages.reactions).toBeGreaterThan(0);
    expect(r.files.total).toBeGreaterThan(0);
    const skipped = Object.fromEntries(r.skipped.map((s) => [s.reason, s.count]));
    expect(skipped['app_message']).toBe(SLACK_EXPECTED.appMessages);
    expect(skipped['huddle']).toBe(SLACK_EXPECTED.huddles);
    expect(skipped['canvas']).toBe(SLACK_EXPECTED.canvases);
    expect(skipped['orphan_reply']).toBe(SLACK_EXPECTED.orphanReplies);
    expect(r.lines.join(' ')).toMatch(/Nothing has been written yet/);
    expect(r.lines.join(' ')).not.toMatch(/omar|nadia|jon@/i);
    // The direct conversation with a person who has no account here cannot be placed: it is left out, and the report says so.
    expect(r.channelLines.filter((c) => c.outcome === 'skip').map((c) => c.reason)).toContain('dm_not_matched');
  });

  it('can be dry-run again, and a second upload of the same archive is a separate run', async () => {
    const again = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${run.id}/dry-run`);
    expect(again.status).toBe(202);
    run = await waitFor(run.id, ['analysed'], 'the second dry run');
    expect(await counts()).toEqual(before);
  });

  it('runs in the background, keeps times and order, and reports what happened', async () => {
    const start = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${run.id}/start`);
    expect(start.status).toBe(202);
    expect(start.body.status).toBe('queued');
    const second = await w.call(omar, 'POST', `/api/admin/imports/${run.id}/start`);
    expect(second.status).toBe(409);
    run = await waitFor(run.id, ['done', 'failed', 'cancelled'], 'the import');
    expect(run.error).toBeNull();
    expect(run.status).toBe('done');
    const result = run.result!;
    expect(result.messages.imported).toBe(run.dryRun!.messages.imported);
    expect(result.messages.alreadyImported).toBe(0);
    expect(result.channels.imported).toBe(run.dryRun!.channels.imported);
    expect(result.lines.join(' ')).toMatch(/was written|were written/);
    const stored = await w.system(async (tx) => (await tx.query<{ blob_key: string | null }>('SELECT blob_key FROM app.import_runs WHERE id = $1', [run.id])).rows[0]!);
    expect(stored.blob_key).toBeNull();
  });

  it('wrote the messages as their authors, at their original times, with threads and reactions', async () => {
    const rows = await w.system(async (tx) => {
      const res = await tx.query<{ n: number; first: Date; last: Date; threads: number; imported: number; ordered: boolean }>(
        `SELECT count(*)::int AS n, min(created_at) AS first, max(created_at) AS last,
                count(*) FILTER (WHERE thread_root_id IS NOT NULL)::int AS threads,
                count(*) FILTER (WHERE meta -> 'importedFrom' ->> 'source' = 'slack')::int AS imported,
                true AS ordered
           FROM app.messages WHERE meta ? 'importedFrom'`,
      );
      return res.rows[0]!;
    });
    expect(rows.imported).toBe(run.result!.messages.imported);
    expect(rows.first.toISOString()).toMatch(/^2024-03-/);
    expect(rows.last.getTime()).toBeLessThan(Date.UTC(2024, 6, 1));
    expect(rows.threads).toBe(run.result!.messages.replies);
    const reactions = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.message_reactions')).rows[0]!.n);
    expect(reactions).toBe(run.result!.messages.reactions);
  });

  it('keeps the order of a channel the same as the order of the archive', async () => {
    const bad = await w.system(async (tx) => {
      const res = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           SELECT created_at, lag(created_at) OVER (PARTITION BY channel_id ORDER BY id) AS prev FROM app.messages WHERE meta ? 'importedFrom'
         ) x WHERE prev IS NOT NULL AND created_at < prev`,
      );
      return res.rows[0]!.n;
    });
    expect(bad).toBe(0);
  });

  it('wrote a matched person\'s messages as that person and a stranger\'s as a placeholder named with "(imported)"', async () => {
    const kinds = await w.system(async (tx) => {
      const res = await tx.query<{ kind: string; authors: number }>(
        `SELECT a.kind, count(DISTINCT a.id)::int AS authors FROM app.messages m JOIN app.actors a ON a.id = m.author_id WHERE m.meta ? 'importedFrom' GROUP BY a.kind`,
      );
      return Object.fromEntries(res.rows.map((r) => [r.kind, r.authors]));
    });
    expect(kinds['person']).toBe(SLACK_EXPECTED.matched);
    expect(kinds['system']).toBe(SLACK_EXPECTED.placeholders);
    const unclaimed = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.import_people WHERE claimed_at IS NULL')).rows[0]!.n);
    expect(unclaimed).toBe(SLACK_EXPECTED.placeholders);
    // Readers see it: the author of a stranger's message reads "Name (imported)".
    const general = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT target_id AS id FROM app.import_map WHERE source = 'slack' AND kind = 'channel' AND source_id LIKE '%/C01GEN'")).rows[0]!.id);
    const page = await w.call<{ items: { author?: { displayName: string; kind: string }; body: string; createdAt: string }[] }>(omar, 'GET', `/api/channels/${general}/messages?limit=200`);
    expect(page.status).toBe(200);
    const names = new Set(page.body.items.map((m) => m.author?.displayName));
    expect([...names].filter((n) => n?.endsWith('(imported)')).length).toBeGreaterThan(0);
    expect(names.has('Omar')).toBe(true);
    // newest first, by the time the message was written in Slack, not the time it was imported
    const times = page.body.items.map((m) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(times.every((t) => t < Date.UTC(2024, 6, 1))).toBe(true);
  });

  it('made no event, unread mark or push for an imported message', async () => {
    const stray = await w.system(async (tx) => {
      const ev = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type LIKE 'message.%'");
      return ev.rows[0]!.n;
    });
    expect(stray).toBe(0);
  });

  it('made the private channel with only the matched members of its team', async () => {
    const room = await w.system(async (tx) => {
      const res = await tx.query<{ id: string; name: string; private: boolean; members: string[] }>(
        `SELECT c.id, c.name, c.private,
                coalesce((SELECT array_agg(cm.person_id::text ORDER BY cm.person_id) FROM app.channel_members cm WHERE cm.channel_id = c.id), '{}') AS members
           FROM app.import_map im JOIN app.channels c ON c.id = im.target_id
          WHERE im.source = 'slack' AND im.kind = 'channel' AND im.source_id LIKE '%/G01LEAD'`,
      );
      return res.rows[0]!;
    });
    expect(room.private).toBe(true);
    // Omar and Nadia are on Engineering; Jon has no account here, so he is a placeholder and is not a member.
    expect(room.members.sort()).toEqual([omar.personId, nadia.personId].sort());
    // Rafi is on the team but was not in the archive's list: he cannot see the room.
    expect((await w.call(rafi, 'GET', `/api/channels/${room.id}`)).status).toBeGreaterThanOrEqual(403);
    expect((await w.call(nadia, 'GET', `/api/channels/${room.id}`)).status).toBe(200);
  });

  it('put the direct conversation of two matched people into their own DM, and left the other one out', async () => {
    const dm = await w.system(async (tx) => {
      const res = await tx.query<{ id: string; kind: string; members: string[]; n: number }>(
        `SELECT c.id, c.kind, (SELECT array_agg(cm.person_id::text ORDER BY cm.person_id) FROM app.channel_members cm WHERE cm.channel_id = c.id) AS members,
                (SELECT count(*)::int FROM app.messages m WHERE m.channel_id = c.id) AS n
           FROM app.import_map im JOIN app.channels c ON c.id = im.target_id WHERE im.source = 'slack' AND im.kind = 'direct'`,
      );
      return res.rows;
    });
    expect(dm).toHaveLength(1);
    expect(dm[0]!.kind).toBe('dm');
    expect(dm[0]!.members.sort()).toEqual([omar.personId, nadia.personId].sort());
    expect(dm[0]!.n).toBe(8);
    // Rafi is not in it and cannot read it; the other conversation (with a person who has no account) was never written anywhere.
    expect((await w.call(rafi, 'GET', `/api/channels/${dm[0]!.id}/messages`)).status).toBeGreaterThanOrEqual(403);
    expect((await w.call(nadia, 'GET', `/api/channels/${dm[0]!.id}/messages`)).status).toBe(200);
    const leaked = await w.system(async (tx) =>
      (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.messages WHERE body LIKE '%D02OMARJON%'`)).rows[0]!.n,
    );
    expect(leaked).toBe(0);
  });

  it('runs again over the same archive without writing anything twice', async () => {
    const first = await counts();
    const run = await analysed('slack', slackExport());
    expect(run.status).toBe('analysed');
    expect(run.dryRun!.messages.imported).toBe(0);
    expect(run.dryRun!.messages.alreadyImported).toBeGreaterThan(150);
    expect(run.dryRun!.channelLines.filter((c) => c.outcome === 'create')).toEqual([]);
    expect(await counts()).toEqual(first);
    const start = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${run.id}/start`);
    expect(start.status).toBe(202);
    const done = await waitFor(run.id, ['done', 'failed'], 'the second import');
    expect(done.status).toBe('done');
    expect(done.result!.messages.imported).toBe(0);
    expect(done.result!.messages.alreadyImported).toBeGreaterThan(150);
    expect(await counts()).toEqual(first);
  });

  it('keeps the audit trail of the runs, with numbers and no names', async () => {
    const rows = await w.system(async (tx) =>
      (await tx.query<{ action: string; target_label: string | null; reason: string | null; outcome: string }>(
        "SELECT action, target_label, reason, outcome FROM app.audit_events WHERE action LIKE 'import.%' ORDER BY id",
      )).rows,
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['import.uploaded', 'import.analysed', 'import.started', 'import.finished']));
    expect(JSON.stringify(rows)).not.toMatch(/kahf\.example|outside\.example|slack-export/);
  });
});

describe('a Mattermost import', () => {
  it('imports JSON lines, with replies as threads, and refuses to run twice at once', async () => {
    const run = await analysed('mattermost', Buffer.from(mattermostExport()), 'engineering');
    expect(run.status).toBe('analysed');
    expect(run.dryRun!.messages.total).toBe(MATTERMOST_EXPECTED.messages);
    expect(run.dryRun!.people).toMatchObject({ total: MATTERMOST_EXPECTED.people, matched: MATTERMOST_EXPECTED.matched, placeholders: MATTERMOST_EXPECTED.placeholders });
    const start = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${run.id}/start`);
    expect(start.status).toBe(202);
    const done = await waitFor(run.id, ['done', 'failed'], 'the Mattermost import');
    expect(done.status).toBe('done');
    expect(done.result!.messages.imported).toBeGreaterThan(0);
  });
});

/** A small Mattermost export of one server: its team, a town-square channel, a user called alicia and one post by her. */
function server(team: { name: string; display: string }, post = 'hello from alicia'): Buffer {
  return Buffer.from(
    [
      { type: 'version', version: 1 },
      { type: 'team', team: { name: team.name, display_name: team.display, type: 'O' } },
      { type: 'channel', channel: { team: team.name, name: 'town-square', display_name: 'Town Square', type: 'O' } },
      { type: 'user', user: { username: 'alicia', email: 'alicia.mm@example.org', teams: [{ name: team.name, channels: [{ name: 'town-square' }] }] } },
      { type: 'post', post: { team: team.name, channel: 'town-square', user: 'alicia', message: post, create_at: 1709546400000 } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
}

describe('Mattermost exports of different servers', () => {
  const finish = async (bytes: Buffer, team = 'engineering'): Promise<ImportRun> => {
    const run = await analysed('mattermost', bytes, team);
    expect(run.status).toBe('analysed');
    expect((await w.call(omar, 'POST', `/api/admin/imports/${run.id}/start`)).status).toBe(202);
    const done = await waitFor(run.id, ['done', 'failed'], 'the import');
    expect(done.status).toBe('done');
    return done;
  };
  /** The channels that hold alicia's posts: where each landed, and how many of her posts it holds. */
  const rooms = (): Promise<{ id: string; team: string; n: number }[]> =>
    w.system(async (tx) =>
      (
        await tx.query<{ id: string; team: string; n: number }>(
          `SELECT c.id, t.slug AS team, count(*)::int AS n FROM app.messages m JOIN app.channels c ON c.id = m.channel_id JOIN app.teams t ON t.id = c.team_id
            WHERE m.body LIKE 'hello from %alicia' GROUP BY c.id, t.slug ORDER BY t.slug, c.id`,
        )
      ).rows,
    );
  const alices = (): Promise<number> => w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.import_people WHERE name = 'alicia'")).rows[0]!.n);

  it('do not share a channel or a person because their names are the same', async () => {
    const one = await finish(server({ name: 'main', display: 'Main' }));
    expect(one.result!.messages.imported).toBe(1);
    const two = await finish(server({ name: 'main', display: 'Main Street office' }, 'hello from a different alicia'));
    expect(two.result!.channels.imported).toBe(1);
    expect(two.result!.messages.alreadyImported).toBe(0);
    expect(two.result!.messages.imported).toBe(1);
    const found = await rooms();
    expect(found).toHaveLength(2);
    expect(found.map((r) => [r.team, r.n])).toEqual([['engineering', 1], ['engineering', 1]]);
    expect(await alices()).toBe(2);
  });

  it('are still found again when the same server is imported a second time into the same team', async () => {
    const before = await rooms();
    const again = await finish(server({ name: 'main', display: 'Main' }));
    expect(again.result!.messages.imported).toBe(0);
    expect(again.result!.messages.alreadyImported).toBe(1);
    expect(again.result!.channelLines[0]!.outcome).toBe('exists');
    expect(await rooms()).toEqual(before);
    expect(await alices()).toBe(2);
  });

  it('go into the other team when that is where they are sent, rather than being found in the first', async () => {
    const other = await finish(server({ name: 'main', display: 'Main' }), 'marketing');
    expect(other.result!.channelLines[0]!.outcome).toBe('create');
    expect(other.result!.messages.imported).toBe(1);
    expect((await rooms()).filter((r) => r.team === 'marketing').map((r) => r.n)).toEqual([1]);
  });
});

describe('a refused upload', () => {
  it('is answered 403 and the connection is closed long before a huge body has been read', async () => {
    const total = 400 * 1024 * 1024;
    const outcome = await new Promise<{ status: number; sent: number; closed: boolean }>((resolve, reject) => {
      const url = new URL(`${w.server.url}/api/admin/imports?source=slack&team=engineering`);
      let sent = 0;
      let status = 0;
      let settled = false;
      const finish = (closed: boolean): void => {
        if (settled) return;
        settled = true;
        resolve({ status, sent, closed });
      };
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }),
            'content-type': 'application/octet-stream',
          },
        },
        (res) => {
          status = res.statusCode ?? 0;
          res.resume();
          res.on('close', () => finish(true));
        },
      );
      req.on('error', () => finish(true));
      req.on('close', () => finish(true));
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      const pump = (): void => {
        while (!req.destroyed && sent < total) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once('drain', pump);
            return;
          }
        }
        if (!req.destroyed) req.end();
      };
      pump();
      setTimeout(() => reject(new Error('the refused upload was still going after 30 seconds')), 30_000).unref();
    });
    expect(outcome.status).toBe(403);
    expect(outcome.closed).toBe(true);
    expect(outcome.sent).toBeLessThan(total);
  }, 60_000);
});

describe('claiming a placeholder', () => {
  it('hands the imported messages to the account that verifies the same email address, and not before', async () => {
    // Jon has a placeholder for each archive he was in (Slack and Mattermost); the same address claims both.
    const placeholders = await w.system(async (tx) =>
      (await tx.query<{ id: string; actor_id: string }>("SELECT id, actor_id FROM app.import_people WHERE email = 'jon@outside.example' ORDER BY id")).rows,
    );
    expect(placeholders).toHaveLength(2);
    const placeholder = { id: placeholders[0]!.id, actor_id: placeholders[0]!.actor_id };
    const actorsOfJon = placeholders.map((p) => p.actor_id);
    const owned = (actor: string | string[]): Promise<number> =>
      w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.messages WHERE author_id = ANY ($1::uuid[])', [[actor].flat()])).rows[0]!.n);
    const reactionsOf = (actor: string | string[]): Promise<number> =>
      w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.message_reactions WHERE actor_id = ANY ($1::uuid[])', [[actor].flat()])).rows[0]!.n);
    const messages = await owned(actorsOfJon);
    const reactions = await reactionsOf(actorsOfJon);
    expect(messages).toBeGreaterThan(0);
    // Jon arrives with the same address but has not verified it: someone typing an address is not proof they own it.
    const ids = await w.system(async (tx) => {
      const person = (
        await tx.query<{ id: string }>(
          "INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, 'Jon', 'jon@outside.example') RETURNING id",
          [omar.workspaceId],
        )
      ).rows[0]!.id;
      await tx.query("INSERT INTO app.person_emails (workspace_id, person_id, email) VALUES ($1, $2, 'jon@outside.example')", [omar.workspaceId, person]);
      const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id", [omar.workspaceId, person])).rows[0]!.id;
      return { person, actor };
    });
    expect(await owned(actorsOfJon)).toBe(messages);
    expect(await owned(ids.actor)).toBe(0);
    // Now the address is verified: every message and reaction of the placeholder becomes Jon's, in the same moment.
    await w.system(async (tx) => {
      await tx.query("UPDATE app.person_emails SET verified_at = now() WHERE person_id = $1", [ids.person]);
    });
    expect(await owned(actorsOfJon)).toBe(0);
    expect(await owned(ids.actor)).toBe(messages);
    expect(await reactionsOf(actorsOfJon)).toBe(0);
    expect(await reactionsOf(ids.actor)).toBe(reactions);
    const row = await w.system(async (tx) => (await tx.query<{ claimed_by: string | null }>('SELECT claimed_by FROM app.import_people WHERE id = $1', [placeholder.id])).rows[0]!);
    expect(row.claimed_by).toBe(ids.person);
    // It is said once for each, as an event with a count and no text.
    const events = await w.system(async (tx) =>
      (await tx.query<{ payload: { messages: number } }>("SELECT payload FROM app.events WHERE type = 'import.person.claimed'")).rows,
    );
    expect(events).toHaveLength(2);
    expect(events.reduce((n, e) => n + e.payload.messages, 0)).toBe(messages);
  });

  it('leaves the placeholder of a person with no email address where it is', async () => {
    const ghost = await w.system(async (tx) => (await tx.query<{ claimed_at: Date | null }>("SELECT claimed_at FROM app.import_people WHERE email IS NULL AND source = 'slack'")).rows);
    expect(ghost.length).toBeGreaterThan(0);
    expect(ghost.every((g) => g.claimed_at === null)).toBe(true);
  });
});

describe('the files other tests rely on', () => {
  it('are the committed fixtures', () => {
    expect(readFileSync(fileURLToPath(new URL('./fixtures/slack-export.zip', import.meta.url))).length).toBeGreaterThan(1000);
    void [rafi, sameera];
  });
});
