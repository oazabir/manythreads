import {
  TERMINAL_LIMITS,
  TerminalRecordingResponse,
  TerminalSession,
  TerminalSessionResponse,
  TerminalStatusResponse,
  endTerminalRoute,
  getTerminalRoute,
  openTerminalRoute,
  terminalStatusRoute,
  type TerminalRecording,
} from '@manythreads/shared';

/*
 * The mock of the Terminal view (P7-09): the same routes and shapes the server answers. Only a workspace admin may use it, like the real thing; anyone else gets the same plain refusal.
 * One terminal per admin; the shell itself is the scripted one in `screens/workshop/terminal/mock-transport.ts`.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;
type Reply = { status: number; body: unknown };

export type TerminalMockHooks = {
  /** The signed-in person is a workspace owner or admin. */
  isAdmin(): boolean;
  adminName(): string;
  adminId(): string;
  fail(status: number, code: 'not_found' | 'conflict' | 'forbidden', message: string): never;
};

const limits = {
  idleSeconds: TERMINAL_LIMITS.idleSeconds,
  maxSeconds: TERMINAL_LIMITS.maxSeconds,
  outputBytesPerSecond: TERMINAL_LIMITS.outputBytesPerSecond,
  outputBytesTotal: TERMINAL_LIMITS.outputBytesTotal,
  inputBytesTotal: TERMINAL_LIMITS.inputBytesTotal,
  transcriptChars: TERMINAL_LIMITS.transcriptChars,
};

const uuid = (n: number): string => `00000000-0000-7000-8000-00000000f${String(n).padStart(3, '0')}`;

export function installTerminalMock(on: On, hooks: TerminalMockHooks): void {
  const sessions = new Map<string, TerminalRecording>();
  let counter = 0;
  const admin = (): void => {
    if (!hooks.isAdmin()) hooks.fail(403, 'forbidden', 'Only a workspace admin can use a terminal');
  };
  const find = (id: string | undefined): TerminalRecording => {
    const s = id ? sessions.get(id) : undefined;
    if (!s) hooks.fail(404, 'not_found', 'There is no such terminal');
    return s as TerminalRecording;
  };

  on(terminalStatusRoute, ({ params }) => {
    admin();
    const mine = [...sessions.values()].filter((s) => s.botSlug === params['botSlug']);
    return TerminalStatusResponse.parse({ available: true, reason: null, limits, sessions: mine.reverse().map((s) => TerminalSession.parse(s)) });
  });

  on(openTerminalRoute, ({ params }): Reply => {
    admin();
    if ([...sessions.values()].some((s) => s.status !== 'ended')) hooks.fail(409, 'conflict', 'You already have a terminal open. Close it before opening another.');
    counter += 1;
    const now = new Date().toISOString();
    const session: TerminalRecording = {
      id: uuid(counter) as TerminalRecording['id'],
      botSlug: params['botSlug'] as string,
      status: 'open',
      admin: { id: hooks.adminId() as TerminalRecording['admin']['id'], name: hooks.adminName() },
      sandbox: { kind: 'rehearsal', runId: null },
      startedAt: now,
      endedAt: null,
      endReason: null,
      createdAt: now,
      bytesIn: 0,
      bytesOut: 0,
      credentialsRevoked: 2,
      limits,
      transcript: '',
      transcriptTruncated: false,
    };
    sessions.set(session.id, session);
    return { status: 201, body: TerminalSessionResponse.parse({ session: { ...session } }) };
  });

  on(getTerminalRoute, ({ params }) => {
    admin();
    return TerminalRecordingResponse.parse({ session: find(params['terminalId']) });
  });

  on(endTerminalRoute, ({ params }) => {
    admin();
    const s = find(params['terminalId']);
    if (s.status !== 'ended') {
      s.status = 'ended';
      s.endedAt = new Date().toISOString();
      s.endReason = 'ended_by_admin';
      s.transcript = 'nobody@sandbox:/work$ ';
    }
    return TerminalSessionResponse.parse({ session: { ...s } });
  });
}
