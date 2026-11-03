import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetSurfaceResponse, ListMessagesResponse, ListSurfacesResponse, type Message } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';
import { resetCallLimits } from '../src/index.ts';

// `surface.render`, `surface.update` and `surface.event` end to end (PLAN P9-04): a person talks to a bot, the router opens a run, the stand-in Hermes calls the
// tools over the run's real MCP endpoint, the person presses the button through the web route, and the next run reads the press. Same stand-in as answer.test.ts.

const { nadia, omar, rafi } = personas;
vi.setConfig({ testTimeout: 180_000 });

const FAKE_HERMES = [
  "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const home = process.env.HERMES_HOME ?? '';",
  "const config = readFileSync(home + '/config.yaml', 'utf8');",
  'const url = JSON.parse(/^\\s+url: (.*)$/m.exec(config)[1]);',
  'const bearer = JSON.parse(/Authorization: (.*)$/m.exec(config)[1]);',
  "const target = (process.env.HERMES_FAKE_ORIGIN ?? '') + new URL(url).pathname;",
  "const scenarioPath = process.env.HERMES_FAKE_SCENARIO ?? '';",
  "const scenario = scenarioPath && existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : { steps: [] };",
  'const call = async (step, id) => {',
  "  const body = step.method === 'tools/list' ? { jsonrpc: '2.0', id, method: 'tools/list' } : { jsonrpc: '2.0', id, method: 'tools/call', params: { name: step.name, arguments: step.arguments ?? {} } };",
  "  const res = await fetch(target, { method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });",
  '  return { status: res.status, body: await res.text() };',
  '};',
  'const results = [];',
  'for (const [i, step] of scenario.steps.entries()) results.push(await call(step, i + 1));',
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify({ prompt, results }) + '\\n');",
  "const reply = scenario.text ?? ('Answering: ' + prompt.replace(/\\s+/g, ' '));",
  "process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  '',
].join('\n');

const botMd = (name: string, native: string[]): string =>
  ['---', 'schema: 1', `name: ${name}`, 'role: Draws screens in the surfaces test', 'kind: agent', 'runtime: hermes', 'model:', '  aliases: [smart]', 'triggers:', '  - { type: conversation }', 'capabilities:', `  native: [${native.join(', ')}]`, '---', '', `# ${name}`, '', 'Soul text of the surfaces test.', ''].join('\n');

let w: RepoWorld;
let scratch = '';
let spool = '';
let scenarioFile = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['MANYTHREADS_HERMES_BIN', 'MANYTHREADS_HERMES_PREFIX', 'MANYTHREADS_RUNTIME_DIR', 'MANYTHREADS_LITELLM_URL', 'HERMES_FAKE_SPOOL', 'HERMES_FAKE_SCENARIO', 'HERMES_FAKE_ORIGIN'];

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

interface Spooled {
  prompt: string;
  results: Array<{ status: number; body: string }>;
}
const spooled = (): Spooled[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Spooled)
    : [];
const toolAnswer = (result: { status: number; body: string }): Record<string, unknown> => {
  const rpc = JSON.parse(result.body) as { result?: { content?: Array<{ text?: string }> } };
  return JSON.parse(rpc.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
};
const listed = (s: Spooled): string[] => (JSON.parse(s.results[0]!.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);

interface LoadedBot {
  botId: string;
  actorId: string;
}
async function loadBot(slug: string, md: string): Promise<LoadedBot> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: md }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  const botId = await until(
    () => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = $1 AND b.status = 'active'`, [slug])).rows[0]?.id ?? null),
    20_000,
    `the loader to load ${slug}`,
  );
  const actorId = await until(() => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0]?.id ?? null), 5_000, `the actor of ${slug}`);
  return { botId, actorId };
}

type Step = { method?: 'tools/list'; name?: string; arguments?: Record<string, unknown> };
const scenario = (steps: Step[]): void => writeFileSync(scenarioFile, JSON.stringify({ steps, text: 'Done.' }), 'utf8');
const send = async (who: typeof nadia, channelId: string, body: string): Promise<string> => {
  const res = await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
};
const thread = async (who: typeof nadia, channelId: string, rootId: string): Promise<Message[]> => {
  const res = await w.call(who, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items;
};
const conversationOf = async (who: typeof nadia, slug: string): Promise<string> => {
  const res = await w.call<{ channelId: string }>(who, 'POST', `/api/teams/engineering/bots/${slug}/conversation`);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.channelId;
};
const finishedRun = (rootId: string) =>
  until(
    async () => {
      const run = await w.system(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.bot_runs WHERE reply_root_id = $1 ORDER BY started_at DESC LIMIT 1', [rootId])).rows[0]);
      return run && run.status !== 'running' ? run : null;
    },
    90_000,
    'the run to finish',
  );
/** One run of a bot: the person writes, the stand-in performs the scenario, and what each tool answered comes back. */
async function runOf(who: typeof nadia, chat: string, text: string, steps: Step[]): Promise<{ root: string; seen: Spooled }> {
  scenario(steps);
  const root = await send(who, chat, text);
  expect(await finishedRun(root)).toMatchObject({ status: 'done' });
  return { root, seen: spooled().find((s) => s.prompt.includes(text))! };
}

const SCREEN = ['root = Stack([title, go, stop])', 'title = Heading("Deploy staging?", 2)', 'go = Button("Deploy", "primary")', 'stop = Button("Cancel")', ''].join('\n');
let painter: LoadedBot;
let rival: LoadedBot;
let plain: LoadedBot;
let chat = '';
let surfaceId = '';

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  scratch = mkdtempSync(join(tmpdir(), 'surfaces-'));
  spool = join(scratch, 'spool.jsonl');
  scenarioFile = join(scratch, 'scenario.json');
  const bin = join(scratch, 'fake-hermes.mjs');
  writeFileSync(bin, FAKE_HERMES, 'utf8');
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = bin;
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'profiles');
  process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
  process.env['HERMES_FAKE_SPOOL'] = spool;
  process.env['HERMES_FAKE_SCENARIO'] = scenarioFile;
  w = await createRepoWorld();
  process.env['HERMES_FAKE_ORIGIN'] = w.server.url;
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  painter = await loadBot('painter', botMd('Painter', ['surface.render', 'surface.update', 'surface.event', 'messages.post']));
  rival = await loadBot('rival', botMd('Rival', ['surface.render', 'surface.update', 'surface.event', 'messages.post']));
  plain = await loadBot('plain', botMd('Plain', ['messages.post']));
  chat = await conversationOf(nadia, 'painter');
}, 300_000);

afterAll(async () => {
  await w?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

const press = (who: typeof nadia, over: Record<string, unknown> = {}) =>
  w.call(who, 'POST', `/api/channels/${chat}/surfaces/${surfaceId}/events`, { nodeId: 'go', name: 'press', version: 1, payload: {}, ...over });

describe('drawing a screen', () => {
  it('stores it, answers with its id and version, and posts a message in the thread that points at it', async () => {
    const { root, seen } = await runOf(nadia, chat, 'Draw me the deploy screen', [
      { method: 'tools/list' },
      { name: 'surface.render', arguments: { title: 'Deploy staging', source: SCREEN } },
    ]);
    expect(listed(seen)).toEqual(expect.arrayContaining(['surface.render', 'surface.update', 'surface.event']));
    const answer = toolAnswer(seen.results[1]!);
    expect(answer).toMatchObject({ ok: true, version: 1 });
    surfaceId = answer['surfaceId'] as string;

    const mine = (await thread(nadia, chat, root)).filter((m) => m.authorId === painter.actorId && m.meta.surfaceRef !== undefined);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ body: 'Deploy staging', threadRootId: root, channelId: chat });
    expect(mine[0]!.meta.surfaceRef).toBe(surfaceId);

    const one = GetSurfaceResponse.parse((await w.call(nadia, 'GET', `/api/channels/${chat}/surfaces/${surfaceId}`)).body);
    expect(one).toMatchObject({ id: surfaceId, botId: painter.botId, channelId: chat, version: 1, source: SCREEN, threadRootId: root, createdBy: painter.actorId });
    const list = ListSurfacesResponse.parse((await w.call(nadia, 'GET', `/api/channels/${chat}/surfaces`)).body);
    expect(list.items.map((s) => s.id)).toEqual([surfaceId]);
  });

  it('keeps the history, announces itself with ids and counts only, and tells the page by a push-sized event', async () => {
    const lines = await w.system(async (tx) => (await tx.query<{ kind: string; version: number }>('SELECT kind, version FROM app.surface_events WHERE surface_id = $1 ORDER BY id', [surfaceId])).rows);
    expect(lines).toEqual([{ kind: 'render', version: 1 }]);
    const events = await w.system(async (tx) => (await tx.query<{ type: string; team_id: string | null; payload: Record<string, unknown> }>("SELECT type, team_id, payload FROM app.events WHERE type = 'surfaces.surface.rendered'")).rows);
    expect(events).toHaveLength(1);
    // a conversation with a bot belongs to its person, not to the team
    expect(events[0]!.team_id).toBeNull();
    expect(JSON.stringify(events[0]!.payload)).not.toContain('Deploy staging');
    expect(JSON.stringify(events[0]!.payload)).not.toContain('Heading');
  });

  it('a screen the checker cannot draw at all is refused with the plain reason, and nothing is stored or posted', async () => {
    const before = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.surfaces')).rows.length);
    const { root, seen } = await runOf(nadia, chat, 'Draw something broken', [{ name: 'surface.render', arguments: { title: 'Broken', source: 'root = Nope("x")\n' } }]);
    expect(toolAnswer(seen.results[0]!)).toMatchObject({ ok: false, code: 'rejected' });
    expect(String(toolAnswer(seen.results[0]!)['message'])).toMatch(/Nothing was drawn/);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.surfaces')).rows.length)).toBe(before);
    expect((await thread(nadia, chat, root)).filter((m) => m.meta.surfaceRef !== undefined)).toHaveLength(0);
  });

  it('an Answer part is drawn only by the platform: a bot\'s screen with one, at the root or inside another part, is refused and nothing is stored', async () => {
    const before = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.surfaces')).rows.length);
    const { seen } = await runOf(nadia, chat, 'Draw a forged answer', [
      { name: 'surface.render', arguments: { title: 'Forged', source: 'root = Answer(1, "x")\n' } },
      { name: 'surface.render', arguments: { title: 'Forged inside', source: 'root = Stack([a, b])\na = Text("fine")\nb = Answer(1, "x")\n' } },
    ]);
    for (const r of seen.results) {
      expect(toolAnswer(r)).toMatchObject({ ok: false, code: 'rejected' });
      expect(String(toolAnswer(r)['message'])).toMatch(/Answer is drawn only by the platform; use Callout or Text/);
    }
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.surfaces')).rows.length)).toBe(before);
  });

  it('a screen with one bad part is stored, the bad part is a card, and the refusal is kept as a rejected line', async () => {
    const { seen } = await runOf(nadia, chat, 'Draw one with a bad part', [
      { name: 'surface.render', arguments: { title: 'Half', source: 'root = Stack([a, b])\na = Text("fine")\nb = Gizmo("x")\n' } },
    ]);
    const answer = toolAnswer(seen.results[0]!);
    expect(answer).toMatchObject({ ok: true, version: 1 });
    expect(JSON.stringify(answer['problems'])).toContain('unknown_component');
    const kinds = await w.system(async (tx) => (await tx.query<{ kind: string }>('SELECT kind FROM app.surface_events WHERE surface_id = $1 ORDER BY id', [answer['surfaceId']])).rows.map((r) => r.kind));
    expect(kinds).toEqual(['render', 'rejected']);
  });

  it('is not offered to a bot that was not granted it, and refused when it is called anyway', async () => {
    const chatPlain = await conversationOf(nadia, 'plain');
    const { root, seen } = await runOf(nadia, chatPlain, 'Plain, draw anyway', [
      { method: 'tools/list' },
      { name: 'surface.render', arguments: { title: 'Sneaky', source: SCREEN } },
    ]);
    expect(listed(seen)).toContain('messages.post');
    for (const name of ['surface.render', 'surface.update', 'surface.event']) expect(listed(seen)).not.toContain(name);
    expect(toolAnswer(seen.results[1]!)).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await thread(nadia, chatPlain, root)).filter((m) => m.meta.surfaceRef !== undefined)).toHaveLength(0);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE bot_id = $1', [plain.botId])).rows.length)).toBe(0);
  });

  it('refuses arguments that name a place: the channel is the run\'s, never the model\'s', async () => {
    const { seen } = await runOf(nadia, chat, 'Draw elsewhere', [{ name: 'surface.render', arguments: { title: 'Elsewhere', source: SCREEN, channelId: chat } }]);
    expect(toolAnswer(seen.results[0]!)).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });
});

describe('who reads and who answers', () => {
  it('only people who read the conversation read the screen; another person gets no screen and no answer', async () => {
    expect((await w.call(rafi, 'GET', `/api/channels/${chat}/surfaces`)).status).toBe(403);
    expect((await w.call(rafi, 'GET', `/api/channels/${chat}/surfaces/${surfaceId}`)).status).toBe(403);
    expect((await press(rafi)).status).toBe(403);
    expect((await press(omar)).status).toBe(403);
    expect(await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.surface_events WHERE surface_id = $1 AND kind = 'event'", [surfaceId])).rows.length)).toBe(0);
  });

  it('a press is one history line with the part and the event, and the page is told', async () => {
    const res = await press(nadia);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ event: { surfaceId, kind: 'event', version: 1, nodeId: 'go', actorId: nadia.actorId, payload: { name: 'press', data: {} } } });
    const events = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'surfaces.surface.event_posted'")).rows);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ surfaceId, nodeId: 'go', eventName: 'press', actorId: nadia.actorId });
  });

  it('refuses what the part did not offer: another event, a missing part, a payload with anything in it, a command, a stale version', async () => {
    const before = await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.surface_events WHERE surface_id = $1 AND kind = 'event'", [surfaceId])).rows.length);
    expect((await press(nadia, { name: 'submit' })).status).toBe(400);
    expect((await press(nadia, { nodeId: 'title' })).status).toBe(400);
    expect((await press(nadia, { nodeId: 'nothing' })).status).toBe(400);
    expect((await press(nadia, { payload: { value: 'yes' } })).status).toBe(400);
    expect((await press(nadia, { payload: { tool: 'messages.post', arguments: { body: 'hi' } } })).status).toBe(400);
    expect((await press(nadia, { tool: 'messages.post' })).status).toBe(400);
    expect((await press(nadia, { channelId: chat })).status).toBe(400);
    expect((await press(nadia, { version: 2 })).status).toBe(409);
    expect((await press(nadia, { version: 0 })).status).toBe(400);
    expect(await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.surface_events WHERE surface_id = $1 AND kind = 'event'", [surfaceId])).rows.length)).toBe(before);
    // and nothing it could have meant ran: no message was posted by anyone because of a "command"
    expect(await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.messages WHERE channel_id = $1 AND body LIKE 'hi'", [chat])).rows.length)).toBe(0);
  });

  it('a screen is reached only through its own channel', async () => {
    const dev = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT c.id FROM app.channels c WHERE c.team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND c.name = 'dev'")).rows[0]!.id);
    expect((await w.call(nadia, 'GET', `/api/channels/${dev}/surfaces/${surfaceId}`)).status).toBe(404);
    expect((await w.call(nadia, 'POST', `/api/channels/${dev}/surfaces/${surfaceId}/events`, { nodeId: 'go', name: 'press', version: 1, payload: {} })).status).toBe(404);
  });

  it('one person cannot fill the queue: five answers waiting on a screen is the most, then a plain 429', async () => {
    for (let i = 0; i < 4; i++) expect((await press(nadia)).status).toBe(201);
    const refused = await press(nadia);
    expect(refused.status).toBe(429);
    expect(JSON.stringify(refused.body)).toMatch(/already sent the bot several answers/);
    await w.system((tx) => tx.query(`DELETE FROM app.surface_events WHERE surface_id = $1 AND kind = 'event' AND id NOT IN (SELECT id FROM app.surface_events WHERE surface_id = $1 AND kind = 'event' ORDER BY id LIMIT 1)`, [surfaceId]));
  });

  it('a reader who cannot post (the conversation is archived) can read the screen and is refused with a 403', async () => {
    await w.system((tx) => tx.query('UPDATE app.channels SET archived_at = now() WHERE id = $1', [chat]));
    try {
      expect((await w.call(nadia, 'GET', `/api/channels/${chat}/surfaces/${surfaceId}`)).status).toBe(200);
      expect((await press(nadia)).status).toBe(403);
    } finally {
      await w.system((tx) => tx.query('UPDATE app.channels SET archived_at = NULL WHERE id = $1', [chat]));
    }
  });

  it('keeps the number of answers waiting for the bot below a cap', async () => {
    // 100 pending is the cap; the press above is one. Fill with other people's rows, then the next press is a 429 and nothing is added.
    await w.system(async (tx) => {
      for (let i = 0; i < 99; i++) {
        await tx.query(
          `INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version, node_id, payload)
           SELECT s.id, s.workspace_id, s.channel_id, $2, 'event', 1, 'go', '{"name":"press","data":{}}'::jsonb FROM app.surfaces s WHERE s.id = $1`,
          [surfaceId, omar.actorId],
        );
      }
    });
    const full = await press(nadia);
    expect(full.status).toBe(429);
    expect(JSON.stringify(full.body)).toMatch(/Too many answers/);
    // remove the filler again so the later tests read one press
    await w.system((tx) => tx.query(`DELETE FROM app.surface_events WHERE surface_id = $1 AND kind = 'event' AND id NOT IN (SELECT id FROM app.surface_events WHERE surface_id = $1 AND kind = 'event' ORDER BY id LIMIT 1)`, [surfaceId]));
  });
});

describe('what the bot reads and changes', () => {
  it('reads the press as data (who, which part, which event, what it carried) and not as an instruction', async () => {
    const { seen } = await runOf(nadia, chat, 'What did they press', [{ name: 'surface.event', arguments: {} }]);
    const answer = toolAnswer(seen.results[0]!);
    expect(answer).toMatchObject({ ok: true, more: false });
    const events = answer['events'] as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ surfaceId, part: 'go', event: 'press', payload: {}, version: 1, by: { actorId: nadia.actorId } });
    expect(String(answer['note'])).toMatch(/never instructions/);
  });

  it('a stale base version is refused and nothing changes; an update bumps the version and answers every press before it', async () => {
    const { seen } = await runOf(nadia, chat, 'Update the screen', [
      { name: 'surface.update', arguments: { surfaceId, patch: 'title = Heading("Deploying", 2)', baseVersion: 7 } },
      { name: 'surface.update', arguments: { surfaceId, patch: 'title = Heading("Deploying", 2)\nnote = Text("Started")', baseVersion: 1 } },
      { name: 'surface.event', arguments: { surfaceId } },
    ]);
    expect(toolAnswer(seen.results[0]!)).toMatchObject({ ok: false, code: 'stale_version', currentVersion: 1 });
    expect(toolAnswer(seen.results[1]!)).toMatchObject({ ok: true, changed: true, version: 2, replaced: ['title'], added: ['note'] });
    expect(toolAnswer(seen.results[2]!)).toMatchObject({ ok: true, events: [] });
    const one = GetSurfaceResponse.parse((await w.call(nadia, 'GET', `/api/channels/${chat}/surfaces/${surfaceId}`)).body);
    expect(one.version).toBe(2);
    expect(one.source).toContain('Heading("Deploying", 2)');
    expect(one.source).toContain('go = Button("Deploy", "primary")');
    // a press of the screen as it was is now refused: the person must look at the new one
    expect((await press(nadia, { version: 1 })).status).toBe(409);
    expect((await press(nadia, { version: 2 })).status).toBe(201);
    const lines = await w.system(async (tx) => (await tx.query<{ kind: string }>("SELECT kind FROM app.surface_events WHERE surface_id = $1 AND kind <> 'event' ORDER BY id", [surfaceId])).rows.map((r) => r.kind));
    expect(lines).toEqual(['render', 'update']);
  });

  it('a patch that would make a drawn part worse is refused whole, and kept as a rejected line', async () => {
    const { seen } = await runOf(nadia, chat, 'Break the screen', [
      { name: 'surface.update', arguments: { surfaceId, patch: 'go = Button(42)' } },
      { name: 'surface.update', arguments: { surfaceId, patch: 'not a statement' } },
    ]);
    expect(toolAnswer(seen.results[0]!)).toMatchObject({ ok: false, code: 'rejected', currentVersion: 2 });
    expect(toolAnswer(seen.results[1]!)).toMatchObject({ ok: false, code: 'rejected' });
    const one = GetSurfaceResponse.parse((await w.call(nadia, 'GET', `/api/channels/${chat}/surfaces/${surfaceId}`)).body);
    expect(one.version).toBe(2);
    expect(one.source).toContain('go = Button("Deploy", "primary")');
    const rejected = await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.surface_events WHERE surface_id = $1 AND kind = 'rejected'", [surfaceId])).rows.length);
    expect(rejected).toBe(2);
  });
});

describe('only the owning bot, inside its own run', () => {
  it('another bot cannot change or hear a screen it did not draw: it is "not found", the same as one that does not exist', async () => {
    const chatRival = await conversationOf(nadia, 'rival');
    const { seen } = await runOf(nadia, chatRival, 'Rival, take over', [
      { name: 'surface.update', arguments: { surfaceId, patch: 'title = Heading("Hijacked", 1)' } },
      { name: 'surface.event', arguments: { surfaceId } },
      { name: 'surface.update', arguments: { surfaceId: '00000000-0000-4000-8000-000000000000', patch: 'title = Heading("x", 1)' } },
      { name: 'surface.event', arguments: {} },
    ]);
    expect(toolAnswer(seen.results[0]!)).toMatchObject({ ok: false, code: 'not_found' });
    expect(toolAnswer(seen.results[1]!)).toMatchObject({ ok: false, code: 'not_found' });
    expect(toolAnswer(seen.results[2]!)).toMatchObject({ ok: false, code: 'not_found' });
    expect(toolAnswer(seen.results[3]!)).toMatchObject({ ok: true, events: [] });
    const one = GetSurfaceResponse.parse((await w.call(nadia, 'GET', `/api/channels/${chat}/surfaces/${surfaceId}`)).body);
    expect(one.source).not.toContain('Hijacked');
  });

  it('draws in the place of its own run even when asked from elsewhere: the screen of the rival lands in the rival\'s conversation', async () => {
    const chatRival = await conversationOf(nadia, 'rival');
    const { root, seen } = await runOf(nadia, chatRival, 'Rival, draw your own', [{ name: 'surface.render', arguments: { title: 'Rival screen', source: SCREEN } }]);
    const made = toolAnswer(seen.results[0]!);
    expect(made).toMatchObject({ ok: true });
    const row = await w.system(async (tx) => (await tx.query<{ channel_id: string; bot_id: string; thread_root_id: string }>('SELECT channel_id, bot_id, thread_root_id FROM app.surfaces WHERE id = $1', [made['surfaceId']])).rows[0]!);
    expect(row).toEqual({ channel_id: chatRival, bot_id: rival.botId, thread_root_id: root });
  });

  it('the tools answer nothing outside a run (called by a person over the API there is no route for them)', async () => {
    for (const path of [`/api/channels/${chat}/surfaces`, `/api/channels/${chat}/surfaces/${surfaceId}`]) {
      expect((await w.call(nadia, 'PUT', path, { source: 'root = Text("x")' })).status).toBeGreaterThanOrEqual(400);
      expect((await w.call(nadia, 'PATCH', path, { patch: 'a = Text("x")' })).status).toBeGreaterThanOrEqual(400);
      expect((await w.call(nadia, 'DELETE', path)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await w.call(nadia, 'POST', `/api/channels/${chat}/surfaces`, { title: 'x', source: 'root = Text("x")' })).status).toBeGreaterThanOrEqual(400);
    resetCallLimits();
  });
});
