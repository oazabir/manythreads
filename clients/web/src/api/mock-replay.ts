import {
  CloseReassessmentResponse,
  FullReplayEstimate,
  FullReplayResponse,
  ReassessmentListResponse,
  ReplayResponse,
  WORKSHOP_MAX_STEPS,
  closeReassessmentRoute,
  fullReplayRoute,
  listReassessmentsRoute,
  replayBotRoute,
  type Reassessment,
  type WorkshopMode,
  type WorkshopSession,
} from '@manythreads/shared';

/*
 * The mock of replay and re-assessment (P7-07): the same routes and shapes the server answers, over pretend run records. The free replay answers the same for every request; the full
 * replay shows its estimate first and starts a rehearsal only when the same number is sent back as the confirmation; a notice can be closed by a lead or an admin only. The words of
 * every refusal are the server's (packages/plugins/workshop/src/replay.ts and reassess.ts).
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;
type Reply = { status: number; body: unknown };

export type ReplayMockHooks = {
  /** The signed-in person leads this team or is a workspace admin. */
  canManage(slug: string): boolean;
  fail(status: number, code: 'not_found' | 'conflict' | 'validation_failed' | 'forbidden', message: string): never;
  /** Starts a conversation in the Workshop mock. */
  begin(slug: string, botSlug: string, mode: WorkshopMode, text?: string): WorkshopSession;
};

const NOW = '2026-10-01T14:02:00.000Z';
const uuid = (kind: string, n: number): string => `00000000-0000-7000-8000-0000000${kind}${String(n).padStart(4, '0')}`;
const RUN_WITH_MESSAGE = uuid('c', 1);
const RUN_OTHER = uuid('c', 2);

const counts = (same: number, tighter: number, looser: number, notReplayed: number) => ({ total: same + tighter + looser + notReplayed, same, tighter, looser, notReplayed });

/** What the real server derives from the run, the person and the number; the mock keeps one fixed value so the screen has to send back the one it was shown. */
const MOCK_CONFIRM_TOKEN = 'a1b2c3d4e5f60718';

const estimate = (runId: string) =>
  FullReplayEstimate.parse({
    runId,
    calls: 3,
    promptTokens: 1500,
    completionTokens: 340,
    tokens: 1840,
    costUsd: 0.0124,
    priceKnown: true,
    maxCalls: WORKSHOP_MAX_STEPS,
    basis: `Counted from the 3 model calls the original run made. A replay stops after ${String(WORKSHOP_MAX_STEPS)} model calls.`,
    confirmToken: MOCK_CONFIRM_TOKEN,
  });

export function installReplayMock(on: On, hooks: ReplayMockHooks): void {
  const notices: Reassessment[] = [
    {
      id: uuid('d', 1) as Reassessment['id'],
      teamId: uuid('b', 1) as Reassessment['teamId'],
      botSlug: 'support-bot',
      reason: 'eval_dropped',
      subject: '',
      headline: 'The bot’s test score dropped from 90% to 70%.',
      checks: ['Open the latest test run and read which cases failed.', 'Look at what changed since the last good run: the bot’s settings, its lessons, a knowledge base or the runner.', 'Rehearse a failing case in the Workshop and correct the reply.'],
      status: 'open',
      createdAt: NOW as Reassessment['createdAt'],
      closedAt: null,
    },
    {
      id: uuid('d', 2) as Reassessment['id'],
      teamId: uuid('b', 1) as Reassessment['teamId'],
      botSlug: 'support-bot',
      reason: 'runner_changed',
      subject: 'office-box',
      headline: 'The runner “office-box”, which this bot runs on, was changed.',
      checks: ['Send the bot a test message and see that it answers.', 'Compare a few answers with earlier ones: a changed model can answer differently.', 'Run the bot’s tests again.'],
      status: 'open',
      createdAt: NOW as Reassessment['createdAt'],
      closedAt: null,
    },
  ];

  on(replayBotRoute, ({ params, query }) => {
    const days = Number(query.get('days') ?? 30);
    const lead = hooks.canManage(params['slug'] as string);
    return ReplayResponse.parse({
      replay: {
        days,
        since: '2026-09-01T14:02:00.000Z',
        model: 'none',
        runs: lead ? 12 : 3,
        runsCapped: false,
        counts: lead ? counts(36, 2, 1, 3) : counts(8, 1, 0, 1),
        byKind: lead
          ? { gate: counts(12, 1, 0, 2), guard: counts(14, 1, 1, 1), tool: counts(10, 0, 0, 0) }
          : { gate: counts(3, 0, 0, 1), guard: counts(3, 1, 0, 0), tool: counts(2, 0, 0, 0) },
        changes: [
          {
            runId: RUN_WITH_MESSAGE, at: NOW, kind: 'gate', what: 'the bot’s topic list', recorded: 'allowed', now: 'waits_for_person', verdict: 'tighter',
            explanation: 'Today’s topic list would hold this message for a person. It went through when the bot ran.',
          },
          {
            runId: RUN_OTHER, at: '2026-09-28T09:00:00.000Z', kind: 'guard', what: 'the data check before a call to the smart model', recorded: 'redacted', now: 'refused', verdict: 'tighter',
            explanation: 'The workspace now refuses a call that carries a detected secret instead of hiding it, so this call would be stopped.',
          },
          ...(lead
            ? [
                {
                  runId: RUN_OTHER, at: '2026-09-27T09:00:00.000Z', kind: 'guard' as const, what: 'the data check before a call to the fast model', recorded: 'refused' as const, now: 'allowed' as const, verdict: 'looser' as const,
                  explanation: 'The workspace was air-gapped then and is not now, so a call to the fast model would no longer be stopped for that reason.',
                },
                {
                  runId: RUN_OTHER, at: '2026-09-26T09:00:00.000Z', kind: 'gate' as const, what: 'the bot’s topic list', recorded: 'waits_for_person' as const, now: null, verdict: 'not_replayed' as const,
                  explanation: 'The bot’s local model made this call on the topics, and a free replay cannot ask it again. Nothing in today’s word list matches.',
                },
              ]
            : []),
        ],
        changesCapped: false,
        decisionsCapped: false,
        notes: [
          'Nothing was sent to a model and nothing was done: this only asks today’s rules the same questions.',
          'The bot’s local model is not asked again, so a message it held for a person stays as it was.',
          'What the data check found in a call is not kept (it would be the secret itself), so it is judged by the workspace’s guard setting only.',
          'Messages are read as they are now, with your own access: one you cannot read, or that was edited or deleted, is listed as not replayed.',
        ],
        fullReplayable: lead ? [{ runId: RUN_WITH_MESSAGE, at: NOW, trigger: 'conversation', hasMessage: true }] : [],
      },
    });
  });

  on(fullReplayRoute, ({ params, body }): Reply => {
    if (!hooks.canManage(params['slug'] as string)) hooks.fail(403, 'forbidden', 'Only a team lead or an admin can replay a run in full');
    const runId = params['runId'] as string;
    if (runId !== RUN_WITH_MESSAGE) hooks.fail(409, 'conflict', 'This run did not keep the message it read, so it cannot be asked again. Only runs made after replay was added can.');
    const est = estimate(runId);
    const confirm = body['confirm'] as { tokens: number; token: string } | undefined;
    if (!confirm) return { status: 200, body: FullReplayResponse.parse({ status: 'needs_confirmation', estimate: est }) };
    if (confirm.tokens !== est.tokens || confirm.token !== est.confirmToken) hooks.fail(409, 'conflict', 'The estimate changed since you looked at it, or it was not the one you were shown. Read it again before you confirm.');
    const session = hooks.begin(params['slug'] as string, params['botSlug'] as string, 'rehearse', 'Can you share the credential rotation steps?');
    return { status: 201, body: FullReplayResponse.parse({ status: 'started', estimate: est, session }) };
  });

  on(listReassessmentsRoute, () => ReassessmentListResponse.parse({ reassessments: notices.filter((n) => n.status === 'open') }));

  on(closeReassessmentRoute, ({ params, body }) => {
    if (!hooks.canManage(params['slug'] as string)) hooks.fail(403, 'forbidden', 'Only a team lead or an admin can close this notice');
    const n = notices.find((x) => x.id === params['reassessmentId'] && x.status === 'open');
    if (!n) hooks.fail(404, 'not_found', 'No such open notice');
    const closed: Reassessment = { ...(n as Reassessment), status: body['answer'] === 'done' ? 'done' : 'dismissed', closedAt: NOW as Reassessment['closedAt'] };
    notices.splice(notices.indexOf(n as Reassessment), 1, closed);
    return CloseReassessmentResponse.parse({ reassessment: closed });
  });
}
