import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { actorOf } from '../files/support.ts';
import { apiOn, noSidewaysScroll } from '../support/stack-browser.ts';
import { addBot, brainMd, conversationStackEnv, openChat } from './support.ts';

/*
 * Talking to a bot of a team the person is not on (PLAN P21-18, POLISH 5.9): the server still answers 403, but the page no longer leaves a workspace
 * admin at a dead end. They see "Join as admin", which adds them to the team as a plain member through the ordinary roster route, and the same page
 * then opens the conversation. A person who is not an admin is told whom to ask. Runs on desktop and mobile-web; one stack for the file.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(conversationStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await addBot(stack, omar, 'brain', brainMd(['What is blocking the release?']));
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

/*
 * The membership edits below are SQL as the owner of THIS file's own stack (a private origin and a database made for the file and dropped with it), never a shared server or
 * the live site; the guard makes that a fact the file checks. Each test starts by taking the person off Engineering, so each puts the row back as it found it.
 */
type Who = 'omar' | 'priya';
const WHO: Who[] = ['omar', 'priya'];
const ENGINEERING = "(SELECT id FROM app.teams WHERE slug = 'engineering')";
let saved: Array<{ actor_id: string; role: string }> = [];

test.beforeAll(async () => {
  const host = new URL(stack.origin).hostname;
  expect(['127.0.0.1', 'localhost'], `the membership arrangement runs only against a local stack, not ${host}`).toContain(host);
  saved = await stack.sql<{ actor_id: string; role: string }>(`SELECT actor_id, role FROM app.team_members WHERE team_id = ${ENGINEERING} AND actor_id = ANY ($1::uuid[])`, [WHO.map(actorOf)]);
});

test.afterEach(async () => {
  for (const who of WHO) {
    const was = saved.find((r) => r.actor_id === actorOf(who));
    await leave(who);
    if (was) {
      await stack.sql(
        `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT t.id, $1, t.workspace_id, $2 FROM app.teams t WHERE t.slug = 'engineering' ON CONFLICT DO NOTHING`,
        [was.actor_id, was.role],
      );
    }
  }
});

const leave = async (who: Who): Promise<void> => {
  await stack.sql("DELETE FROM app.team_members WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf(who)]);
};
const roleOf = async (who: Who): Promise<string | undefined> =>
  (await stack.sql<{ role: string }>("SELECT role FROM app.team_members WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf(who)]))[0]?.role;

test('an admin not on the team joins and can talk', async ({ browser, playwright, isMobile }) => {
  await leave('omar');
  expect(await roleOf('omar')).toBeUndefined();
  const { page, close } = await openChat(browser, playwright, stack, 'omar', '/t/engineering/bots/brain/chat', isMobile);
  try {
    const refusal = page.getByTestId('conversation-unavailable');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('You cannot talk to this bot');
    // the old design note and the dead end are gone: the page says why and offers the way in
    await expect(refusal).toContainText('As a workspace admin you can join it');
    await expect(refusal).not.toContainText('the message is the button');
    await expect(refusal.getByRole('link', { name: 'Back to the bots' })).toBeVisible();
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);

    await refusal.getByRole('button', { name: 'Join as admin' }).click();

    // the page reloads the conversation: the bot's start page with its message box
    await expect(page.getByTestId('conversation-start')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Brain' })).toBeVisible();
    await expect(page.getByTestId('conversation-unavailable')).toHaveCount(0);
    // a plain member, not a lead
    expect(await roleOf('omar')).toBe('member');
  } finally {
    await close();
  }
});

test('a member is told to ask a lead', async ({ browser, playwright, isMobile }) => {
  await leave('priya');
  const { page, close } = await openChat(browser, playwright, stack, 'priya', '/t/engineering/bots/brain/chat', isMobile);
  try {
    const refusal = page.getByTestId('conversation-unavailable');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('You cannot talk to this bot');
    await expect(refusal).toContainText('Ask a lead of Engineering to add you.');
    await expect(page.getByRole('button', { name: 'Join as admin' })).toHaveCount(0);
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await close();
  }
  // and the server agrees: a member cannot put themselves on a team
  const api = await apiOn(playwright, stack, 'priya');
  try {
    const me = await api.get<{ person: { id: string } }>('/api/session');
    expect(await api.status('POST', '/api/teams/engineering/members', { personId: me.person.id, role: 'member' })).toBe(403);
  } finally {
    await api.ctx.dispose();
  }
  expect(await roleOf('priya')).toBeUndefined();
});
