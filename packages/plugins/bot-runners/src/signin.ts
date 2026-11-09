import { createHash, createHmac, randomBytes } from 'node:crypto';
import { conflict, HttpError, invalid, json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import type { ClaudePodsProvider } from '@manythreads/sdk';
import {
  BotRunnerPathParams,
  CheckClaudeSigninResponse,
  ClaudeRunnerUsageResponse,
  CODEX_PLAN_LABEL_HEADER,
  CREDENTIALS_SIGNINS_HEADER,
  CREDENTIALS_TERMS_HEADER,
  MAX_CREDENTIALS_BYTES,
  PutClaudeCredentialsResponse,
  RemoveClaudeCredentialsResponse,
  abuseLimit,
  checkClaudeSigninRoute,
  claudeRunnerUsageRoute,
  codexPlanLabelFrom,
  inspectClaudeCredentials,
  inspectCodexCredentials,
  putClaudeCredentialsRoute,
  removeClaudeCredentialsRoute,
  type ClaudeSigninCheck,
} from '@manythreads/shared';
import { agentOfKind, isPodCli, loadRunner, presentOne, requireWorkspaceAdmin, type PodCliKind } from './common.ts';

// The Claude Code and Codex runners' sign-in (PLAN P19-06 and P19-13, docs/plugins/claude-pods.md). An admin uploads `.credentials.json` (Claude) or `auth.json` (Codex); this file is the only place its bytes pass through.
// The body is read once into memory, looked at read-only, handed to the pod provider (which writes the Secret) and dropped. It is never logged, echoed, put in an event,
// a run or the database: the database gets only the plan label, the expiry, a SHA-256 of the bytes and a keyed hash of the refresh token (to refuse the same login twice).

/** The words that differ between the two kinds. One table, so the Codex sentences cannot drift from the Claude ones. */
const WORDS = {
  claude_cli: {
    notOn: 'Claude Code runners are not turned on in this install. An operator turns them on in the chart (claudePod.enabled).',
    terms: "Confirm that the Claude plan's terms allow sharing this runner.",
    tooLarge: 'That file is too large to be a Claude sign-in file.',
    sameLogin: (label: string) => `This Claude login is already used by "${label}". A shared login can sign the other copy out, so every Claude runner needs its own sign-in file. Log in again and upload that one.`,
    check: {
      ok: 'The sign-in works.',
      rejected: 'Claude refused this sign-in. Log in again and upload a new file.',
      expired: 'This sign-in has run out and could not be renewed. Log in again and upload a new file.',
      no_scope: 'This sign-in cannot run Claude Code. Log in again with the full Claude Code login and upload that file.',
      limit: "The Claude plan's limit has been reached for now. Runs wait until it resets.",
      unreachable: 'The runner did not answer. It may still be starting; try again in a minute.',
    } satisfies Record<ClaudeSigninCheck, string>,
  },
  codex_cli: {
    notOn: 'Codex runners are not turned on in this install. An operator turns them on in the chart (claudePod.enabled).',
    terms: "Confirm that the ChatGPT plan's terms allow sharing this runner.",
    tooLarge: 'That file is too large to be a Codex sign-in file.',
    sameLogin: (label: string) => `This ChatGPT login is already used by "${label}". A shared login can sign the other copy out, so every Codex runner needs its own sign-in file. Log in again and upload that one.`,
    check: {
      ok: 'The sign-in works.',
      rejected: 'Codex refused this sign-in. Log in again and upload a new file.',
      expired: 'This sign-in has run out and could not be renewed. Log in again and upload a new file.',
      no_scope: 'This sign-in cannot run Codex. Log in again with a ChatGPT account and upload that file.',
      limit: "The ChatGPT plan's limit has been reached for now. Runs wait until it resets.",
      unreachable: 'The runner did not answer. It may still be starting; try again in a minute.',
    } satisfies Record<ClaudeSigninCheck, string>,
  },
} as const;
export const wordsOf = (kind: PodCliKind) => WORDS[kind];

const podsFor = (ctx: PluginContext, kind: PodCliKind): ClaudePodsProvider => {
  const p = ctx.providers.get<ClaudePodsProvider>('claude.pods');
  if (!p) throw conflict(WORDS[kind].notOn);
  return p;
};

/** The words of a Claude check, for the admin page. The Codex table is `wordsOf('codex_cli').check`. When the real CLI's texts are known, the matching changes in the bridge (signin.ts), not here. */
export const CHECK_MESSAGES: Record<ClaudeSigninCheck, string> = WORDS.claude_cli.check;

/** A keyed hash of the refresh token: the same login gives the same value, and the value says nothing about the token. Provisional until P19-01 (j) is measured with a real login. */
export function loginIdOf(workspaceId: string, refreshToken: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash('sha256').update(`manythreads-claude-login|${workspaceId}|${env['MANYTHREADS_LOGIN_ID_KEY'] ?? ''}`).digest();
  return createHmac('sha256', key).update(refreshToken).digest('hex');
}

/** The same for a Codex file, from the reader's `loginKey` (the ChatGPT account id, never a token unless the file has no account id). Its own key, so a Claude value never equals a Codex one. */
export function codexLoginIdOf(workspaceId: string, loginKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash('sha256').update(`manythreads-codex-login|${workspaceId}|${env['MANYTHREADS_LOGIN_ID_KEY'] ?? ''}`).digest();
  return createHmac('sha256', key).update(loginKey).digest('hex');
}

/** Reads the request body up to the limit. Stops reading at once past it. */
async function readBody(stream: AsyncIterable<Uint8Array> | undefined, tooLarge: string): Promise<Buffer> {
  if (!stream) throw invalid('The body must be the sign-in file.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_CREDENTIALS_BYTES) throw new HttpError(413, 'validation_failed', tooLarge);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function requirePodRunner(tx: PluginTx, id: string, lock = true) {
  const runner = await loadRunner(tx, id, lock);
  if (!isPodCli(runner.kind)) throw invalid('A sign-in file belongs to a Claude Code or Codex runner only.');
  return { ...runner, kind: runner.kind };
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
      // The kind decides the file's shape, the pod's Secret and the words. It is read without the lock first, so a slow upload does not hold the runner's row.
      const kind = (await requirePodRunner(tx, id, false)).kind;
      const words = WORDS[kind];
      const pods = podsFor(ctx, kind);
      if (req.headers[CREDENTIALS_TERMS_HEADER] !== '1') throw invalid(words.terms);
      if (req.headers[CREDENTIALS_SIGNINS_HEADER] !== '1') throw invalid('Confirm that the other sign-ins in the file may be stored as they are.');
      const bytes = await readBody(req.stream, words.tooLarge);
      const text = bytes.toString('utf8');
      // `expires` is the access part's expiry for a Claude file; a Codex file's is read in the browser only, so the server stores none. `login` is the keyed-hash input.
      let planLabel: string;
      let expires: string | null;
      let login: string;
      if (kind === 'claude_cli') {
        const looked = inspectClaudeCredentials(text, ctx.runtime.now().getTime());
        if (!looked.ok) throw invalid(looked.message);
        planLabel = looked.summary.planLabel;
        expires = new Date(looked.summary.expiresAt).toISOString();
        login = looked.refreshToken;
      } else {
        const looked = inspectCodexCredentials(text);
        if (!looked.ok) throw invalid(looked.message);
        // The plan name was read from the token in the browser, which names it in a header; the server takes one of a fixed list and reads no token content.
        planLabel = codexPlanLabelFrom(req.headers[CODEX_PLAN_LABEL_HEADER]);
        expires = null;
        login = looked.loginKey;
      }
      const runner = await requirePodRunner(tx, id);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const loginId = kind === 'claude_cli' ? loginIdOf(runner.workspace_id, login) : codexLoginIdOf(runner.workspace_id, login);
      const other = (
        await tx.query<{ label: string }>('SELECT label FROM app.bot_runners WHERE workspace_id = $1::uuid AND id <> $2::uuid AND (login_id = $3 OR credentials_sha256 = $4) LIMIT 1', [runner.workspace_id, id, loginId, sha])
      ).rows[0];
      if (other) throw conflict(words.sameLogin(other.label));
      const replaced = runner.uploaded_at !== null;
      const at = now();
      await tx.query(
        `UPDATE app.bot_runners
            SET owner_actor_id = $2::uuid, plan_label = $3, credentials_expires_at = $4::timestamptz, uploaded_at = now(), login_id = $5, credentials_sha256 = $6,
                terms_accepted_by = $2::uuid, terms_accepted_at = now(), signins_ack_by = $2::uuid, signins_ack_at = now(),
                status = 'starting', status_detail = 'Signed in. The pod is starting.', paused_until = NULL, last_checked_at = now(), updated_at = now()
          WHERE id = $1::uuid`,
        [id, tx.actor.id, planLabel, expires, loginId, sha],
      );
      // Written last: if the cluster refuses, the request fails and the rows above roll back with it.
      try {
        await pods.putCredentials({ runnerName: runner.name, runnerId: id, bytes, uploadId: randomBytes(12).toString('hex'), agent: agentOfKind(kind) });
      } catch {
        throw conflict('The cluster did not take the sign-in file. Nothing was changed; try again in a moment.');
      }
      const base = { workspaceId: runner.workspace_id, runnerId: id, name: runner.name, actorId: tx.actor.id, at };
      const family = kind === 'codex_cli' ? 'codex_pod' : 'claude_pod';
      await ctx.audit.emit(tx, { type: `${family}.credentials.${replaced ? 'replaced' : 'uploaded'}` as const, ...base });
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
      const runner = await requirePodRunner(tx, id);
      const pods = podsFor(ctx, runner.kind);
      await tx.query(
        `UPDATE app.bot_runners
            SET owner_actor_id = NULL, plan_label = NULL, credentials_expires_at = NULL, uploaded_at = NULL, login_id = NULL, credentials_sha256 = NULL,
                status = 'waiting_for_sign_in', status_detail = 'Waiting for a sign-in file. Upload one to start this runner.', paused_until = NULL, updated_at = now()
          WHERE id = $1::uuid`,
        [id],
      );
      try {
        await pods.removeCredentials({ runnerName: runner.name, agent: agentOfKind(runner.kind) });
      } catch {
        throw conflict('The cluster did not remove the sign-in file. Nothing was changed; try again in a moment.');
      }
      const type = runner.kind === 'codex_cli' ? 'codex_pod.credentials.removed' : 'claude_pod.credentials.removed';
      await ctx.audit.emit(tx, { type, workspaceId: runner.workspace_id, runnerId: id, name: runner.name, actorId: tx.actor.id, at: now() });
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
      const runner = await requirePodRunner(tx, id);
      const pods = podsFor(ctx, runner.kind);
      const messages = WORDS[runner.kind].check;
      if (runner.uploaded_at === null) throw conflict('There is no sign-in file yet. Upload one first.');
      const result = await pods.checkSignin({ runnerName: runner.name, agent: agentOfKind(runner.kind) });
      if (result === 'rejected' || result === 'expired' || result === 'no_scope') {
        await tx.query(`UPDATE app.bot_runners SET status = 'needs_sign_in', status_detail = $2, last_checked_at = now(), updated_at = now() WHERE id = $1::uuid`, [id, messages[result]]);
      } else if (result === 'ok' && (runner.status === 'needs_sign_in' || runner.status === 'paused')) {
        await tx.query(`UPDATE app.bot_runners SET status = 'starting', status_detail = NULL, paused_until = NULL, last_checked_at = now(), updated_at = now() WHERE id = $1::uuid`, [id]);
      } else if (result !== 'unreachable') {
        await tx.query('UPDATE app.bot_runners SET last_checked_at = now() WHERE id = $1::uuid', [id]);
      }
      return json(CheckClaudeSigninResponse.parse({ result, message: messages[result], runner: await presentOne(ctx, tx, id) }));
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
