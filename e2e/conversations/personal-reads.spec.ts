import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { channelsOf, postAs } from '../support/stack-browser.ts';
import { uploadAs } from '../files/personal-support.ts';
import { addBot, apiOn, channelOf, conversationStackEnv } from './support.ts';

/*
 * What a bot may read of a person's Personal space (PLAN P20-05..P20-09, D10), through the real gateway and a stand-in Hermes (fake-hermes-personal.mjs).
 * The rule: Personal is open only in the person's OWN conversation with the bot, only when the bot asks for `personal.read` AND the person said yes. In
 * a team channel (a mention in #dev) it is closed whatever the person said, and what a bot read there never shows in the answer.
 *
 * Gap, on purpose: a Personal MEMORY concept in a Brain answer needs the memory service (Hindsight), which no e2e stack runs. The same rule for memory
 * recall is covered by packages/plugins/answer/test/rls and memory/test/rls; here the same gateway decision is driven through Personal files and
 * Personal knowledge, which use the same `spacesFor` answer. A live check with Hindsight is in docs/testing.md.
 */
test.skip(({ isMobile }) => isMobile, 'a server-side rule; no layout is under test');
test.describe.configure({ mode: 'serial' });

const FAKE = fileURLToPath(new URL('./fake-hermes-personal.mjs', import.meta.url));
const SECRET = 'ZEBRA-4471';
const FILE_TEXT = `# Espresso\n\nThe grinder setting is ${SECRET} and nobody else should know it.\n`;
const DOC_TEXT = `# Roaster notes\n\nThe espresso beans are roasted on Elm Street. Batch code ${SECRET}.\n`;

const KEEPER_MD = [
  '---',
  'schema: 1',
  'name: Keeper',
  'role: Reads what you let it read',
  'kind: agent',
  'runtime: hermes',
  'triggers:',
  '  - { type: conversation }',
  '  - { type: mention }',
  'capabilities:',
  '  native: [messages.post, files.read, knowledge.search, personal.read]',
  '---',
  '',
  '# Keeper',
  '',
].join('\n');

let stack: Stack;
let keeperId = '';
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...conversationStackEnv(), MANYTHREADS_HERMES_PREFIX: FAKE });
  const omar = await apiOn(playwright, stack, 'omar');
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    keeperId = (await addBot(stack, omar, 'keeper', KEEPER_MD)).botId;
    await uploadAs(nadia, 'Notes', 'espresso.md', FILE_TEXT);
    await nadia.post('/api/me/knowledge', { slug: 'roaster', name: 'Roaster' });
    const up = await nadia.ctx.post('/api/me/knowledge/roaster/documents?name=roaster.md', {
      headers: { ...(await nadia.headers()), 'content-type': 'text/markdown', 'x-file-name': 'roaster.md' },
      data: Buffer.from(DOC_TEXT),
    });
    expect(up.status(), await up.text()).toBeLessThan(300);
  } finally {
    await omar.ctx.dispose();
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

let n = 0;
const nextTag = (): string => `TAG-t${String(++n)}`;

/** The reply of the bot in a channel that answers the ask carrying the tag. */
async function replyIn(channelId: string, marker: 'RESULT-FILE' | 'RESULT-SEARCH', tag: string): Promise<string> {
  let body = '';
  await expect
    .poll(
      async () => {
        const rows = await stack.sql<{ body: string }>(`SELECT body FROM app.messages WHERE channel_id = $1 AND body LIKE $2 ORDER BY created_at DESC LIMIT 1`, [channelId, `${marker} ${tag} %`]);
        body = rows[0]?.body ?? '';
        return body !== '';
      },
      { timeout: 60_000, message: `the bot's ${marker} reply for ${tag}` },
    )
    .toBe(true);
  return body;
}

/** Nadia asks the bot in her own conversation. */
async function ask(playwright: Parameters<typeof apiOn>[0], text: string, marker: 'RESULT-FILE' | 'RESULT-SEARCH'): Promise<string> {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const tag = nextTag();
  try {
    const sent = await nadia.ctx.post('/api/teams/engineering/bots/keeper/conversations/send', { data: { body: `${text} ${tag}`, threadRootId: null, attachments: [] }, headers: await nadia.headers() });
    expect(sent.status(), await sent.text()).toBeLessThan(300);
    return await replyIn(await channelOf(stack, keeperId, 'nadia'), marker, tag);
  } finally {
    await nadia.ctx.dispose();
  }
}

/** Nadia mentions the bot in #dev, a team channel. */
async function mention(playwright: Parameters<typeof apiOn>[0], text: string, marker: 'RESULT-FILE' | 'RESULT-SEARCH'): Promise<string> {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const tag = nextTag();
  try {
    const dev = (await channelsOf(nadia))['dev']!;
    await postAs(nadia, dev, `@keeper ${text} ${tag}`);
    return await replyIn(dev, marker, tag);
  } finally {
    await nadia.ctx.dispose();
  }
}

const setConsent = async (playwright: Parameters<typeof apiOn>[0], who: 'nadia' | 'rafi', allowed: boolean): Promise<void> => {
  const api = await apiOn(playwright, stack, who);
  try {
    const res = await api.ctx.put(`/api/me/bot-consents/${keeperId}`, { data: { allowed }, headers: await api.headers() });
    expect(res.status(), await res.text()).toBe(200);
  } finally {
    await api.ctx.dispose();
  }
};

test('without her yes the bot reads nothing of Nadia’s Personal files or knowledge, even in her own conversation', async ({ playwright }) => {
  const file = await ask(playwright, 'PERSONAL-FILE Notes/espresso.md', 'RESULT-FILE');
  expect(file).not.toContain(SECRET);
  expect(file).toMatch(/"ok":\s*false|closed|not open|declined|allow/i);
  const found = await ask(playwright, 'PERSONAL-SEARCH espresso beans roasted', 'RESULT-SEARCH');
  expect(found).not.toContain(SECRET);
  expect(found).not.toContain('person:');
});

test('with her yes the bot reads both in her own conversation, and a hit says it is from her Personal space', async ({ playwright }) => {
  await setConsent(playwright, 'nadia', true);
  const file = await ask(playwright, 'PERSONAL-FILE Notes/espresso.md', 'RESULT-FILE');
  expect(file).toContain(SECRET);
  const found = await ask(playwright, 'PERSONAL-SEARCH espresso beans roasted', 'RESULT-SEARCH');
  expect(found).toContain(SECRET);
  expect(found).toMatch(/person/);
});

test('in a team channel the same bot, asked by the same person who said yes, reads none of it', async ({ playwright }) => {
  const file = await mention(playwright, 'PERSONAL-FILE Notes/espresso.md', 'RESULT-FILE');
  expect(file).not.toContain(SECRET);
  expect(file).toMatch(/team channel|private conversation|not open|"ok":\s*false/i);
  const found = await mention(playwright, 'PERSONAL-SEARCH espresso beans roasted', 'RESULT-SEARCH');
  expect(found).not.toContain(SECRET);
  expect(found).not.toContain('person:');
  // and nothing of it was left in the team channel by the platform
  const dev = (await stack.sql<{ n: string }>(`SELECT count(*) AS n FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE c.kind <> 'bot_conversation' AND m.body LIKE $1`, [`%${SECRET}%`]))[0]!.n;
  expect(Number(dev)).toBe(0);
});

test('turning the bot off closes Personal again on its next call', async ({ playwright }) => {
  await setConsent(playwright, 'nadia', false);
  const file = await ask(playwright, 'PERSONAL-FILE Notes/espresso.md', 'RESULT-FILE');
  expect(file).not.toContain(SECRET);
});

test('Rafi’s yes opens Rafi’s Personal space and nobody else’s: the bot cannot read Nadia’s files for him', async ({ playwright }) => {
  await setConsent(playwright, 'rafi', true);
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    const sent = await rafi.ctx.post('/api/teams/engineering/bots/keeper/conversations/send', { data: { body: 'PERSONAL-FILE Notes/espresso.md TAG-rafi', threadRootId: null, attachments: [] }, headers: await rafi.headers() });
    expect(sent.status(), await sent.text()).toBeLessThan(300);
    const channelId = await channelOf(stack, keeperId, 'rafi');
    const reply = await replyIn(channelId, 'RESULT-FILE', 'TAG-rafi');
    expect(reply).not.toContain(SECRET);
    expect(reply).not.toContain('Espresso');
  } finally {
    await rafi.ctx.dispose();
  }
});
