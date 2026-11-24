import { expect, request, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn, type StackApi } from '../support/stack-browser.ts';
import { FAKE_TEXT, WEBM_BYTES as WEBM, mic, openVoice, seedVoice, uploadFile as upload, voiceMeta as voice } from './voice-support.ts';

/**
 * Voice messages and who may do what (PLAN P14-17), on a stack of its own with the dev-actor header on (for the bot). Lena is a workspace guest:
 * she may play a voice message but has no microphone button, and the server refuses a voice message from a guest even where she may post. A bot
 * reads the transcript, never the recording (403 on the download). A recording uploaded with the type the browser reports stays audio.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let lena: StackApi;
let nadia: StackApi;
let releases = '';
let dev = '';
let botId = '';
let ws = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content', MANYTHREADS_STACK_DEV_AUTH: '1' });
  omar = await apiOn(playwright, stack, 'omar');
  lena = await apiOn(playwright, stack, 'lena');
  nadia = await apiOn(playwright, stack, 'nadia');
  const ids = await channelsOf(omar);
  releases = ids['releases']!;
  dev = ids['dev']!;
  // a voice message for Lena to find in #releases (she can only read there), posted by Nadia
  await seedVoice(nadia, releases, FAKE_TEXT);
  // a bot of Engineering, for the download check
  ws = (await stack.sql<{ id: string }>('SELECT id FROM app.workspaces LIMIT 1'))[0]!.id;
  const team = (await stack.sql<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'"))[0]!.id;
  const bot = await stack.sql<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
     VALUES ($1, $2, 'listener', 'listener', '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"mention"}]'::jsonb, ARRAY['smart']) RETURNING id`,
    [ws, team],
  );
  const actor = await stack.sql<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [ws, bot[0]!.id]);
  await stack.sql("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [team, actor[0]!.id, ws]);
  botId = actor[0]!.id;
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), lena?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

test('a guest plays a voice message but has no microphone button', async ({ browser, playwright }) => {
  // Lena may post in #releases for this test (guests may post only where they were given it), so the composer is there and the mic is what is missing
  const me = await lena.get<{ person: { id: string } }>('/api/session');
  await stack.sql(`UPDATE app.acl_entries SET permission = 'post' WHERE resource_type = 'channel' AND resource_id = $1 AND subject_id = $2`, [releases, me.person.id]);
  const { page, context } = await openVoice(browser, playwright, stack, 'lena', '/t/engineering/c/releases');
  try {
    const row = messagesIn(page).filter({ has: page.getByTestId('voice-player') }).last();
    await expect(row).toBeVisible();
    await expect(row.locator('.txt')).toContainText(FAKE_TEXT);
    await expect(page.getByRole('textbox', { name: /Message/ })).toBeVisible();
    // files are on here (the clip button shows), so the missing microphone is the guest rule, not a missing feature
    await expect(page.getByRole('button', { name: 'Attach a file' })).toBeVisible();
    await expect(mic(page)).toHaveCount(0);
    // she plays it
    await row.getByTestId('voice-play').click();
    await expect(row.getByTestId('voice-player')).toHaveAttribute('data-state', 'playing');
  } finally {
    await context.close();
  }
});

test('the server refuses a guest\'s voice message even where she may post', async () => {
  const f = await upload(lena, releases, WEBM, 'audio/webm', 'guest.webm');
  expect(f.status).toBe(201);
  const res = await lena.ctx.post(`/api/channels/${releases}/messages`, { data: { channelId: releases, body: FAKE_TEXT, threadRootId: null, attachments: [f.file!.id], voice: voice(f.file!.id) }, headers: await lena.headers() });
  expect(res.status()).toBe(403);
  expect(await res.text()).toContain('Guests can play voice messages but not record them.');
  // an ordinary message with the same file is still fine
  const plain = await lena.ctx.post(`/api/channels/${releases}/messages`, { data: { channelId: releases, body: 'plain', threadRootId: null, attachments: [f.file!.id] }, headers: await lena.headers() });
  expect(plain.status()).toBe(201);
});

test('an upload with the type a browser reports stays audio, and a bot is refused the recording but not other files', async () => {
  const clip = await upload(omar, dev, WEBM, 'audio/webm;codecs=opus', 'voice.webm');
  expect(clip.file?.mime).toBe('audio/webm');
  const ogg = await upload(omar, dev, Buffer.concat([Buffer.from('OggS'), Buffer.from('....opus')]), 'audio/ogg;codecs=opus', 'voice.ogg');
  expect(ogg.file?.mime).toBe('audio/ogg');
  const text = await upload(omar, dev, Buffer.from('hello'), 'text/plain', 'note.txt');

  // a context with no cookie: the dev header names the bot (a bot never has a session cookie)
  const bare = await request.newContext({ baseURL: stack.origin });
  const refused = await bare.get(`/api/files/${clip.file!.id}/content`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: botId, workspaceId: ws }) } });
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain('Bots read the transcript, not the audio.');
  const fine = await bare.get(`/api/files/${text.file!.id}/content`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: botId, workspaceId: ws }) } });
  expect(fine.status()).toBe(200);
  await bare.dispose();
});
