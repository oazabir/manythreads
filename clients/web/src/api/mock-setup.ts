import {
  ProposalResponse,
  SetupSessionResponse,
  answerSetupRoute,
  approveProposalRoute,
  cancelSetupRoute,
  createSetupSessionRoute,
  getProposalRoute,
  getSetupSessionRoute,
  rejectProposalRoute,
  retrySetupRoute,
  withdrawProposalRoute,
  type GradedRequirement,
  type SetupInventory,
  type SetupQuestion,
  type SetupSession,
} from '@manythreads/shared';

/*
 * The mock of "Add a bot" (P7-04): the same routes and shapes the server answers, with a scripted helper in place of the model. Offline it plays the whole flow: a conversation reads as
 * working for a few reads, then asks (one gap of each kind), then, once answered, proposes a bot. A brief that contains the word "fail" ends as a failed conversation, so the screen's
 * failure state can be seen without a server. Approving needs a team lead or a workspace admin, like the real thing; the proposals it files are in memory for the tab.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type Reply = { status: number; body: unknown };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;

export type SetupMockHooks = {
  /** The signed-in person may approve in this team (a lead or an admin). */
  canApprove(slug: string): boolean;
  fail(status: number, code: 'not_found' | 'conflict' | 'validation_failed' | 'forbidden', message: string): never;
  teamName(slug: string): string;
};

const NOW = '2026-10-01T14:02:00.000Z';
const id = (kind: string, n: number): string => `00000000-0000-7000-8000-0000000${kind}${String(n).padStart(4, '0')}`;
const created = (body: unknown): Reply => ({ status: 201, body });

const INVENTORY = (team: string, name: string): SetupInventory => ({
  team: { slug: team, name },
  asker: { role: 'lead', canGrantDestructive: true, canAddBot: false },
  bots: [{ slug: 'brain', name: 'Brain', role: 'Answers from the team notes', kind: 'agent', runtime: 'hermes', status: 'active' }],
  knowledge: [{ slug: 'manuals', name: 'Manuals' }],
  skills: [{ slug: 'review' }],
  runners: [{ name: 'fast-model', label: 'Fast model', kind: 'llm_gateway', status: 'ready', isDefault: true }],
  models: [{ alias: 'smart' }, { alias: 'fast' }],
  channels: [{ name: 'support' }, { name: 'kb-updates' }],
  roleTags: ['role:on-call'],
  capabilities: [
    { name: 'knowledge.search', destructive: false },
    { name: 'messages.post', destructive: false },
  ],
  triggers: [
    { type: 'mention', available: true },
    { type: 'routine', available: true },
    { type: 'inbox', available: false, note: 'Needs a connection.' },
  ],
  runtimeAllowed: [],
  guardDefault: 'standard',
  connections: [],
  connectionsNote: 'No connections exist in this release.',
});

const REQUIREMENTS = (): GradedRequirement[] => [
  { id: 'manuals', text: 'Answer from the product manuals', kind: 'knowledge', name: 'manuals', grade: 'covered', reason: 'The team has a knowledge base called "manuals".' },
  { id: 'post', text: 'Tell #support what it did', kind: 'capability', name: 'messages.post', grade: 'covered', reason: 'messages.post is a tool that cannot change anything outside the team.' },
  { id: 'mail', text: 'Watch the support mailbox', kind: 'connection', name: 'mailbox', grade: 'missing', reason: 'This team has no connection called "mailbox".' },
  { id: 'tone', text: 'Friendly but short', kind: 'other', grade: 'unclear', reason: 'The brief does not say enough to check this.' },
];

const QUESTIONS = (): SetupQuestion[] => [
  { id: 'q1', requirementId: 'mail', question: 'There is no mailbox connection in this team. What would you like to do?', options: ['Skip email, mention only', 'I will add the connection first'] },
  { id: 'q2', requirementId: 'tone', question: 'How long should its answers be?', options: ['A few lines', 'As long as needed'] },
];

const BOT_MD = (name: string): string =>
  `---\nschema: 1\nname: ${name}\nrole: Answers questions from the manuals.\nkind: agent\nruntime: hermes\nmodel:\n  aliases: [smart]\ntriggers:\n  - type: mention\ncapabilities:\n  native: [knowledge.search, messages.post]\nknowledge:\n  - base: manuals\n    answer_only_from: true\n---\n\nYou answer from the manuals. If they do not say, say so and ask a person.\n`;

const diffOf = (path: string, text: string): string => {
  const lines = text.replace(/\n$/, '').split('\n');
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
};

type Held = { session: SetupSession; reads: number; stage: 'first' | 'second' | 'done'; retried: boolean; tries: number };
type FiledProposal = { id: string; teamSlug: string; path: string; title: string; status: 'open' | 'applied' | 'rejected' | 'withdrawn'; diff: string; added: number };

export function installSetupMock(on: On, hooks: SetupMockHooks): void {
  const sessions = new Map<string, Held>();
  const proposals = new Map<string, FiledProposal>();
  let counter = 0;

  const held = (sessionId: string | undefined): Held => {
    const h = sessionId ? sessions.get(sessionId) : undefined;
    if (!h) hooks.fail(404, 'not_found', 'No such setup conversation');
    return h as Held;
  };
  const view = (h: Held): unknown => SetupSessionResponse.parse({ session: h.session });

  const proposalBody = (p: FiledProposal) => {
    const may = hooks.canApprove(p.teamSlug);
    return ProposalResponse.parse({
      proposal: {
        proposal: {
          id: p.id,
          teamId: id('b', 1),
          path: p.path,
          op: 'put',
          title: p.title,
          note: 'Set up with the Add a bot helper. Nothing is applied until you approve.',
          status: p.status,
          authorId: id('c', 1),
          authorKind: 'person',
          authorName: 'Omar',
          baseBlobSha: null,
          baseCommitSha: 'a'.repeat(40),
          diff: p.diff,
          added: p.added,
          removed: 0,
          checks: [{ name: 'BOT.md loads', ok: true, message: '' }],
          createdAt: NOW,
          decidedAt: p.status === 'open' ? null : NOW,
          decidedByName: p.status === 'open' ? null : 'Omar',
          decisionNote: null,
          appliedCommitSha: p.status === 'applied' ? 'b'.repeat(40) : null,
          selfApplied: false,
        },
        stale: false,
        staleReason: null,
        canApply: p.status === 'open' && may,
        cannotApplyReason: p.status === 'open' && !may ? 'Only a workspace admin can add a bot. It waits in Proposals.' : null,
        // the helper files the proposal in the asker's name: the author takes it back (withdraw) and cannot reject their own
        canReject: false,
        canWithdraw: p.status === 'open',
      },
    });
  };

  on(createSetupSessionRoute, ({ params, body }) => {
    const slug = params['slug'] as string;
    const brief = String(body['brief'] ?? '');
    if (brief.trim().length < 8) hooks.fail(400, 'validation_failed', 'Write a sentence or two about what the bot should do.');
    counter += 1;
    const session: SetupSession = SetupSessionResponse.parse({
      session: {
        id: id('9', counter), teamId: id('b', 1), status: 'working', brief, name: typeof body['name'] === 'string' ? body['name'] : null,
        requirements: [], questions: [], answers: [], inventory: null, proposals: [], limits: [], message: null, rounds: 0, createdAt: NOW, updatedAt: NOW,
      },
    }).session;
    sessions.set(session.id, { session, reads: 0, stage: 'first', retried: false, tries: 0 });
    void slug;
    return created({ session });
  });

  on(getSetupSessionRoute, ({ params }) => {
    const h = held(params['sessionId']);
    const slug = params['slug'] as string;
    if (h.session.status === 'working') {
      h.reads += 1;
      if (/fail/i.test(h.session.brief) && (!h.retried || /always/i.test(h.session.brief)) && h.reads >= 2) {
        h.session = { ...h.session, status: 'failed', message: 'The model did not answer. Try again in a minute.' };
      } else if (h.stage === 'first') {
        h.session = { ...h.session, inventory: INVENTORY(slug, hooks.teamName(slug)) };
        if (h.reads >= 2) {
          h.session = { ...h.session, status: 'asking', requirements: REQUIREMENTS(), questions: QUESTIONS(), rounds: 1, message: 'I read your brief as four needs. Two need a decision from you.' };
          h.stage = 'second';
          h.reads = 0;
        }
      } else if (h.stage === 'second' && h.reads >= 2) {
        const name = h.session.name ?? 'Manual helper';
        const botSlug = slugOf(name);
        const path = `bots/${botSlug}/BOT.md`;
        counter += 1;
        const text = BOT_MD(name);
        const filed: FiledProposal = { id: id('d', counter), teamSlug: slug, path, title: `Add the bot ${name}`, status: 'open', diff: diffOf(path, text), added: text.split('\n').length - 1 };
        proposals.set(filed.id, filed);
        h.session = {
          ...h.session,
          status: 'proposed',
          name,
          proposals: [{ proposalId: filed.id as SetupSession['proposals'][number]['proposalId'], path, role: 'bot', title: filed.title }],
          // a gap the person answered reads as decided, in their words; the rest stays "not settled"
          limits: REQUIREMENTS()
            .filter((r) => r.grade === 'missing' || r.grade === 'unclear')
            .map((r) => {
              const a = h.session.answers.find((x) => x.requirementId === r.id);
              return a ? `You decided: ${a.answer} (${r.text})` : r.grade === 'missing' ? 'Not available yet: needs the mailbox connection, so it answers when mentioned and does not watch email.' : `Not settled: ${r.text}`;
            }),
          message: 'A bot that answers from the manuals when it is mentioned.',
          questions: [],
        };
        h.stage = 'done';
      }
    }
    return view(h);
  });

  on(answerSetupRoute, ({ params, body }) => {
    const h = held(params['sessionId']);
    if (h.session.status !== 'asking') hooks.fail(409, 'conflict', 'This conversation is not waiting for answers');
    const given = new Map((body['answers'] as Array<{ questionId: string; text: string }>).map((a) => [a.questionId, a.text]));
    const missing = h.session.questions.filter((q) => !given.has(q.id));
    if (missing.length > 0) hooks.fail(400, 'validation_failed', `answers: answer every question (missing ${missing.map((q) => q.id).join(', ')})`);
    h.session = {
      ...h.session,
      status: 'working',
      answers: [...h.session.answers, ...h.session.questions.map((q) => ({ questionId: q.id, requirementId: q.requirementId, question: q.question, answer: given.get(q.id) as string }))],
      questions: [],
    };
    h.reads = 0;
    return view(h);
  });

  // Try again: a failed conversation runs its last round again (the scripted failure happens once); the answers already given stay
  on(retrySetupRoute, ({ params }) => {
    const h = held(params['sessionId']);
    if (h.session.status !== 'failed') hooks.fail(409, 'conflict', 'Only a conversation that did not finish can be tried again');
    // the same limit as the server: three tries per conversation
    if (h.tries >= 3) hooks.fail(409, 'conflict', 'This conversation has been tried again 3 times and keeps stopping. Start a new one.');
    h.tries += 1;
    h.session = { ...h.session, status: 'working', message: null };
    h.retried = true;
    h.reads = 0;
    return view(h);
  });

  on(cancelSetupRoute, ({ params }) => {
    const h = held(params['sessionId']);
    if (h.session.status === 'working' || h.session.status === 'asking') h.session = { ...h.session, status: 'cancelled', questions: [] };
    return view(h);
  });

  const filedOf = (proposalId: string | undefined): FiledProposal => {
    const p = proposalId ? proposals.get(proposalId) : undefined;
    if (!p) hooks.fail(404, 'not_found', 'No such proposal');
    return p as FiledProposal;
  };
  on(getProposalRoute, ({ params }) => proposalBody(filedOf(params['proposalId'])));
  on(approveProposalRoute, ({ params }) => {
    const p = filedOf(params['proposalId']);
    if (!hooks.canApprove(p.teamSlug)) hooks.fail(403, 'forbidden', 'Only a workspace admin can add a bot.');
    p.status = 'applied';
    return proposalBody(p);
  });
  on(rejectProposalRoute, ({ params }) => {
    const p = filedOf(params['proposalId']);
    if (!hooks.canApprove(p.teamSlug)) hooks.fail(403, 'forbidden', 'Only a team lead or a workspace admin can decline a proposal.');
    p.status = 'rejected';
    return proposalBody(p);
  });
  on(withdrawProposalRoute, ({ params }) => {
    const p = filedOf(params['proposalId']);
    if (p.status !== 'open') hooks.fail(409, 'conflict', 'This proposal is no longer open');
    p.status = 'withdrawn';
    return proposalBody(p);
  });
}

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'new-bot';
