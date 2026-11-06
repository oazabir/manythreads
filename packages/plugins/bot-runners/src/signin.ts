import { createHash, createHmac, randomBytes } from 'node:crypto';
import { conflict, HttpError, invalid, json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import type { ClaudePodsProvider } from '@manythreads/sdk';
import {
  BotRunnerPathParams,
  CheckClaudeSigninResponse,
  ClaudeRunnerUsageResponse,
  CREDENTIALS_SIGNINS_HEADER,
  CREDENTIALS_TERMS_HEADER,
  MAX_CREDENTIALS_BYTES,
  PutClaudeCredentialsResponse,
  RemoveClaudeCredentialsResponse,
  abuseLimit,
  checkClaudeSigninRoute,
  claudeRunnerUsageRoute,
  inspectClaudeCredentials,
  putClaudeCredentialsRoute,
  removeClaudeCredentialsRoute,
  type ClaudeSigninCheck,
} from '@manythreads/shared';
import { loadRunner, presentOne, requireWorkspaceAdmin } from './common.ts';

// The Claude Code runner's sign-in (PLAN P19-06, docs/plugins/claude-pods.md). An admin uploads `.credentials.json`; this file is the only place its bytes pass through.
// The body is read once into memory, looked at read-only, handed to the pod provider (which writes the Secret) and dropped. It is never logged, echoed, put in an event,
// a run or the database: the database gets only the plan label, the expiry, a SHA-256 of the bytes and a keyed hash of the refresh token (to refuse the same login twice).

const claudePods = (ctx: PluginContext): ClaudePodsProvider => {
  const p = ctx.providers.get<ClaudePodsProvider>('claude.pods');
  if (!p) throw conflict('Claude Code runners are not turned on in this install. An operator turns them on in the chart (claudePod.enabled).');
  return p;
};

/** The words of a check, for the admin page. One table: when the real CLI's texts are known, the matching changes in the bridge (signin.ts), not here. */
export const CHECK_MESSAGES: Record<ClaudeSigninCheck, string> = {
  ok: 'The sign-in works.',
  rejected: 'Claude refused this sign-in. Log in again and upload a new file.',
  expired: 'This sign-in has run out and could not be renewed. Log in again and upload a new file.',
  no_scope: 'This sign-in cannot run Claude Code. Log in again with the full Claude Code login and upload that file.',
  limit: "The Claude plan's limit has been reached for now. Runs wait until it resets.",
  unreachable: 'The runner did not answer. It may still be starting; try again in a minute.',
};

/** A keyed hash of the refresh token: the same login gives the same value, and the value says nothing about the token. Provisional until P19-01 (j) is measured with a real login. */
export function loginIdOf(workspaceId: string, refreshToken: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash('sha256').update(`manythreads-claude-login|${workspaceId}|${env['MANYTHREADS_LOGIN_ID_KEY'] ?? ''}`).digest();
  return createHmac('sha256', key).update(refreshToken).digest('hex');
}

/** Reads the request body up to the limit. Stops reading at once past it. */
async function readBody(stream: AsyncIterable<Uint8Array> | undefined): Promise<Buffer> {
  if (!stream) throw invalid('The body must be the sign-in file.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_CREDENTIALS_BYTES) throw new HttpError(413, 'validation_failed', 'That file is too large to be a Claude sign-in file.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function requireClaudeRunner(tx: PluginTx, id: string) {
  const runner = await loadRunner(tx, id, true);
  if (runner.kind !== 'claude_cli') throw invalid('A sign-in file belongs to a Claude Code runner only.');
  return runner;
}

export function registerSigninRoutes(ctx: PluginContext): void {
  const now = (): string => ctx.runtime.now().toISOString();

  ctx.http.route({
    method: putClaudeCredentialsRoute.method,
    path: putClaudeCredentialsRoute.path,
    rawBody: true,
    rateLimit: abuseLimit(putClaudeCredentialsRoute.method, putClaudeCredentialsRoute.path),
    schema: { response: PutClaudeCredentialsResponse },
    handler: route(async (req, tx) => {
      const { id } = BotRunnerPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const pods = claudePods(ctx);
      if (req.headers[CREDENTIALS_TERMS_HEADER] !== '1') throw invalid("Confirm that the Claude plan's terms allow sharing this runner.");
      if (req.headers[CREDENTIALS_SIGNINS_HEADER] !== '1') throw invalid('Confirm that the other sign-ins in the file may be stored as they are.');
      const bytes = await readBody(req.stream);
      const looked = inspectClaudeCredentials(bytes.toString('utf8'), ctx.runtime.now().getTime());
      if (!looked.ok) throw invalid(looked.message);
      const runner = await requireClaudeRunner(tx, id);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const loginId = loginIdOf(runner.workspace_id, looked.refreshToken);
      const other = (
        await tx.query<{ label: string }>('SELECT label FROM app.bot_runners WHERE workspace_id = $1::uuid AND id <> $2::uuid AND (login_id = $3 OR credentials_sha256 = $4) LIMIT 1', [runner.workspace_id, id, loginId, sha])
      ).rows[0];
      if (other) throw conflict(`This Claude login is already used by "${other.label}". A shared login can sign the other copy out, so every Claude runner needs its own sign-in file. Log in again and upload that one.`);
      const replaced = runner.uploaded_at !== null;
      const at = now();
      await tx.query(
        `UPDATE app.bot_runners
            SET owner_actor_id = $2::uuid, plan_label = $3, credentials_expires_at = $4::timestamptz, uploaded_at = now(), login_id = $5, credentials_sha256 = $6,
                terms_accepted_by = $2::uuid, terms_accepted_at = now(), signins_ack_by = $2::uuid, signins_ack_at = now(),
                status = 'starting', status_detail = 'Signed in. The pod is starting.', paused_until = NULL, last_checked_at = now(), updated_at = now()
          WHERE id = $1::uuid`,
        [id, tx.actor.id, looked.summary.planLabel, new Date(looked.summary.expiresAt).toISOString(), loginId, sha],
      );
      // Written last: if the cluster refuses, the request fails and the rows above roll back with it.
      try {
        await pods.putCredentials({ runnerName: runner.name, runnerId: id, bytes, uploadId: randomBytes(12).toString('hex') });
      } catch {
        throw conflict('The cluster did not take the sign-in file. Nothing was changed; try again in a moment.');
      }
      const base = { workspaceId: runner.workspace_id, runnerId: id, name: runner.name, actorId: tx.actor.id, at };
      await ctx.audit.emit(tx, { type: replaced ? 'claude_pod.credentials.replaced' : 'claude_pod.credentials.uploaded', ...base });
      await ctx.audit.emit(tx, { type: 'bot_runner.terms.accepted', workspaceId: runner.workspace_id, runnerId: id, name: runner.name, acceptedBy: tx.actor.id, at });
      return json(PutClaudeCredentialsResponse.parse({ runner: await presentOne(ctx, tx, id), replaced }));
    }),
  });

  ctx.http.route({
    method: removeClaudeCredentialsRoute.method,
    path: removeClaudeCredentialsRoute.path,
    rateLimit: abuseLimit(removeClaudeCredentialsRoute.method, removeClaudeCredentialsRoute.path),
    schema: { response: RemoveClaudeCredentialsResponse },
    handler: route(async (req, tx) => {
      const { id } = BotRunnerPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const pods = claudePods(ctx);
      const runner = await requireClaudeRunner(tx, id);
      await tx.query(
        `UPDATE app.bot_runners
            SET owner_actor_id = NULL, plan_label = NULL, credentials_expires_at = NULL, uploaded_at = NULL, login_id = NULL, credentials_sha256 = NULL,
                status = 'waiting_for_sign_in', status_detail = 'Waiting for a sign-in file. Upload one to start this runner.', paused_until = NULL, updated_at = now()
          WHERE id = $1::uuid`,
        [id],
      );
      try {
        await pods.removeCredentials({ runnerName: runner.name });
      } catch {
        throw conflict('The cluster did not remove the sign-in file. Nothing was changed; try again in a moment.');
      }
      await ctx.audit.emit(tx, { type: 'claude_pod.credentials.removed', workspaceId: runner.workspace_id, runnerId: id, name: runner.name, actorId: tx.actor.id, at: now() });
      return json(RemoveClaudeCredentialsResponse.parse({ runner: await presentOne(ctx, tx, id) }));
    }),
  });

  ctx.http.route({
    method: checkClaudeSigninRoute.method,
    path: checkClaudeSigninRoute.path,
    rateLimit: abuseLimit(checkClaudeSigninRoute.method, checkClaudeSigninRoute.path),
    schema: { response: CheckClaudeSigninResponse },
    handler: route(async (req, tx) => {
      const { id } = BotRunnerPathParams.parse(req.params);
      await requireWorkspaceAdmin(tx);
      const pods = claudePods(ctx);
      const runner = await requireClaudeRunner(tx, id);
      if (runner.uploaded_at === null) throw conflict('There is no sign-in file yet. Upload one first.');
      const result = await pods.checkSignin({ runnerName: runner.name });
      if (result === 'rejected' || result === 'expired' || result === 'no_scope') {
        await tx.query(`UPDATE app.bot_runners SET status = 'needs_sign_in', status_detail = $2, last_checked_at = now(), updated_at = now() WHERE id = $1::uuid`, [id, CHECK_MESSAGES[result]]);
      } else if (result === 'ok' && (runner.status === 'needs_sign_in' || runner.status === 'paused')) {
        await tx.query(`UPDATE app.bot_runners SET status = 'starting', status_detail = NULL, paused_until = NULL, last_checked_at = now(), updated_at = now() WHERE id = $1::uuid`, [id]);
      } else if (result !== 'unreachable') {
        await tx.query('UPDATE app.bot_runners SET last_checked_at = now() WHERE id = $1::uuid', [id]);
      }
      return json(CheckClaudeSigninResponse.parse({ result, message: CHECK_MESSAGES[result], runner: await presentOne(ctx, tx, id) }));
    }),
  });

  ctx.http.route({
    method: claudeRunnerUsageRoute.method,
    path: claudeRunnerUsageRoute.path,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { response: ClaudeRunnerUsageResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const rows = await tx.query<{ runner_id: string; team_id: string; team_name: string; day: string; runs: number; seconds: number; cli_cost: string }>(
        `SELECT u.runner_id, u.team_id, t.name AS team_name, to_char(u.day, 'YYYY-MM-DD') AS day, u.runs, u.seconds, u.cli_cost::text AS cli_cost
           FROM app.bot_runner_usage u JOIN app.teams t ON t.id = u.team_id
          WHERE u.day >= (current_date - 30) ORDER BY u.day DESC, t.name LIMIT 2000`,
      );
      return json(ClaudeRunnerUsageResponse.parse({ items: rows.rows.map((r) => ({ runnerId: r.runner_id, teamId: r.team_id, teamName: r.team_name, day: r.day, runs: r.runs, seconds: r.seconds, cliCost: Number(r.cli_cost) })) }));
    }),
  });
}
