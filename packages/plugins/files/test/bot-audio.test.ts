import { FileMeta, ListChannelFilesResponse } from '@manythreads/shared';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type FilesWorld } from './world.ts';

// A bot reads a voice message by its transcript, never the recording (P14-17): the download route refuses a bot for an audio file and
// serves it other files; the attachment cards a bot is shown leave audio out.

const { nadia } = personas;

let w: FilesWorld;
let dev = '';
let bot = '';
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('opus clip bytes')]);

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  bot = await w.system(async (tx) => {
    const b = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, 'listener', 'listener', '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"mention"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [nadia.workspaceId, TEAM_IDS.Engineering],
    );
    const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [nadia.workspaceId, b.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, a.rows[0]!.id, nadia.workspaceId]);
    return a.rows[0]!.id;
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const asBot = (path: string): Promise<Response> =>
  fetch(`${w.server.url}${path}`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: bot, workspaceId: nadia.workspaceId }) } });

describe('bots and audio files', () => {
  it('a person downloads a recording; a bot that can read the channel gets 403 with a plain sentence, and still gets other files', async () => {
    const audio = FileMeta.parse((await w.upload(nadia, dev, WEBM, { name: 'clip.webm', type: 'audio/webm' })).body);
    const text = FileMeta.parse((await w.upload(nadia, dev, 'hello', { name: 'note.txt', type: 'text/plain' })).body);
    expect(audio.mime).toBe('audio/webm');

    const person = await w.download(nadia, audio.id);
    expect(person.status).toBe(200);
    expect(person.headers.get('content-type')).toBe('audio/webm');
    expect(person.bytes.equals(WEBM)).toBe(true);

    const refused = await asBot(`/api/files/${audio.id}/content`);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Bots read the transcript, not the audio.');

    // the bot is not shut out of the channel: it reads other files there
    const fine = await asBot(`/api/files/${text.id}/content`);
    expect(fine.status).toBe(200);
    expect(await fine.text()).toBe('hello');
    expect((await asBot(`/api/files/${audio.id}`)).status).toBe(200); // the name and type are not the bytes
    expect(ListChannelFilesResponse.parse(await (await asBot(`/api/channels/${dev}/files`)).json()).items.length).toBeGreaterThan(0);
  });
});
