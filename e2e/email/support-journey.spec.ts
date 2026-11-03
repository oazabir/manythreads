import { expect, test, type PlaywrightWorkerArgs } from '@playwright/test';
import { startHermesStandIn, STAND_IN_KEY, type StandIn } from '../fixtures/hermes-stand-in.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { applyGuarded, apiOn, channelsOf, type StackApi } from '../support/stack-browser.ts';

/*
 * The support journey (PLAN P8-36), end to end on a stack of its own, told in order:
 *
 *   1. Omar (a workspace admin) sets up a Customer support team from the template: the channel #support-inbox, the two mail bots (Support email and Customer
 *      support) and the team's repo come with it. He points both bots at a Hermes gateway runner (the scripted Hermes of fixtures/hermes-stand-in.ts) and gives each
 *      the token its profile calls the platform with.
 *   2. He uploads the manuals into the knowledge base `manuals`: a PDF, a Markdown FAQ and a CSV price list. They are converted, written into the team repo
 *      and searchable.
 *   3. He adds the dummy mail connection `support-mail`, puts its credential in and switches it on. The bots' mail grants are compiled from their definitions.
 *   4. (When the Deploy action exists, P8-34: he deploys the Support email bot and the three outcomes are reported.)
 *   5. A customer's email arrives through the admin delivery door of the dummy mailbox. The Support email bot posts it in #support-inbox and tags the Customer
 *      support bot; that bot searches the manuals for real, answers in the thread and tags the Support email bot; the Support email bot's `email.send` waits for a
 *      person. NOTHING is in the mailbox's outbound side until Sameera or Omar approves the card; after the approval exactly one mail goes out, addressed to the
 *      customer by the platform, carrying the manuals' words.
 *   6. The escalation branch: a second customer asks something the manuals do not cover. The Customer support bot hands it to a person and does not tag the
 *      Support email bot: no card, no send, and nothing for that customer in the outbound side of the mailbox.
 *
 * What is real: the server, the database, the repo writer, the loader, the knowledge plugin (conversion, chunks, the lexical search), the connections plugin (the
 * dummy transport, the inbox watch, the mail-to-thread link), the broker, the MCP gateway and the approvals plugin. What is scripted: the two bots' "models"
 * (fixtures/hermes-stand-in.ts), which call the run's own MCP door the way a Hermes profile does.
 */

test.describe.configure({ mode: 'serial', retries: 0 });
test.setTimeout(420_000);

const TEAM = 'help-desk';
const RUNNER = 'stand-in';
const CUSTOMER = 'ayesha@customer.example';
const OTHER_CUSTOMER = 'bilal@customer.example';
const SUPPORT_ADDRESS = 'support@help-desk.example';

const FAQ = `# Orders and delivery

## Changing your delivery address

You can change the delivery address of an order until it has shipped. Open the order in your account, choose Change delivery address and save the new address. Once the order has shipped, contact the carrier with your tracking number.

## Delivery times

Standard delivery takes three to five working days.
`;
const PRICES = 'plan,price,seats\nStarter,9 dollars,3\nBusiness,49 dollars,25\n';
const RETURNS_PDF_TEXT = 'Returns policy. Items may be returned within 30 days of delivery in their original packaging.';

/** A one-page PDF whose text a reader can extract: the smallest file the converter has to read for real. */
function pdfOf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(ms / 1000)} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

let stack: Stack;
let standIn: StandIn;
let playwrightRef: PlaywrightWorkerArgs['playwright'];
let omar: StackApi;
let sameera: StackApi;
let inboxChannel = '';

interface MessageItem {
  id: string;
  authorId: string;
  body: string;
  threadRootId: string | null;
}

const actorOf = async (slug: string): Promise<string> =>
  (
    await stack.sql<{ id: string }>(
      `SELECT a.id FROM app.actors a JOIN app.bots b ON a.kind = 'bot' AND a.ref_id = b.id JOIN app.teams t ON t.id = b.team_id WHERE t.slug = $1 AND b.slug = $2`,
      [TEAM, slug],
    )
  )[0]!.id;

/** The messages of #support-inbox: the top level, or one thread. */
async function messages(threadRootId?: string): Promise<MessageItem[]> {
  const query = threadRootId ? `&threadRootId=${threadRootId}` : '';
  return (await omar.get<{ items: MessageItem[] }>(`/api/channels/${inboxChannel}/messages?limit=100${query}`)).items;
}

const runsOf = (slug: string) =>
  stack.sql<{ id: string; status: string; trigger_type: string }>(
    `SELECT r.id, r.status, r.trigger_type FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id JOIN app.teams t ON t.id = b.team_id WHERE t.slug = $1 AND b.slug = $2 ORDER BY r.started_at, r.id`,
    [TEAM, slug],
  );

const outbound = () =>
  stack.sql<{ direction: string; to_address: string; subject: string; body: string; thread_key: string; in_reply_to: string | null }>(
    `SELECT m.direction, m.to_address, m.subject, m.body, m.thread_key, m.in_reply_to
       FROM app.connection_messages m JOIN app.connections c ON c.id = m.connection_id JOIN app.teams t ON t.id = c.team_id
      WHERE t.slug = $1 AND c.slug = 'support-mail' AND m.direction = 'out' ORDER BY m.seq`,
    [TEAM],
  );

const pendingApprovals = async (api: StackApi) =>
  (await api.get<{ items: Array<{ id: string; tool: string; status: string; summary: string }> }>(`/api/teams/${TEAM}/approvals?status=pending`)).items;

/** Deliver a customer's email through the admin-only door of the dummy mailbox. */
async function mailIn(from: string, subject: string, body: string, messageRef: string): Promise<void> {
  const res = await omar.ctx.post(`/api/teams/${TEAM}/connections/support-mail/mail`, {
    data: { from, to: SUPPORT_ADDRESS, subject, body, messageRef },
    headers: await omar.headers(),
  });
  expect(res.status(), await res.text()).toBe(201);
}

/** The bot's post at the top of #support-inbox that carries the email of `from`, once the Support email bot has made it. */
async function inboxPost(from: string): Promise<MessageItem> {
  const supportEmail = await actorOf('support-email');
  return until(async () => (await messages()).find((m) => m.authorId === supportEmail && m.body.includes(`**From:** ${from}`)), 90_000, `the Support email bot to post the mail of ${from}`);
}

test.beforeAll(async ({ playwright }) => {
  playwrightRef = playwright;
  standIn = await startHermesStandIn();
  // The stand-in listens on loopback, which the outbound guard refuses unless the operator lists it (the way a real operator lists a gateway of their own).
  stack = await startStack({ MANYTHREADS_STACK_API_ONLY: '1', MANYTHREADS_HERMES_ALLOWED_HOSTS: '127.0.0.1' });
  omar = await apiOn(playwright, stack, 'omar');
  sameera = await apiOn(playwright, stack, 'sameera');
});

test.afterAll(async () => {
  await omar?.ctx.dispose();
  await sameera?.ctx.dispose();
  await stack?.stop();
  await standIn?.close();
});

test('1 · Omar sets up the Customer support team from the template and points its bots at a Hermes gateway', async () => {
  const made = await omar.post<{ team: { slug: string } }>('/api/teams/from-template', { templateId: 'customer-support', slug: TEAM });
  expect(made.team.slug).toBe(TEAM);

  // the template's files reach the team repo and the loader makes the roster
  await until(async () => {
    const bots = (await omar.get<{ bots: Array<{ slug: string; status: string }> }>(`/api/teams/${TEAM}/bots`)).bots;
    return ['support-email', 'customer-support'].every((slug) => bots.find((b) => b.slug === slug)?.status === 'active');
  }, 90_000, 'the loader to make the two mail bots');
  const channels = await channelsOf(omar, TEAM);
  expect(channels['support-inbox'], 'the template makes #support-inbox').toBeTruthy();
  inboxChannel = channels['support-inbox']!;

  // Sameera (role:support-agent) is on the team: she reads #support-inbox and sees the cards the mail bots raise
  const team = (await stack.sql<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM app.teams WHERE slug = $1', [TEAM]))[0]!;
  await stack.sql(
    `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role)
     SELECT $1::uuid, a.id, $2::uuid, 'member' FROM app.actors a JOIN app.people p ON a.kind = 'person' AND a.ref_id = p.id WHERE p.primary_email = 'sameera@kahf.example' ON CONFLICT DO NOTHING`,
    [team.id, team.workspace_id],
  );

  // the runner: an admin adds a Hermes gateway (the scripted one) and opens it to every team
  const runner = await omar.post<{ runner: { name: string } }>('/api/admin/bot-runners', {
    name: RUNNER,
    label: 'Scripted Hermes',
    kind: 'hermes_gateway',
    baseUrl: standIn.url,
    apiKey: STAND_IN_KEY,
    teams: { all: true },
  });
  expect(runner.runner.name).toBe(RUNNER);

  for (const slug of ['support-email', 'customer-support']) {
    // the definition the template ships places the bot on the team's own pod; this stack has none, so the bot is placed on the runner above
    const blob = await omar.get<{ content: string; blobSha: string }>(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(`bots/${slug}/BOT.md`)}`);
    const placed = blob.content.replace(/placement:\n {2}gateway:\n {4}connection: managed\n/, `placement:\n  runs_on: ${RUNNER}\n`);
    expect(placed, `${slug} was placed on the pod by the template`).not.toBe(blob.content);
    const applied = await applyGuarded(omar, `bots/${slug}/BOT.md`, placed, `Place ${slug} on the scripted Hermes`, { team: TEAM, baseBlobSha: blob.blobSha });
    expect(applied.status, applied.text).toBe(201);

    // the profile's own credential for the platform's MCP door: the bot's pairing token
    const token = await omar.post<{ token: string }>(`/api/teams/${TEAM}/bots/${slug}/pairing-tokens`, {});
    standIn.register(slug, { url: `${stack.origin}/mcp`, token: token.token });
  }
  await until(async () => {
    const rows = await stack.sql<{ slug: string; sha: string }>(`SELECT b.slug, b.placement ->> 'runs_on' AS sha FROM app.bots b WHERE b.team_id = $1 AND b.slug IN ('support-email', 'customer-support')`, [team.id]);
    return rows.length === 2 && rows.every((r) => r.sha === RUNNER);
  }, 60_000, 'the loader to read the new placement');
});

test('2 · He uploads the manuals: a PDF, a Markdown FAQ and a CSV price list become passages the bots can search', async () => {
  await omar.post(`/api/teams/${TEAM}/knowledge`, { slug: 'manuals', name: 'Manuals' });
  const files: Array<{ name: string; type: string; body: Buffer }> = [
    { name: 'Returns policy.pdf', type: 'application/pdf', body: pdfOf(RETURNS_PDF_TEXT) },
    { name: 'Orders and delivery.md', type: 'text/markdown', body: Buffer.from(FAQ) },
    { name: 'Plans.csv', type: 'text/csv', body: Buffer.from(PRICES) },
  ];
  for (const file of files) {
    const res = await omar.ctx.post(`/api/teams/${TEAM}/knowledge/manuals/documents?name=${encodeURIComponent(file.name)}`, {
      data: file.body,
      headers: { ...(await omar.headers()), 'content-type': file.type },
    });
    expect(res.status(), `${file.name}: ${await res.text()}`).toBeLessThan(300);
    expect(((await res.json()) as { outcome: string }).outcome, file.name).toBe('added');
  }
  const base = await omar.get<{ documents: Array<{ name: string; status: string; kind: string; version: number }> }>(`/api/teams/${TEAM}/knowledge/manuals`);
  expect(base.documents.map((d) => d.name).sort()).toEqual(['Orders and delivery.md', 'Plans.csv', 'Returns policy.pdf']);
  expect(base.documents.every((d) => d.status === 'indexed' && d.version === 1), JSON.stringify(base.documents)).toBe(true);

  // the question a customer will ask finds the FAQ passage, with the document and version a citation needs
  const found = await omar.get<{ hits: Array<{ documentName: string; version: number; text: string }> }>(`/api/teams/${TEAM}/knowledge/manuals/search?q=${encodeURIComponent('change delivery address')}`);
  expect(found.hits[0]).toMatchObject({ documentName: 'Orders and delivery.md', version: 1 });
  expect(found.hits[0]!.text).toContain('until it has shipped');
  // the PDF was really read, not stored: its words are searchable too
  const pdf = await omar.get<{ hits: Array<{ documentName: string }> }>(`/api/teams/${TEAM}/knowledge/manuals/search?q=${encodeURIComponent('returned within 30 days')}`);
  expect(pdf.hits[0]?.documentName).toBe('Returns policy.pdf');

  // the converted text is a file of the team repo (so the Files screen shows it)
  const tree = await omar.get<{ entries?: Array<{ path: string }>; items?: Array<{ path: string }> }>(`/api/teams/${TEAM}/repo/tree?path=${encodeURIComponent('knowledge/manuals')}`);
  const names = (tree.entries ?? tree.items ?? []).map((e) => e.path);
  expect(names.join(' ')).toContain('sources.yaml');
  expect(names.filter((n) => n.endsWith('.md')).length).toBe(3);
});

test('3 · He adds the dummy mail connection support-mail, puts its credential in and switches it on; the bots’ mail grants are compiled', async () => {
  const created = await omar.post<{ connection: { id: string; slug: string; status: string; hasCredentials: boolean } }>(`/api/teams/${TEAM}/connections`, { kind: 'email', name: 'Support mailbox', slug: 'support-mail' });
  expect(created.connection).toMatchObject({ slug: 'support-mail', status: 'disabled', hasCredentials: false });
  const id = created.connection.id;

  // switching on before the credential is in is refused in plain words
  const early = await omar.ctx.patch(`/api/connections/${id}`, { data: { status: 'enabled' }, headers: await omar.headers() });
  expect(early.status()).toBe(409);

  const put = await omar.ctx.put(`/api/connections/${id}/credentials/password`, { data: { value: 'placeholder-for-the-dummy-mailbox' }, headers: await omar.headers() });
  expect(put.status(), await put.text()).toBe(200);
  const on = await omar.ctx.patch(`/api/connections/${id}`, { data: { status: 'enabled' }, headers: await omar.headers() });
  expect(on.status(), await on.text()).toBe(200);
  const listed = await omar.get<{ connections: Array<{ slug: string; status: string; hasCredentials: boolean }> }>(`/api/teams/${TEAM}/connections`);
  expect(listed.connections.find((c) => c.slug === 'support-mail')).toMatchObject({ status: 'enabled', hasCredentials: true });
  expect(JSON.stringify(listed)).not.toContain('placeholder-for-the-dummy-mailbox');

  // the Support email bot holds email.read and email.send on this connection, and the Customer support bot holds none
  await until(async () => {
    const grants = await stack.sql<{ slug: string; tool: string }>(
      `SELECT b.slug, g.tool FROM app.connection_grants g JOIN app.actors a ON a.id = g.actor_id JOIN app.bots b ON a.kind = 'bot' AND a.ref_id = b.id JOIN app.teams t ON t.id = b.team_id WHERE t.slug = $1 ORDER BY b.slug, g.tool`,
      [TEAM],
    );
    return grants.length === 2 && grants.map((g) => `${g.slug}:${g.tool}`).join() === 'support-email:email.read,support-email:email.send';
  }, 30_000, 'the mail grants of the Support email bot');
});

test('4 · Deploy (when the Deploy action exists): the three outcomes are reported', async () => {
  const res = await omar.ctx.post(`/api/teams/${TEAM}/bots/support-email/deploy`, { data: {}, headers: await omar.headers() });
  test.skip(res.status() === 404, 'the Deploy route (P8-34) is not in this build yet');
  expect(res.status(), await res.text()).toBeLessThan(300);
  const text = await res.text();
  // each of the three outcomes is named: the definition, the base, the connection
  expect(text.toLowerCase()).toContain('definition');
  expect(text.toLowerCase()).toContain('connection');
});

test('5 · A customer’s email is answered from the manuals; the reply goes out only after a person approves it', async () => {
  await mailIn(CUSTOMER, 'Change my delivery address', 'Hello, how do I change the delivery address of my order? I moved house last week. Thanks, Ayesha', '<ayesha-1@customer.example>');

  // the Support email bot posts the email at the top of #support-inbox and tags the Customer support bot
  const post = await inboxPost(CUSTOMER);
  expect(post.threadRootId).toBeNull();
  expect(post.body).toContain('**Subject:** Change my delivery address');
  expect(post.body).toContain('> Hello, how do I change the delivery address of my order?');
  expect(post.body).toContain('@customer-support');
  expect((await runsOf('support-email'))[0]).toMatchObject({ trigger_type: 'inbox' });

  // the Customer support bot answers in that thread, from the manuals, and tags the Support email bot
  const customerSupport = await actorOf('customer-support');
  const answer = await until(async () => (await messages(post.id)).find((m) => m.authorId === customerSupport && m.body.includes('@support-email')), 90_000, 'the Customer support bot’s answer');
  expect(answer.body).toContain('until it has shipped');
  expect(answer.body).toContain('Orders and delivery.md');
  const search = standIn.calls.find((c) => c.profile === 'customer-support' && c.tool === 'knowledge.search');
  expect(search?.ok, JSON.stringify(search?.answer)).toBe(true);
  expect((search!.answer as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

  // the Support email bot takes the answer to email.send, which waits for a person
  const card = await until(async () => (await pendingApprovals(omar)).find((a) => a.tool === 'email.send'), 90_000, 'the send to be held for approval');
  expect(card.summary).toContain(CUSTOMER);
  const send = standIn.calls.find((c) => c.tool === 'email.send');
  expect(send?.ok).toBe(false);
  expect(send?.answer).toMatchObject({ code: 'approval_pending' });
  // the model chose no recipient: the schema offers none
  expect(Object.keys(send!.args)).toEqual(['body']);
  expect(await outbound(), 'nothing has left the mailbox before the approval').toEqual([]);

  // what each bot was allowed to see: the tool lists the stand-in was offered
  const toolsOf = (profile: string): string[] => standIn.offered.get(standIn.calls.find((c) => c.profile === profile)!.runId) ?? [];
  expect(toolsOf('support-email')).toEqual(expect.arrayContaining(['messages.post', 'email.read', 'email.send']));
  expect(toolsOf('support-email')).not.toContain('knowledge.search');
  expect(toolsOf('customer-support')).toEqual(expect.arrayContaining(['messages.post', 'knowledge.search']));
  expect(toolsOf('customer-support')).not.toContain('email.send');

  // Sameera (role:support-agent, a member of the team) may see the card, but the bot names no approvers, so only the team's leads and the workspace admins decide: she is refused
  const refused = await sameera.ctx.post(`/api/teams/${TEAM}/approvals/${card.id}/approve`, { data: {}, headers: await sameera.headers() });
  expect(refused.status(), await refused.text()).toBe(403);
  expect(await outbound(), 'a refused approval sends nothing').toEqual([]);
  const approved = await omar.ctx.post(`/api/teams/${TEAM}/approvals/${card.id}/approve`, { data: {}, headers: await omar.headers() });
  expect(approved.status(), await approved.text()).toBeLessThan(300);

  // the approved call runs once, as the bot: one mail goes out, to the customer, with the manuals' words
  const sent = await until(async () => {
    const rows = await outbound();
    return rows.length > 0 ? rows : null;
  }, 90_000, 'the approved reply to leave the mailbox');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ direction: 'out', to_address: CUSTOMER, subject: 'Re: Change my delivery address', thread_key: '<ayesha-1@customer.example>' });
  expect(sent[0]!.body).toContain('until it has shipped');
  expect(sent[0]!.body).not.toContain('@support-email');
  expect(sent[0]!.body).not.toMatch(/^notes for the team/im);
  const decided = await stack.sql<{ status: string; outcome: string }>('SELECT status, outcome FROM app.approvals WHERE id = $1', [card.id]);
  expect(decided[0]).toMatchObject({ status: 'approved' });
  await until(async () => (await stack.sql<{ outcome: string }>('SELECT outcome FROM app.approvals WHERE id = $1', [card.id]))[0]?.outcome === 'ran', 60_000, 'the approval to be recorded as run');
});

test('6 · The escalation branch: a question the manuals do not cover goes to a person and leaves no mail for the customer', async () => {
  const sendsBefore = standIn.calls.filter((c) => c.tool === 'email.send').length;
  const mentionRunsBefore = (await runsOf('support-email')).filter((r) => r.trigger_type === 'mention').length;
  await mailIn(OTHER_CUSTOMER, 'Gift cards for my grandmother', 'Hello, do you sell gift cards? It is my grandmother’s birthday. Thanks, Bilal', '<bilal-1@customer.example>');

  const post = await inboxPost(OTHER_CUSTOMER);
  const customerSupport = await actorOf('customer-support');
  const handover = await until(async () => (await messages(post.id)).find((m) => m.authorId === customerSupport), 90_000, 'the Customer support bot’s hand-over');
  expect(handover.body).toContain('handing it to a person');
  expect(handover.body).toContain('role:support-agent');
  expect(handover.body).not.toContain('@support-email');
  const search = standIn.calls.filter((c) => c.profile === 'customer-support' && c.tool === 'knowledge.search').at(-1);
  expect(search?.ok).toBe(true);

  // the Customer support bot's run finished; the Support email bot was not woken again for this thread
  await until(async () => (await runsOf('customer-support')).every((r) => r.status !== 'running') && (await runsOf('customer-support')).length === 2, 60_000, 'the Customer support runs to close');
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect((await runsOf('support-email')).filter((r) => r.trigger_type === 'mention'), 'the Support email bot is not woken again for the escalated mail').toHaveLength(mentionRunsBefore);
  expect(standIn.calls.filter((c) => c.tool === 'email.send')).toHaveLength(sendsBefore);

  // no card was raised and nothing went to this customer: the only mail out is the first customer’s
  expect(await pendingApprovals(omar)).toEqual([]);
  const out = await outbound();
  expect(out.map((m) => m.to_address)).toEqual([CUSTOMER]);
  expect(out.filter((m) => m.to_address === OTHER_CUSTOMER)).toEqual([]);
});

test.afterAll(() => {
  void playwrightRef;
});
