import { randomUUID } from 'node:crypto';
import {
  NotASandboxError,
  conflict,
  forbidden,
  type HttpCaller,
  type McpToolsProvider,
  type PluginContext,
  type PluginSocket,
  type PluginTx,
} from '@manythreads/sdk';
import { TERMINAL_LIMITS, placementOfRun, type TerminalEndReason, type TerminalRecording, type TerminalSession } from '@manythreads/shared';
import { limitsOf, pickIds, readTerminalConfig, type TerminalConfig } from './config.ts';
import { LiveTerminal, type TerminalEnd, type TerminalSink } from './live.ts';
import { pythonPty, type PtyStarter } from './pty.ts';
import { Recorder, type Redact } from './recorder.ts';
import { makeScratch, sweepStale } from './scratch.ts';

// Everything about terminals that is not an HTTP route (PLAN P7-09): is the terminal available on this machine, the one-terminal-per-admin rule, the database record, the sandbox behind it,
// and the registry of shells that are running right now.

type Row = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  bot_id: string | null;
  bot_slug: string;
  status: 'waiting' | 'open' | 'ended';
  admin_id: string;
  admin_name: string | null;
  run_id: string | null;
  sandbox_kind: 'rehearsal';
  started_at: Date | null;
  ended_at: Date | null;
  end_reason: TerminalEndReason | null;
  created_at: Date;
  bytes_in: string | number;
  bytes_out: string | number;
  credentials_revoked: number;
  transcript: string;
  transcript_truncated: boolean;
};

const COLUMNS = `t.id, t.workspace_id, t.team_id, t.bot_id, t.bot_slug, t.status, t.admin_id, p.display_name AS admin_name, t.run_id, t.sandbox_kind, t.started_at, t.ended_at, t.end_reason,
  t.created_at, t.bytes_in, t.bytes_out, t.credentials_revoked, t.transcript, t.transcript_truncated`;
const FROM = 'FROM app.terminal_sessions t LEFT JOIN app.actors a ON a.id = t.admin_id LEFT JOIN app.people p ON p.id = a.ref_id';

export type TerminalAvailability = { available: boolean; reason: string | null };

type Entry = { live: LiveTerminal; workspaceId: string; adminActorId: string; recorder: Recorder };

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export class TerminalService {
  private readonly lives = new Map<string, Entry>();
  /** Terminals being connected right now (claimed, shell not yet registered in `lives`): the sweep must not take them for lost ones. */
  private readonly claiming = new Set<string>();
  /** User numbers in use by running shells, so two terminals never share one. */
  private readonly usedIds = new Set<number>();
  private probed: { key: string; at: number; result: TerminalAvailability } | undefined;
  private swept = false;

  constructor(
    private readonly ctx: PluginContext,
    private readonly starter: PtyStarter = pythonPty,
  ) {}

  config(): TerminalConfig {
    return readTerminalConfig();
  }

  /** How many shells are running in this server process. */
  get running(): number {
    return this.lives.size;
  }

  // ---- availability -------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Whether a terminal can be opened on this machine now: switched on, and a real (very short) shell can be built the way the configuration asks. The answer is remembered for a minute.
   * It is never "available" on a guess: the sandbox is built for real and the shell ends at once.
   */
  async availability(workspaceId: string): Promise<TerminalAvailability> {
    const config = this.config();
    if (!config.enabled) {
      return { available: false, reason: 'The terminal is switched off on this server. An operator switches it on with MANYTHREADS_TERMINAL_ENABLED=1 (docs/plugins/workshop.md says what it needs).' };
    }
    // The record must be checked for secrets before it is stored, so a terminal does not open without the data-loss guard (the rest of the Workshop does not need it). Asked every time: the guard can be switched off.
    try {
      await this.redactor(workspaceId)('probe\n');
    } catch {
      return { available: false, reason: 'The terminal is not available: the data-loss guard that checks its record for secrets is not loaded on this server.' };
    }
    const key = `${config.isolation}|${String(config.uid)}|${String(config.gid)}|${config.root}`;
    if (this.probed && this.probed.key === key && Date.now() - this.probed.at < 60_000) return this.probed.result;
    const result = await this.probe(config);
    this.probed = { key, at: Date.now(), result };
    return result;
  }

  private async probe(config: TerminalConfig): Promise<TerminalAvailability> {
    const id = randomUUID();
    let scratch: Awaited<ReturnType<typeof makeScratch>> | undefined;
    try {
      scratch = await makeScratch(config.root, id, { botSlug: 'probe', startedAt: new Date() }, { traversable: config.isolation === 'plain' });
      const ids = pickIds(config, this.usedIds);
      const pty = this.starter.start({ workDir: scratch.workDir, mode: config.isolation, uid: ids.uid, gid: ids.gid, cols: TERMINAL_LIMITS.cols.default, rows: TERMINAL_LIMITS.rows.default });
      const exit = await new Promise<{ fatal: string | null; code: number | null; timedOut: boolean }>((resolve) => {
        const timer = setTimeout(() => resolve({ fatal: null, code: null, timedOut: true }), 8000);
        pty.onExit((info) => {
          clearTimeout(timer);
          resolve({ fatal: info.fatal, code: info.code, timedOut: false });
        });
        pty.write('exit\n');
      });
      await pty.kill();
      if (exit.timedOut) return { available: false, reason: 'The test sandbox did not start in time on this machine.' };
      if (exit.fatal !== null) return { available: false, reason: unavailableWords(exit.fatal) };
      // the probe shell is told to exit: anything but a clean exit means the sandbox did not really work
      if (exit.code !== 0) return { available: false, reason: unavailableWords(`the test shell ended with ${exit.code === null ? 'a signal' : `code ${String(exit.code)}`}`) };
      return { available: true, reason: null };
    } catch (err) {
      return { available: false, reason: unavailableWords(err instanceof Error ? err.message : 'unknown') };
    } finally {
      await scratch?.remove();
    }
  }

  // ---- reading ------------------------------------------------------------------------------------------------------------------------------------------------------------------

  mapSession(row: Row): TerminalSession {
    return {
      id: row.id as TerminalSession['id'],
      botSlug: row.bot_slug,
      status: row.status,
      admin: { id: row.admin_id as TerminalSession['admin']['id'], name: row.admin_name ?? 'An admin' },
      sandbox: { kind: row.sandbox_kind, runId: row.run_id as TerminalSession['sandbox']['runId'] },
      startedAt: iso(row.started_at),
      endedAt: iso(row.ended_at),
      endReason: row.end_reason,
      createdAt: row.created_at.toISOString(),
      bytesIn: Number(row.bytes_in),
      bytesOut: Number(row.bytes_out),
      credentialsRevoked: row.credentials_revoked,
      limits: limitsOf(this.config()),
    };
  }

  mapRecording(row: Row): TerminalRecording {
    return { ...this.mapSession(row), transcript: row.transcript, transcriptTruncated: row.transcript_truncated };
  }

  async recent(tx: PluginTx, botId: string): Promise<TerminalSession[]> {
    const rows = (await tx.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE t.bot_id = $1::uuid ORDER BY t.created_at DESC LIMIT 20`, [botId])).rows;
    return rows.map((r) => this.mapSession(r));
  }

  async find(tx: PluginTx, botId: string, id: string): Promise<Row | undefined> {
    return (await tx.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE t.id = $1::uuid AND t.bot_id = $2::uuid`, [id, botId])).rows[0];
  }

  // ---- opening ------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Asks for a terminal: checks the machine, the one-per-admin rule and the sandbox, REVOKES the sandbox run's credentials, and records a `waiting` terminal that the page then connects its
   * socket to. The row only becomes connectable (`run_id` set) after the revocation was proved, so there is no path to a shell that skips it.
   */
  async request(caller: HttpCaller, target: { teamId: string; botId: string; botSlug: string }, runId: string | undefined): Promise<Row> {
    const { ctx } = this;
    const system = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => ctx.db.system(fn, { workspaceId: caller.workspaceId });
    await this.sweep(caller.workspaceId);
    // A refusal that does not depend on this machine comes first: a real run (or another bot's) is a 403 whether or not the terminal can run here.
    if (runId !== undefined) await this.requireSandboxRun(caller.workspaceId, target, runId);
    const state = await this.availability(caller.workspaceId);
    if (!state.available) throw conflict(state.reason ?? 'The terminal is not available on this server.');
    const busy = await system(async (tx) => (await tx.query('SELECT 1 FROM app.terminal_sessions WHERE admin_id = $1::uuid AND status IN (\'waiting\', \'open\')', [caller.actorId])).rows.length > 0);
    if (busy) throw conflict('You already have a terminal open. End it before opening another.');
    const mcp = ctx.providers.get<McpToolsProvider>('mcp.tools');
    if (!mcp) throw conflict('The test sandbox is not available: the tool gateway is not loaded.');
    let opened: Awaited<ReturnType<McpToolsProvider['openTerminalSandbox']>>;
    try {
      opened = await mcp.openTerminalSandbox({ workspaceId: caller.workspaceId, teamId: target.teamId, botId: target.botId, ...(runId ? { runId } : {}) });
    } catch (err) {
      // a real run, or a run of another bot or team: refused, and nothing is recorded as opened
      if (err instanceof NotASandboxError) throw forbidden(err.message);
      throw err;
    }
    try {
      const id = await system(async (tx) => {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id, run_id, credentials_revoked)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7) RETURNING id`,
          [caller.workspaceId, target.teamId, target.botId, target.botSlug, caller.actorId, opened.run.runId, opened.credentialsRevoked],
        );
        return inserted.rows[0]!.id;
      });
      const row = await system((tx) => this.find(tx, target.botId, id));
      return row!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('You already have a terminal open. End it before opening another.');
      throw err;
    }
  }

  /** Reads (changes nothing, revokes nothing) whether `runId` is a test run of this bot; the same answer `openTerminalSandbox` gives, so a refusal never depends on the machine. */
  private async requireSandboxRun(workspaceId: string, target: { teamId: string; botId: string }, runId: string): Promise<void> {
    const row = await this.ctx.db.system(
      async (tx) =>
        (
          await tx.query<{ rehearsal: boolean; trigger_type: string; bot_id: string; team_id: string; workspace_id: string }>(
            'SELECT rehearsal, trigger_type, bot_id, team_id, workspace_id FROM app.bot_runs WHERE id = $1::uuid',
            [runId],
          )
        ).rows[0],
      { workspaceId },
    );
    if (!row || row.bot_id !== target.botId || row.team_id !== target.teamId || row.workspace_id !== workspaceId) throw forbidden('There is no such test run for this bot');
    if (placementOfRun({ rehearsal: row.rehearsal, trigger: row.trigger_type }) !== 'sandbox') throw forbidden('That is a real run of the bot, not a test. A terminal is only for test sandboxes.');
  }

  // ---- connecting ---------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * The socket of a `waiting` terminal. The claim is one statement: it succeeds for the admin who asked, once, within the waiting time, and only if the credentials were revoked. Then the
   * shell starts in a fresh folder and the socket is wired to it. Nothing that fails here leaves a shell, a folder or a `waiting`/`open` row behind.
   */
  async connect(caller: HttpCaller, params: { terminalId: string; botSlug: string }, socket: PluginSocket): Promise<void> {
    // from before the claim to after the shell is registered, the sweep must see this terminal as in use (the row says `open` a moment before `lives` has it)
    this.claiming.add(params.terminalId);
    try {
      await this.connectClaimed(caller, params, socket);
    } finally {
      this.claiming.delete(params.terminalId);
    }
  }

  private async connectClaimed(caller: HttpCaller, params: { terminalId: string; botSlug: string }, socket: PluginSocket): Promise<void> {
    const { ctx } = this;
    const config = this.config();
    const system = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => ctx.db.system(fn, { workspaceId: caller.workspaceId });
    // frames can arrive before the shell is up: hold them, in order
    const early: Array<string | Uint8Array> = [];
    // read by the handlers below before the terminal exists, assigned once when it does
    // eslint-disable-next-line prefer-const
    let live: LiveTerminal | undefined;
    let gone = false;
    let signedOut = false;
    socket.on('message', (data) => {
      if (live) live.input(data);
      else if (early.length < 50) early.push(data);
    });
    // the platform closes the socket when the sign-in behind it ends: that is the reason on the record, not "the page closed" (this runs just before the close event)
    socket.on('sessionEnded', () => {
      gone = true;
      signedOut = true;
      if (live) void live.end('session_ended');
    });
    socket.on('close', () => {
      gone = true;
      if (live) void live.end('closed');
    });
    socket.on('error', () => undefined);

    const claimed = await system(async (tx) => {
      const res = await tx.query<Row & { team_id: string; bot_id: string }>(
        `UPDATE app.terminal_sessions SET status = 'open', started_at = now()
          WHERE id = $1::uuid AND workspace_id = $2::uuid AND admin_id = $3::uuid AND bot_slug = $4 AND status = 'waiting' AND run_id IS NOT NULL AND team_id IS NOT NULL AND bot_id IS NOT NULL
            AND created_at > now() - make_interval(secs => $5::float8)
          RETURNING id, workspace_id, team_id, bot_id, bot_slug, run_id, credentials_revoked`,
        [params.terminalId, caller.workspaceId, caller.actorId, params.botSlug, config.waitingMs / 1000],
      );
      const row = res.rows[0];
      if (!row) return undefined;
      await ctx.audit.emit(tx, {
        type: 'workshop.terminal.opened',
        workspaceId: row.workspace_id,
        teamId: row.team_id,
        botId: row.bot_id,
        sessionId: row.id,
        adminId: caller.actorId,
        runId: row.run_id,
        credentialsRevoked: row.credentials_revoked,
        at: ctx.runtime.now().toISOString(),
      });
      return row;
    });
    if (!claimed) {
      socket.close(1008, 'this terminal is not waiting for a connection');
      return;
    }
    const finishBroken = async (why: string): Promise<void> => {
      await this.persistEnd(claimed.id, caller.workspaceId, 'error', { bytesIn: 0, bytesOut: 0, startedAt: new Date(), endedAt: new Date() }, '', false);
      socket.close(1011, why);
    };
    if (gone) {
      await this.persistEnd(claimed.id, caller.workspaceId, signedOut ? 'session_ended' : 'closed', { bytesIn: 0, bytesOut: 0, startedAt: new Date(), endedAt: new Date() }, '', false);
      return;
    }
    let scratch: Awaited<ReturnType<typeof makeScratch>>;
    let pty: ReturnType<PtyStarter['start']>;
    try {
      scratch = await makeScratch(config.root, claimed.id, { botSlug: claimed.bot_slug, startedAt: new Date() }, { traversable: config.isolation === 'plain' });
    } catch {
      await finishBroken('the sandbox folder could not be made');
      return;
    }
    const ids = pickIds(config, this.usedIds);
    try {
      this.usedIds.add(ids.uid);
      pty = this.starter.start({ workDir: scratch.workDir, mode: config.isolation, uid: ids.uid, gid: ids.gid, cols: TERMINAL_LIMITS.cols.default, rows: TERMINAL_LIMITS.rows.default });
    } catch {
      this.usedIds.delete(ids.uid);
      await scratch.remove();
      await finishBroken('the shell could not be started');
      return;
    }
    const recorder = new Recorder(config.transcriptChars, this.redactor(caller.workspaceId));
    const sink: TerminalSink = {
      send: (frame) => {
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          // closed
        }
      },
      close: (code, reason) => socket.close(code, reason),
    };
    live = new LiveTerminal({
      config,
      limits: limitsOf(config),
      pty,
      sink,
      recorder,
      cleanup: () => scratch.remove(),
      credentialsRevoked: claimed.credentials_revoked,
      checkpoint: (state) => this.checkpoint(claimed.id, caller.workspaceId, state, recorder),
    });
    this.lives.set(claimed.id, { live, workspaceId: caller.workspaceId, adminActorId: caller.actorId, recorder });
    live.start();
    // the admin may lose the admin role while the shell is open, or the row may have been closed by someone else (another server process, a sweep): look again now and then
    const watch = setInterval(() => {
      void ctx.db
        .as(caller, async (tx) => {
          const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
          const status = (await tx.query<{ status: string }>('SELECT status FROM app.terminal_sessions WHERE id = $1::uuid', [claimed.id])).rows[0]?.status;
          return { role, status };
        })
        .then(({ role, status }) => {
          if (role !== 'owner' && role !== 'admin') void live?.end('session_ended');
          else if (status !== 'open') void live?.end('server_stop');
        })
        .catch(() => void live?.end('session_ended'));
    }, 10_000);
    watch.unref();
    void live.ended.then(async (end) => {
      clearInterval(watch);
      try {
        await this.persistEnd(claimed.id, caller.workspaceId, end.reason, end, recorder.text, recorder.truncated);
      } finally {
        this.lives.delete(claimed.id);
        this.usedIds.delete(ids.uid);
      }
    });
    for (const frame of early.splice(0)) live.input(frame);
    if (gone) void live.end(signedOut ? 'session_ended' : 'closed');
  }

  // ---- ending -------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** An admin pressed End. A running shell is killed and recorded; a terminal nobody connected to is closed; one the server lost (it restarted) is marked as lost. */
  async endByAdmin(workspaceId: string, row: Row): Promise<void> {
    const entry = this.lives.get(row.id);
    if (entry) {
      await entry.live.end('ended_by_admin');
      await entry.live.ended;
      // the record is written by the end handler; wait for it
      await this.settled(row.id);
      return;
    }
    if (row.status === 'ended') return;
    const now = new Date();
    await this.persistEnd(row.id, workspaceId, row.status === 'waiting' ? 'ended_by_admin' : 'server_stop', { bytesIn: Number(row.bytes_in), bytesOut: Number(row.bytes_out), startedAt: row.started_at ?? now, endedAt: now }, null, false);
  }

  private async settled(id: string): Promise<void> {
    for (let i = 0; i < 100 && this.lives.has(id); i += 1) await new Promise((r) => setTimeout(r, 20));
  }

  /** Shells this process is running for a workspace, for the tests and the status. */
  liveIds(): string[] {
    return [...this.lives.keys()];
  }

  /** Ends every shell (the plugin is stopping). */
  async endAll(): Promise<void> {
    await Promise.all([...this.lives.values()].map((e) => e.live.end('server_stop')));
  }

  /**
   * Housekeeping, done whenever a terminal is asked for (this assumes ONE server process runs the terminals: `lives` is this process's list, so a second process would close the first one's
   * open terminals as "lost". The terminal is documented as a single-process feature): terminals nobody connected to in time are closed; terminals recorded as open that this process does not have (it restarted: the shell
   * died with it) are closed as lost; folders an earlier process left are deleted.
   */
  async sweep(workspaceId: string): Promise<void> {
    const config = this.config();
    const live = new Set([...this.lives.keys(), ...this.claiming]);
    const stale = await this.ctx.db.system(
      async (tx) =>
        (
          await tx.query<Row>(
            `SELECT ${COLUMNS} ${FROM}
              WHERE t.workspace_id = $1::uuid AND (
                (t.status = 'waiting' AND t.created_at < now() - make_interval(secs => $2::float8))
                OR (t.status = 'open' AND NOT (t.id = ANY($3::uuid[]))))`,
            [workspaceId, config.waitingMs / 1000, [...live]],
          )
        ).rows,
      { workspaceId },
    );
    const now = new Date();
    for (const row of stale) {
      await this.persistEnd(row.id, workspaceId, row.status === 'waiting' ? 'unused' : 'server_stop', { bytesIn: Number(row.bytes_in), bytesOut: Number(row.bytes_out), startedAt: row.started_at ?? now, endedAt: now }, null, false);
    }
    if (!this.swept) {
      this.swept = true;
      await sweepStale(config.root, live).catch(() => 0);
    }
  }

  private async checkpoint(id: string, workspaceId: string, state: { bytesIn: number; bytesOut: number }, recorder: Recorder): Promise<void> {
    await this.ctx.db.system(
      async (tx) => {
        await tx.query(
          `UPDATE app.terminal_sessions SET bytes_in = $2, bytes_out = $3, transcript = $4, transcript_truncated = $5 WHERE id = $1::uuid AND status = 'open'`,
          [id, state.bytesIn, state.bytesOut, recorder.text, recorder.truncated],
        );
      },
      { workspaceId },
    );
  }

  /** Writes the end of a terminal and its audit event, once: only a row that is still `waiting` or `open` is changed. */
  private async persistEnd(id: string, workspaceId: string, reason: TerminalEndReason, end: Pick<TerminalEnd, 'bytesIn' | 'bytesOut' | 'startedAt' | 'endedAt'>, transcript: string | null, truncated: boolean): Promise<void> {
    const { ctx } = this;
    await ctx.db.system(
      async (tx) => {
        const res = await tx.query<{ team_id: string | null; bot_id: string | null; admin_id: string }>(
          `UPDATE app.terminal_sessions
              SET status = 'ended', end_reason = $2::text, ended_at = now(), bytes_in = $3::bigint, bytes_out = $4::bigint,
                  transcript = COALESCE($5::text, transcript), transcript_truncated = CASE WHEN $5::text IS NULL THEN transcript_truncated ELSE $6::boolean END
            WHERE id = $1::uuid AND status IN ('waiting', 'open')
            RETURNING team_id, bot_id, admin_id`,
          [id, reason, end.bytesIn, end.bytesOut, transcript, truncated],
        );
        const row = res.rows[0];
        // the team or the bot was deleted while the terminal was open: the record is kept (with its bot's name), but there is no team or bot left for the audit event to name
        if (!row || !row.team_id || !row.bot_id) return;
        await ctx.audit.emit(tx, {
          type: 'workshop.terminal.closed',
          workspaceId,
          teamId: row.team_id,
          botId: row.bot_id,
          sessionId: id,
          adminId: row.admin_id,
          reason,
          durationMs: Math.max(0, end.endedAt.getTime() - end.startedAt.getTime()),
          bytesIn: end.bytesIn,
          bytesOut: end.bytesOut,
          truncated,
          at: ctx.runtime.now().toISOString(),
        });
      },
      { workspaceId },
    );
  }

  // ---- the redaction ------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * The platform's `pre_egress` chain over the text before it is stored. It is a requirement that the data-loss guard ran: with no guard loaded, or one that refuses the text, nothing of it
   * is stored (the recorder writes a note instead).
   */
  redactor(workspaceId: string): Redact {
    return async (text) => {
      const decision = await this.ctx.db.system((tx) => this.ctx.hooks.runPreEgress(tx, { destination: 'terminal', workspaceId, text, preset: 'standard' }), { workspaceId });
      if (decision.hooks === 0 || !decision.ran.includes('guardrails-dlp') || decision.outcome === 'block' || decision.reason === 'error') throw new Error('not checked');
      return decision.text;
    };
  }
}

function unavailableWords(fatal: string): string {
  if (/root user/.test(fatal)) {
    return 'The terminal needs the server to run as the root user on Linux, so it can give the shell a sandbox of its own and drop to an unprivileged user. This server does not, so the terminal is not available.';
  }
  if (/python|could not be started|ENOENT/i.test(fatal)) return 'The terminal needs Python 3 on the server (it provides the shell\'s terminal), and it is not installed.';
  return `The test sandbox cannot be built on this machine (${fatal.slice(0, 200)}).`;
}
