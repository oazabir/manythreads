import { ChannelMessage, FileMeta, SearchResponse, voiceFallbackBody, type VoiceMeta } from '@manythreads/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';
import { eventually } from './world.ts';
import { heldDoor, installDoor, scriptedDoor } from './voice-hook.ts';

// The server writes the transcript of a voice message (P32-02 to P32-04, decision D13): the post is answered at once with the stand-in body and
// `pending`; a job asks the speech model (stood in for here) and writes the words, the failure or "none" with a compare-and-set, and announces the end
// with one `channel.message.transcribed` event. The posting rules are also in voice-rules.test.ts; the door itself is tested in gateway-llm.

const { nadia, rafi } = personas;

let w: FilesWorld;
let dev = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
}, 180_000);
afterEach(async () => {
  installDoor(undefined);
  await setSwitch(true);
});
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('opus clip bytes')]);
const STAND_IN = voiceFallbackBody(42_000);
let counter = 0;
const clip = async (): Promise<FileMeta> => FileMeta.parse(ok(await w.upload(nadia, dev, WEBM, { name: `v${++counter}.webm`, type: 'audio/webm;codecs=opus' }), 201));
const sendVoice = async (over: Record<string, unknown> = {}, voice: Partial<VoiceMeta> = {}): Promise<ChannelMessage> => {
  const f = await clip();
  const res = await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, {
    channelId: dev,
    body: STAND_IN,
    threadRootId: null,
    attachments: [f.id],
    voice: { fileId: f.id, durationMs: 42_000, language: null, transcript: 'none', peaks: [0, 10, 255], ...voice },
    ...over,
  });
  return ok<ChannelMessage>(res, 201);
};
const read = async (id: string): Promise<ChannelMessage> => {
  const list = ok<{ items: ChannelMessage[] }>(await w.call(nadia, 'GET', `/api/channels/${dev}/messages`));
  return list.items.find((m) => m.id === id)!;
};
const settled = (id: string) => eventually(async () => ((await read(id)).meta.voice?.transcript === 'pending' ? false : await read(id)), 30_000, `transcript of ${id}`);
const setSwitch = (on: boolean): Promise<void> =>
  w.system(async (tx) => {
    await tx.query("UPDATE app.workspaces SET settings = jsonb_set(settings, '{voiceTranscripts}', to_jsonb($1::boolean))", [on]);
  });
const transcribedEvents = (id: string) =>
  w.system(async (tx) => (await tx.query<{ payload: { state: string; transcriptEndMs: number | null } }>("SELECT payload FROM app.events WHERE type = 'channel.message.transcribed' AND payload ->> 'messageId' = $1 ORDER BY id", [id])).rows.map((r) => r.payload));
const versions = (id: string) => w.system(async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM app.message_versions WHERE message_id = $1', [id])).rows[0]!.n));
const row = (id: string) =>
  w.system(async (tx) => (await tx.query<{ body: string; edited_at: Date | null; deleted_at: Date | null }>('SELECT body, edited_at, deleted_at FROM app.messages WHERE id = $1', [id])).rows[0]!);

describe('a voice message the server transcribes', () => {
  it('is answered at once as pending with the stand-in body, then gets the words, no edited mark, no old version, one event', async () => {
    const held = heldDoor({ outcome: 'text', text: '  Please review the quokkaplan before Friday.  ', lang: 'en' });
    installDoor(held.door);
    const posted = await sendVoice();
    expect(posted.body).toBe(STAND_IN);
    expect(posted.meta.voice).toMatchObject({ transcript: 'pending', language: null });
    await eventually(async () => held.calls.length > 0 || undefined, 20_000, 'the job to reach the door');
    expect(held.calls[0]).toMatchObject({ messageId: posted.id, durationMs: 42_000, contentType: 'audio/webm' });
    expect((await read(posted.id)).meta.voice?.transcript).toBe('pending');
    held.release();
    const done = await settled(posted.id);
    expect(done.body).toBe('Please review the quokkaplan before Friday. …'); // the clip is 42 s: only the first 20 s were heard
    expect(done.meta.voice).toMatchObject({ transcript: 'server', transcriptEndMs: 20_000 });
    expect(done.meta.voice?.transcriptNote).toBeUndefined();
    expect(done.editedAt ?? null).toBeNull();
    expect((await row(posted.id)).edited_at).toBeNull();
    expect(await versions(posted.id)).toBe(0);
    expect(await transcribedEvents(posted.id)).toEqual([expect.objectContaining({ state: 'server', transcriptEndMs: 20_000 })]);
    // search finds the message by a word of its transcript
    const found = SearchResponse.parse(ok(await w.call(rafi, 'GET', `/api/search?q=${encodeURIComponent('quokkaplan')}`)));
    expect(found.messages.map((m) => m.id)).toContain(posted.id);
  });

  it('a clip shorter than 20 seconds gets its whole text, with no ellipsis, and the range is the clip', async () => {
    installDoor(scriptedDoor({ outcome: 'text', text: 'Short one.', lang: 'en' }).door);
    const posted = await sendVoice({ body: voiceFallbackBody(7_300) }, { durationMs: 7_300 });
    const done = await settled(posted.id);
    expect(done.body).toBe('Short one.');
    expect(done.meta.voice).toMatchObject({ transcript: 'server', transcriptEndMs: 7_300 });
  });

  it('a refused clip is failed at once, with the note and no "Try again"', async () => {
    const door = scriptedDoor({ outcome: 'refused', reason: 'The speech model must be inside this deployment.' });
    installDoor(door.door);
    const posted = await sendVoice();
    const done = await settled(posted.id);
    expect(door.calls).toHaveLength(1);
    expect(done.body).toBe(STAND_IN);
    expect(done.meta.voice).toMatchObject({ transcript: 'failed', transcriptNote: 'The speech model must be inside this deployment.' });
    expect(done.meta.voice?.transcriptRetry).toBeUndefined();
    expect(await transcribedEvents(posted.id)).toEqual([expect.objectContaining({ state: 'failed', transcriptEndMs: null })]);
  });

  it('a model that is unavailable is tried three times; the last time it is failed, with "Try again" on offer', async () => {
    const door = scriptedDoor({ outcome: 'unavailable', reason: 'The speech model did not answer.' });
    installDoor(door.door);
    const posted = await sendVoice();
    const done = await settled(posted.id);
    expect(door.calls).toHaveLength(3);
    expect(done.meta.voice).toMatchObject({ transcript: 'failed', transcriptRetry: true, transcriptNote: 'The speech model did not answer.' });
    expect(await transcribedEvents(posted.id)).toHaveLength(1);
  }, 60_000);

  it('hearing nothing is failed, and with no speech model at all the message says so', async () => {
    installDoor(scriptedDoor({ outcome: 'text', text: '   ', lang: null }).door);
    const silent = await settled((await sendVoice()).id);
    expect(silent.meta.voice).toMatchObject({ transcript: 'failed', transcriptNote: 'No words were heard in the first 20 seconds.' });
  });
});

describe('the late answer loses to what happened meanwhile', () => {
  it('a message deleted while the model works stays deleted: nothing is written, no event', async () => {
    const held = heldDoor();
    installDoor(held.door);
    const posted = await sendVoice();
    await eventually(async () => held.calls.length > 0 || undefined, 20_000, 'the job to reach the door');
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${posted.id}`), 200);
    held.release();
    await new Promise((r) => setTimeout(r, 1000));
    const after = await row(posted.id);
    expect(after.deleted_at).not.toBeNull();
    expect(after.body).not.toBe('held words');
    expect(await transcribedEvents(posted.id)).toEqual([]);
  });

  it('an edit by the author while the model works wins: their words stay, the state is edited, no event', async () => {
    const held = heldDoor();
    installDoor(held.door);
    const posted = await sendVoice();
    await eventually(async () => held.calls.length > 0 || undefined, 20_000, 'the job to reach the door');
    const edited = ok<ChannelMessage>(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${posted.id}`, { body: 'What I really said.' }));
    expect(edited.meta.voice?.transcript).toBe('edited');
    held.release();
    await new Promise((r) => setTimeout(r, 1000));
    const after = await read(posted.id);
    expect(after.body).toBe('What I really said.');
    expect(after.meta.voice?.transcript).toBe('edited');
    expect(await transcribedEvents(posted.id)).toEqual([]);
    expect(await versions(posted.id)).toBe(1); // a real edit keeps the old text
  });
});

describe('the workspace switch', () => {
  it('off at post time: no job, the message is "none" with the stand-in body; an old client\'s own words are still kept', async () => {
    await setSwitch(false);
    const door = scriptedDoor({ outcome: 'text', text: 'never used', lang: null });
    installDoor(door.door);
    const none = await sendVoice();
    expect(none.meta.voice?.transcript).toBe('none');
    expect(none.body).toBe(STAND_IN);
    const device = await sendVoice({ body: 'Words from the phone.' }, { transcript: 'device', language: 'en' });
    expect(device.meta.voice).toMatchObject({ transcript: 'device', language: 'en' });
    expect(device.body).toBe('Words from the phone.');
    await new Promise((r) => setTimeout(r, 800));
    expect(door.calls).toHaveLength(0);
    expect(await transcribedEvents(none.id)).toEqual([]);
  });

  it('on at post time with an old client\'s words: those words are kept and nothing is queued', async () => {
    const door = scriptedDoor({ outcome: 'text', text: 'never used', lang: null });
    installDoor(door.door);
    const device = await sendVoice({ body: 'Words from the phone.' }, { transcript: 'device', language: 'en' });
    expect(device.meta.voice?.transcript).toBe('device');
    await new Promise((r) => setTimeout(r, 800));
    expect(door.calls).toHaveLength(0);
  });

  it('turned off after the post but before the job starts: the job writes "none" and does not call the model', async () => {
    // two held jobs take both workers; the third waits in the queue while the switch is turned off
    const held = heldDoor();
    installDoor(held.door);
    await sendVoice();
    await sendVoice();
    await eventually(async () => held.calls.length >= 2 || undefined, 20_000, 'both workers to be busy');
    const waiting = await sendVoice();
    await setSwitch(false);
    held.release();
    const done = await settled(waiting.id);
    expect(done.meta.voice?.transcript).toBe('none');
    expect(held.calls.map((c) => c.messageId)).not.toContain(waiting.id);
    expect(await transcribedEvents(waiting.id)).toEqual([expect.objectContaining({ state: 'none' })]);
  });
});

describe('asking for the transcript again', () => {
  const failedMessage = async (retry: boolean): Promise<ChannelMessage> => {
    installDoor(scriptedDoor({ outcome: 'refused', reason: 'The speech model must be inside this deployment.' }).door);
    const posted = await sendVoice();
    await settled(posted.id);
    if (retry) {
      await w.system(async (tx) => {
        await tx.query("UPDATE app.messages SET meta = jsonb_set(meta, '{voice,transcriptRetry}', 'true') WHERE id = $1", [posted.id]);
      });
    }
    return read(posted.id);
  };
  const ask = (who: typeof nadia, id: string): Promise<ApiResult> => w.call(who, 'POST', `/api/messages/${id}/voice/transcribe`);

  it('goes back to pending and the new job writes the words (the readers get the message again)', async () => {
    const failed = await failedMessage(true);
    expect(failed.meta.voice).toMatchObject({ transcript: 'failed', transcriptRetry: true });
    installDoor(scriptedDoor({ outcome: 'text', text: 'Second time lucky.', lang: 'en' }).door);
    const again = ChannelMessage.parse(ok(await ask(nadia, failed.id)));
    expect(again.meta.voice?.transcript).toBe('pending');
    expect(again.meta.voice?.transcriptNote).toBeUndefined();
    expect(again.meta.voice?.transcriptRetry).toBeUndefined();
    const done = await settled(failed.id);
    expect(done.body).toBe('Second time lucky. …');
    expect(done.meta.voice?.transcript).toBe('server');
    expect((await transcribedEvents(failed.id)).map((e) => e.state)).toEqual(['failed', 'server']);
  });

  it('is for the author only (403), only from a failed message that may be retried (409), only while the switch is on and the model is set up (409)', async () => {
    const noRetry = await failedMessage(false);
    expect((await ask(nadia, noRetry.id)).status).toBe(409);
    const failed = await failedMessage(true);
    expect((await ask(rafi, failed.id)).status).toBe(403);
    await setSwitch(false);
    expect((await ask(nadia, failed.id)).status).toBe(409);
    await setSwitch(true);
    const door = scriptedDoor({ outcome: 'text', text: 'x', lang: null });
    door.status = { ready: false, reason: 'Speech to text is not set up on this server.' };
    installDoor(door.door);
    expect((await ask(nadia, failed.id)).status).toBe(409);
    expect(door.calls).toHaveLength(0);
    expect((await read(failed.id)).meta.voice?.transcript).toBe('failed');
    expect((await ask(nadia, '00000000-0000-7000-8000-000000000999')).status).toBe(404);
    const plain = ok<ChannelMessage>(await w.call(nadia, "POST", `/api/channels/${dev}/messages`, { channelId: dev, body: "text", threadRootId: null }), 201);
    expect((await ask(nadia, plain.id)).status).toBe(409);
  });

  it('is limited to three asks an hour for one message (429 with retry-after)', async () => {
    const failed = await failedMessage(true);
    const held = heldDoor();
    installDoor(held.door);
    const backToFailed = () =>
      w.system(async (tx) => {
        await tx.query(
          "UPDATE app.messages SET meta = jsonb_set(meta, '{voice}', (meta -> 'voice') || '{\"transcript\":\"failed\",\"transcriptRetry\":true}'::jsonb) WHERE id = $1",
          [failed.id],
        );
      });
    for (let i = 0; i < 3; i++) {
      ok(await ask(nadia, failed.id));
      await backToFailed();
    }
    const fourth = await ask(nadia, failed.id);
    expect(fourth.status).toBe(429);
    expect((fourth.body as { error: { code: string } }).error.code).toBe('rate_limited');
    held.release();
  });
});
