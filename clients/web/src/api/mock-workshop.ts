import {
  WORKSHOP_MAX_MESSAGES,
  WorkshopSessionListResponse,
  WorkshopSessionResponse,
  botEvalSetPath,
  createWorkshopSessionRoute,
  endWorkshopSessionRoute,
  getWorkshopSessionRoute,
  listWorkshopSessionsRoute,
  postWorkshopMessageRoute,
  type ProposalId,
  type WorkshopEntry,
  type WorkshopMode,
  type WorkshopSession,
} from '@manythreads/shared';

/*
 * The mock of the Workshop tab (P7-05): the same routes and shapes the server answers, with a scripted helper in place of the model. A message is answered after two reads of the conversation
 * (like a real one, which is written in the background). Build turns a correction into a lesson, a test case and (when asked) a rule, all as proposals; Rehearse runs a pretend bot whose
 * write is held back and badged "not really done"; Live answers from pretend run records. A message that contains the word "fail" ends the conversation as failed, so the failure state can
 * be seen without a server. Rehearse is for a team lead or a workspace admin, like the real thing.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;
type Reply = { status: number; body: unknown };

export type WorkshopMockHooks = {
  /** The signed-in person leads this team or is a workspace admin. */
  canRehearse(slug: string): boolean;
  fail(status: number, code: 'not_found' | 'conflict' | 'validation_failed' | 'forbidden', message: string): never;
};

const NOW = '2026-10-01T14:02:00.000Z';
const uuid = (kind: string, n: number): string => `00000000-0000-7000-8000-0000000${kind}${String(n).padStart(4, '0')}`;

type Held = { session: WorkshopSession; reads: number; pending: { text: string; about: boolean } | null };

export function installWorkshopMock(on: On, hooks: WorkshopMockHooks): { begin: (slug: string, botSlug: string, mode: WorkshopMode, text?: string) => WorkshopSession } {
  const sessions = new Map<string, Held>();
  let counter = 0;
  let proposalCounter = 0;

  const held = (id: string | undefined): Held => {
    const h = id ? sessions.get(id) : undefined;
    if (!h) hooks.fail(404, 'not_found', 'No such Workshop conversation');
    return h as Held;
  };
  const view = (h: Held): unknown => WorkshopSessionResponse.parse({ session: h.session });
  const created = (body: unknown): Reply => ({ status: 201, body });
  const nextId = (h: Held): string => `e${String(h.session.entries.length + 1)}`;
  const push = (h: Held, entry: (id: string) => WorkshopEntry): void => {
    h.session = { ...h.session, entries: [...h.session.entries, entry(nextId(h))] };
  };
  const open = (): number => [...sessions.values()].filter((h) => h.session.status === 'working' || h.session.status === 'ready').length;

  // one way to start a conversation: the create route and a confirmed full replay (mock-replay.ts) both use it
  const begin = (slug: string, botSlug: string, mode: WorkshopMode, text?: string): Held => {
    if (mode === 'rehearse' && !hooks.canRehearse(slug)) hooks.fail(403, 'forbidden', 'Only a team lead or an admin can rehearse a bot');
    if (open() >= 3) hooks.fail(409, 'conflict', 'You already have Workshop conversations open. End one first.');
    counter += 1;
    const session: WorkshopSession = WorkshopSessionResponse.parse({
      session: {
        id: uuid('a', counter), teamId: uuid('b', 1), botSlug, mode, status: 'ready', title: '', entries: [], messageCount: 0,
        usage: { calls: 0, promptTokens: 0, completionTokens: 0, label: mode === 'rehearse' ? 'rehearsal' : 'workshop' }, message: null, createdAt: NOW, updatedAt: NOW,
      },
    }).session;
    const h: Held = { session, reads: 0, pending: null };
    sessions.set(session.id, h);
    if (text !== undefined) say(h, text, false);
    return h;
  };

  on(createWorkshopSessionRoute, ({ params, body }) =>
    created({ session: begin(params['slug'] as string, params['botSlug'] as string, body['mode'] as WorkshopMode, typeof body['text'] === 'string' ? body['text'] : undefined).session }),
  );

  function say(h: Held, text: string, about: boolean): void {
    push(h, (id) => ({ id, at: NOW, kind: 'person', text }));
    h.session = { ...h.session, status: 'working', title: h.session.title || text.slice(0, 60), messageCount: h.session.messageCount + 1 };
    h.pending = { text, about };
    h.reads = 0;
  }

  const answer = (h: Held): void => {
    const p = h.pending;
    if (!p) return;
    h.pending = null;
    const usage = { ...h.session.usage, calls: h.session.usage.calls + 1, promptTokens: h.session.usage.promptTokens + 300, completionTokens: h.session.usage.completionTokens + 60 };
    if (/fail/i.test(p.text)) {
      h.session = { ...h.session, status: 'failed', message: 'The model did not answer. Start a new conversation and try again.', usage };
      return;
    }
    const mode = h.session.mode;
    if (mode === 'rehearse') {
      push(h, (id) => ({ id, at: NOW, kind: 'step', tool: 'messages.post', what: 'Post a message in #support', outcome: 'held', badge: 'not really done' }));
      push(h, (id) => ({ id, at: NOW, kind: 'step', tool: 'knowledge.search', what: 'Search the manuals', outcome: 'read', badge: null }));
      push(h, (id) => ({ id, at: NOW, kind: 'reply', text: 'I would answer from the manuals and tell #support what I did. (Nothing was really posted.)', rehearsal: true }));
    } else if (mode === 'live') {
      push(h, (id) => ({ id, at: NOW, kind: 'step', tool: 'list_runs', what: 'Read the bot\'s runs from the last 7 days', outcome: 'read', badge: null }));
      push(h, (id) => ({ id, at: NOW, kind: 'reply', text: 'In the last 7 days it ran 4 times. 3 finished; 1 was stopped because it was waiting for approval.', rehearsal: false }));
    } else if (p.about || /wrong|should|correct|mistake|rule/i.test(p.text)) {
      // the files a correction becomes, at the paths the server uses: the bot's own folder, and the scenario set the Workshop writes its test cases to ("lessons")
      const bot = h.session.botSlug;
      const file = (role: 'lessons' | 'eval' | 'rule', path: string, title: string): void => {
        proposalCounter += 1;
        push(h, (id) => ({ id, at: NOW, kind: 'proposal', proposalId: uuid('f', proposalCounter) as ProposalId, path, role, title }));
      };
      push(h, (id) => ({ id, at: NOW, kind: 'reply', text: 'Thanks. I wrote that down as a lesson and a test case. A person approves both.', rehearsal: false }));
      file('lessons', `bots/${bot}/lessons.md`, `Add a lesson for ${bot}`);
      file('eval', botEvalSetPath(bot, 'lessons'), 'Add a test case for that lesson');
      if (/rule/i.test(p.text)) file('rule', `bots/${bot}/BOT.md`, `Add a rule to ${bot}`);
    } else {
      push(h, (id) => ({ id, at: NOW, kind: 'reply', text: 'Tell me what it got wrong and I will propose a lesson, or ask for a change and I will propose that.', rehearsal: false }));
    }
    h.session = { ...h.session, status: 'ready', usage };
  };

  on(listWorkshopSessionsRoute, ({ params }) =>
    WorkshopSessionListResponse.parse({
      sessions: [...sessions.values()]
        .filter((h) => h.session.botSlug === params['botSlug'])
        .map((h) => ({ id: h.session.id, mode: h.session.mode, status: h.session.status, title: h.session.title, messageCount: h.session.messageCount, updatedAt: h.session.updatedAt }))
        .reverse(),
    }),
  );

  on(getWorkshopSessionRoute, ({ params }) => {
    const h = held(params['sessionId']);
    if (h.session.status === 'working') {
      h.reads += 1;
      if (h.reads >= 2) answer(h);
    }
    return view(h);
  });

  on(postWorkshopMessageRoute, ({ params, body }) => {
    const h = held(params['sessionId']);
    if (h.session.status === 'working') hooks.fail(409, 'conflict', 'The helper is still answering. Wait for the answer first.');
    if (h.session.status !== 'ready') hooks.fail(409, 'conflict', 'This conversation is over. Start a new one.');
    if (h.session.messageCount >= WORKSHOP_MAX_MESSAGES) hooks.fail(409, 'conflict', `A conversation takes ${String(WORKSHOP_MAX_MESSAGES)} messages. Start a new one.`);
    const about = body['about'] as { sessionId: string; entryId: string } | undefined;
    if (about) {
      const source = sessions.get(about.sessionId);
      const entry = source?.session.entries.find((e) => e.id === about.entryId);
      if (h.session.mode !== 'build' || entry?.kind !== 'reply') hooks.fail(400, 'validation_failed', 'about: that is not a reply of your rehearsal of this bot');
    }
    // the right is checked again on every message, as the server does: a lead who is no longer one cannot go on rehearsing
    if (h.session.mode === 'rehearse' && !hooks.canRehearse(params['slug'] as string)) hooks.fail(403, 'forbidden', 'Only a team lead or an admin can rehearse a bot');
    say(h, String(body['text']), about !== undefined);
    return view(h);
  });

  on(endWorkshopSessionRoute, ({ params }) => {
    const h = held(params['sessionId']);
    if (h.session.status === 'working' || h.session.status === 'ready') h.session = { ...h.session, status: h.session.status === 'working' ? 'cancelled' : 'ended' };
    return view(h);
  });
  return { begin: (slug, botSlug, mode, text) => begin(slug, botSlug, mode, text).session };
}
