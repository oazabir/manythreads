import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { alertMailEnabled, alertsEnabled, recoverRoundsFrom, thresholdsFrom } from './config.ts';
import { checkLabel, describeTransition, evaluate, type Transition } from './evaluate.ts';
import { HEALTH_STATE_KEY, parseState, type Monitor } from './monitor.ts';

// The built-in health watcher. Once a minute (a cron job, so only one server process runs a round) it takes the numbers, judges each check
// against its limit and remembers the verdict per workspace. A check that trips writes one `ops.health.changed` event and queues one mail to
// the workspace's owners and admins; it writes one more, "back to normal", only after several quiet rounds in a row. The mail goes out in a job of
// its own, so a slow mail server never holds the watcher's transaction.

export const TICK_QUEUE = 'ops-health.tick';
export const MAIL_QUEUE = 'ops-health.mail';

/**
 * What the mail job is told. Numbers only: the job writes the words itself from the check's name, and sends only a change the watcher
 * really stored (see `sendAlertMail`), because anything able to enqueue a job could otherwise put its own text into a mail from this server.
 */
export interface MailPayload {
  workspaceId: string;
  check: string;
  state: 'breached' | 'recovered';
  value: number;
  threshold: number;
  unit: 'percent' | 'seconds';
  since: string;
}

/** One round: all workspaces, the verdict stored, the changes announced. Returns how many changes were announced. */
export async function tickHealth(ctx: PluginContext, tx: PluginTx, monitor: Monitor, env: NodeJS.ProcessEnv): Promise<number> {
  if (!alertsEnabled(env)) return 0;
  const { snapshot } = await monitor.measure();
  const thresholds = thresholdsFrom(env);
  const rounds = recoverRoundsFrom(env);
  const now = ctx.runtime.now();
  const sendMail = alertMailEnabled(env);
  const workspaces = (await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY id')).rows;
  let announced = 0;
  for (const w of workspaces) {
    const scope = { type: 'workspace' as const, id: w.id };
    const prev = parseState(await ctx.storage.get(scope, HEALTH_STATE_KEY));
    const result = evaluate(snapshot, thresholds, prev, now, rounds);
    for (const t of result.transitions) {
      await announce(ctx, tx, w.id, t, now, sendMail);
      announced += 1;
    }
    await ctx.storage.set(scope, HEALTH_STATE_KEY, result.next);
  }
  return announced;
}

async function announce(ctx: PluginContext, tx: PluginTx, workspaceId: string, t: Transition, now: Date, sendMail: boolean): Promise<void> {
  await ctx.audit.emit(tx, {
    type: 'ops.health.changed',
    workspaceId,
    check: t.check,
    state: t.state,
    value: t.value,
    threshold: t.threshold,
    unit: t.unit,
    since: t.since,
    changedAt: now.toISOString(),
  });
  if (!sendMail) return;
  const payload: MailPayload = { workspaceId, check: t.check, state: t.state, value: t.value, threshold: t.threshold, unit: t.unit, since: t.since };
  // The key makes a repeated round (a retry after a crash) queue the same mail once while it is still waiting.
  await ctx.jobs.enqueue(tx, MAIL_QUEUE, { ...payload }, { dedupeKey: `${workspaceId}:${t.check}:${t.state}:${t.since}` });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isMailPayload = (p: Record<string, unknown>): p is Record<string, unknown> & MailPayload =>
  typeof p['workspaceId'] === 'string' &&
  UUID.test(p['workspaceId']) &&
  typeof p['check'] === 'string' &&
  (p['state'] === 'breached' || p['state'] === 'recovered') &&
  typeof p['value'] === 'number' &&
  Number.isFinite(p['value']) &&
  typeof p['threshold'] === 'number' &&
  Number.isFinite(p['threshold']) &&
  (p['unit'] === 'percent' || p['unit'] === 'seconds') &&
  typeof p['since'] === 'string';

/**
 * Mails one change to the workspace's owners and admins. A recipient whose mail fails is logged and skipped; the job fails (and is tried again,
 * a few times) only when no recipient could be reached.
 */
export async function sendAlertMail(
  ctx: PluginContext,
  payload: Record<string, unknown>,
  job: { log: { info(m: string): void; warn(m: string): void }; transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> },
): Promise<void> {
  if (!isMailPayload(payload)) {
    job.log.warn('ops-health: a mail job with a payload it cannot read was dropped');
    return;
  }
  // The payload is whatever was enqueued, by anyone who could enqueue. Mail only a change the watcher itself stored for this workspace: a
  // known check whose remembered state agrees with the payload. The words come from the check's name, never from the payload.
  const label = checkLabel(payload.check);
  const stored = parseState(await ctx.storage.get({ type: 'workspace', id: payload.workspaceId }, HEALTH_STATE_KEY))[payload.check];
  if (label === null || stored === undefined || stored.breached !== (payload.state === 'breached')) {
    job.log.warn('ops-health: a mail job that does not match a stored health change was dropped');
    return;
  }
  const text = describeTransition({ check: payload.check, label, state: payload.state, value: payload.value, threshold: payload.threshold, unit: payload.unit, since: payload.since });
  const { admins, workspaceName } = await job.transaction(async (tx) => {
    const rows = await tx.query<{ email: string }>(
      `SELECT p.primary_email AS email
         FROM app.workspace_members m JOIN app.people p ON p.id = m.person_id
        WHERE m.workspace_id = $1::uuid AND m.role IN ('owner', 'admin') AND p.status = 'active'
        ORDER BY p.primary_email`,
      [payload.workspaceId],
    );
    const ws = await tx.query<{ name: string }>('SELECT name FROM app.workspaces WHERE id = $1::uuid', [payload.workspaceId]);
    return { admins: rows.rows.map((r) => r.email), workspaceName: ws.rows[0]?.name ?? 'your workspace' };
  });
  if (admins.length === 0) {
    job.log.warn('ops-health: no workspace admin has an address to mail');
    return;
  }
  let sent = 0;
  for (const to of admins) {
    try {
      await ctx.mail.send({
        template: 'ops_alert',
        to,
        workspaceName,
        state: payload.state,
        title: text.title,
        detail: text.detail,
        url: `${ctx.runtime.publicUrl}/settings/workspace/health`,
      });
      sent += 1;
    } catch {
      job.log.warn('ops-health: a health mail could not be delivered to one admin');
    }
  }
  if (sent === 0) throw new Error('ops-health: no health mail could be delivered');
  job.log.info(`ops-health: ${payload.check} ${payload.state} mailed to ${sent} admin(s)`);
}
