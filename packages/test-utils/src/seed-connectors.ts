import { createSecretService, createSystemPool, withSystem } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import type { TestDatabase } from './db.ts';
import type { FakeProviders } from './fake-providers.ts';
import { KAHF_WORKSPACE_ID, LENA, NADIA, OMAR, RAFI, TEAM_IDS, type Persona } from './personas.ts';
import { SEED_IDS } from './seed-content.ts';

/**
 * Seed v16 (PLAN Bundle D, P16-12): what the connector screens show on a site where the work apps are already hooked up. OPT-IN: nothing calls this from `seedWorld`; only the
 * stack with `MANYTHREADS_STACK_SEED=connectors` (e2e/fixtures/stack-server.ts, which also starts tools/fake-saas) and the specs that ask for it run it, so every other stack and
 * baseline stays as it was (MISTAKES P21-24; a test asserts `seedWorld` alone never creates any of it).
 *
 * What it makes (the things that need no browser are written with the platform's own pieces, the rest goes through the real routes of the running server):
 *
 *  1. `#design` (Engineering, public) and, planned in it by Nadia through the real route, a voice room "Design review" with Rafi invited, today at 15:00 of the server's clock.
 *     When 15:00 is not between three minutes and eleven hours away, the room is planned four hours from now so the channel header always has something to show.
 *  2. Sign-ins that already exist, sealed with the platform's secret service and accepted by the stand-in with no consent: Omar's (the Engineering lead, who adds the team source),
 *     Nadia's and Rafi's Google (Drive, Calendar read and write, free/busy) and Lena's Microsoft (files and calendar). The tokens are `fs_<provider>_<hash>` of `seedKey + address` (tools/fake-saas `tokens.ts`).
 *  3. Seven days of connector usage counts for every sign-in (fixed numbers, so the admin page reads the same on every run).
 *  4. A work-app address `zendesk` in `#support` with the known signing secret `SEED_CONNECTORS.zendesk.secret`, and a Ticket watcher bot (a plain stand-in definition) whose
 *     `webhook` trigger names it, so a signed `ticket.created` from the sender starts a run. (The Support responder of seed v4 stays as it is: it answers a mention.)
 *  5. Telegram: the admin's account is on (against the Telegram stand-in), Nadia's Telegram user is linked with a code, and `#support` is joined to a Telegram group. Nadia is put on the
 *     Customer support team (she is on Engineering only), because a linked person's group message is posted as her and "You cannot post in that channel" is the answer to anyone who may not.
 *  6. The Engineering knowledge base `handbook` with a Drive folder of Omar's (the lead) as a team source: one document anyone can open is read in, one shared with one other
 *     person is left out (counted, never named).
 *
 * Needs a server started with `devAuth`, the Hermes stand-in command of the meetings stack, the OAuth and bridge fake bases of tools/fake-saas in its environment, and tools/fake-saas
 * running in this process (`saas`). Run it once per database: a second run finds `#design` and its plan and refuses.
 */
export const SEED_CONNECTORS = {
  design: { team: 'engineering', channel: 'design', title: 'Design review', agenda: '1. The settings page layout\n2. Icon set\n3. Dark theme contrast' },
  /** The work-app address in #support and the signing secret a spec signs with. */
  zendesk: { slug: 'zendesk', name: 'Zendesk', team: 'customer-support', channel: 'support', secret: 'seed-zendesk-signing-secret-0001' },
  /** The seed's Support responder (v4) answers a mention; this second bot is the one a Zendesk `ticket.created` starts. */
  responder: { slug: 'ticket-watcher', name: 'Ticket watcher', team: 'customer-support' },
  telegram: { displayName: 'Kahf bot', nadiaUserId: 700_001, groupChatId: -1_001_000_000_001, groupTitle: 'Kahf support' },
  handbook: {
    team: 'engineering',
    base: 'handbook',
    name: 'Handbook',
    folderId: 'folder-handbook',
    folderName: 'Engineering handbook',
    shared: { id: 'doc-handbook-shared', name: 'On-call guide' },
    limited: { id: 'doc-handbook-limited', name: 'Design review notes' },
  },
  /** The sign-ins that already exist. */
  grants: [
    { who: OMAR, provider: 'google' },
    { who: NADIA, provider: 'google' },
    { who: RAFI, provider: 'google' },
    { who: LENA, provider: 'microsoft' },
  ],
} as const;

type SeedProvider = 'google' | 'microsoft';

/** What a seeded grant is allowed to do (the same lists as tools/fake-saas `defaultScopes`; test-utils does not import the tools). */
const google = (name: string): string => `https://www.googleapis.com/auth/${name}`;
export const SEED_GRANT_SCOPES: Record<SeedProvider, string[]> = {
  google: ['openid', 'email', google('drive.readonly'), google('calendar.events'), google('calendar.events.readonly'), google('calendar.freebusy')],
  microsoft: ['offline_access', 'Files.Read', 'Files.Read.All', 'Calendars.ReadWrite', 'Calendars.Read', 'Calendars.ReadBasic'],
};
const PROVIDER_LABEL: Record<SeedProvider, string> = { google: 'Google', microsoft: 'Microsoft 365' };

/** The part of tools/fake-saas this seed uses (a structural type: `FakeSaas` fits). */
export interface SeedConnectorsSaas {
  seedKey: string;
  /** Google, Microsoft and Notion: the Drive of the account the folder is put in. */
  workspace: Pick<FakeProviders, 'putFile' | 'setFilePermissions'>;
  telegram: { bots: ReadonlyArray<{ token: string }> };
  control: {
    url: string;
    telegramSend(input: { fromUserId: number; text: string; chatId?: number | string; chatType?: 'private' | 'group'; chatTitle?: string; username?: string; firstName?: string }): Promise<unknown>;
  };
  seedTokens(provider: SeedProvider, email: string): { accessToken: string; refreshToken: string };
}

export interface SeedConnectorsOptions {
  /** The server's address (`TestServer.url`); it must have been started with `devAuth`. */
  url: string;
  db: Pick<TestDatabase, 'systemUrl'>;
  saas: SeedConnectorsSaas;
  /** Waits at most this long for each step (default 90 seconds). */
  timeoutMs?: number;
  /** Where the sealed tokens go: the platform's secret service (default: the process's own, which is the server's when the seed runs inside the stack). */
  secrets?: ReturnType<typeof createSecretService>;
  /** The instant "now" is (default the real clock). */
  now?: () => Date;
  log?: (line: string) => void;
}

export interface SeedConnectorsResult {
  designChannelId: string;
  scheduledMeetingId: string;
  startsAt: string;
  zendeskEndpointId: string;
  supportChannelId: string;
  telegramAccountId: string;
  handbookBaseId: string;
  /** `provider:persona key` to the connection id. */
  connections: Record<string, string>;
}

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- the replies of many routes, read by field
}

const header = (who: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) });

async function call(url: string, who: Persona, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...header(who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body: parsed };
}

async function ok(url: string, who: Persona, method: string, path: string, body?: unknown, expected: readonly number[] = [200, 201, 202]): Promise<Reply> {
  const reply = await call(url, who, method, path, body);
  if (!expected.includes(reply.status)) throw new Error(`seed connectors: ${method} ${path} answered ${String(reply.status)}: ${JSON.stringify(reply.body).slice(0, 300)}`);
  return reply;
}

async function until<T>(what: string, timeoutMs: number, fn: () => Promise<T | false | null | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`seed connectors: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Today at 15:00 of the clock, or four hours from now when that is not between three minutes and eleven hours away. */
export function designReviewStart(now: Date): Date {
  const at = new Date(now);
  at.setHours(15, 0, 0, 0);
  const ahead = at.getTime() - now.getTime();
  if (ahead >= 3 * 60_000 && ahead <= 11 * 3_600_000) return at;
  const later = new Date(now.getTime() + 4 * 3_600_000);
  later.setSeconds(0, 0);
  return later;
}

/** The fixed seven-day counts of one sign-in: `[calls, failures]` for today and the six days before. Same numbers on every run. */
export function usageFor(index: number): Array<[number, number]> {
  return Array.from({ length: 7 }, (_, day) => {
    const calls = 3 + ((index * 5 + day * 3) % 9);
    const failures = (index + day) % 6 === 0 ? 1 : 0;
    return [calls, failures];
  });
}

export interface SealGrantInput {
  workspaceId: string;
  /** The person's actor id (a connection's owner is an actor). */
  ownerActorId: string;
  provider: SeedProvider;
  accountLabel: string;
  scopes: readonly string[];
  accessToken: string;
  refreshToken: string | null;
  /** Seconds the access token is said to live (default one hour: it is renewed with the refresh token after that). */
  expiresInSec?: number;
}

/**
 * Writes a person's sign-in the way the connections plugin does after a consent (its `saveSignIn`): the person's connection (switched ON: a new row defaults to `disabled`,
 * MISTAKES Bundle D), what they agreed to, and the tokens sealed by the platform's secret service. Returns the connection id. Idempotent for the same person and provider.
 */
export async function sealPersonGrant(
  options: { db: Pick<TestDatabase, 'systemUrl'>; secrets?: ReturnType<typeof createSecretService>; now?: () => Date },
  input: SealGrantInput,
): Promise<string> {
  const secrets = options.secrets ?? createSecretService();
  const now = (options.now ?? (() => new Date()))();
  const pool = createSystemPool(options.db.systemUrl, 2);
  try {
    return await withSystem(
      async (tx) => {
        const seal = async (connectionId: string, name: string, plaintext: string): Promise<void> => {
          const secretId = await secrets.put(tx as unknown as PluginTx, plaintext);
          await tx.query(
            `INSERT INTO app.connection_secrets (workspace_id, connection_id, name, secret_id) VALUES ($1, $2, $3, $4)
             ON CONFLICT (connection_id, name) DO UPDATE SET secret_id = EXCLUDED.secret_id`,
            [input.workspaceId, connectionId, name, secretId],
          );
        };
        const existing = (await tx.query<{ id: string }>(`SELECT id FROM app.connections WHERE workspace_id = $1 AND owner_id = $2 AND scope = 'person' AND slug = $3`, [input.workspaceId, input.ownerActorId, input.provider])).rows[0];
        const connectionId =
          existing?.id ??
          (
            await tx.query<{ id: string }>(
              `INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id, status) VALUES ($1, NULL, $2, $2, $3, 'person', $4, 'enabled') RETURNING id`,
              [input.workspaceId, input.provider, PROVIDER_LABEL[input.provider], input.ownerActorId],
            )
          ).rows[0]!.id;
        await tx.query(`UPDATE app.connections SET status = 'enabled', expires_at = NULL, updated_at = now() WHERE id = $1`, [connectionId]);
        await tx.query(
          `INSERT INTO app.connection_oauth (connection_id, workspace_id, provider, scopes, account_label, access_expires_at, state, refreshed_at)
           VALUES ($1, $2, $3, $4::text[], $5, $6, 'ok', $7)
           ON CONFLICT (connection_id) DO UPDATE SET scopes = EXCLUDED.scopes, account_label = EXCLUDED.account_label, access_expires_at = EXCLUDED.access_expires_at, state = 'ok', refreshed_at = EXCLUDED.refreshed_at`,
          [connectionId, input.workspaceId, input.provider, [...input.scopes], input.accountLabel, new Date(now.getTime() + (input.expiresInSec ?? 3600) * 1000), now],
        );
        await seal(connectionId, 'access_token', input.accessToken);
        if (input.refreshToken !== null) await seal(connectionId, 'refresh_token', input.refreshToken);
        return connectionId;
      },
      { pool, workspaceId: input.workspaceId as typeof KAHF_WORKSPACE_ID },
    );
  } finally {
    await pool.end();
  }
}

/** The BOT.md of the stand-in Ticket watcher: a plain definition whose only trigger is the Zendesk `ticket.created` of the seed's address. */
export const RESPONDER_BOT_MD = [
  '---',
  'schema: 1',
  `name: ${SEED_CONNECTORS.responder.name}`,
  'role: Reads a new ticket and says what it saw',
  'kind: agent',
  'runtime: hermes',
  'model:',
  '  aliases: [smart]',
  'visibility: team',
  'triggers:',
  '  - type: webhook',
  `    connection: ${SEED_CONNECTORS.zendesk.slug}`,
  '    event: ticket.created',
  'capabilities:',
  '  native: [messages.post]',
  '---',
  '',
  `# ${SEED_CONNECTORS.responder.name}`,
  '',
  'Stand-in definition for the browser tests.',
  '',
].join('\n');

/**
 * Seeds everything in the header. Throws with the server's words when a step is refused or something does not settle in time.
 */
export async function seedConnectors(options: SeedConnectorsOptions): Promise<SeedConnectorsResult> {
  const { url, saas } = options;
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const now = options.now ?? (() => new Date());
  const pool = createSystemPool(options.db.systemUrl, 2);
  const sys = <T>(fn: Parameters<typeof withSystem<T>>[0]): Promise<T> => withSystem(fn, { pool, workspaceId: KAHF_WORKSPACE_ID });
  try {
    // ---- #design -----------------------------------------------------------------------------------------------------------------------------------
    const earlier = await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.channels WHERE team_id = $1 AND name = $2`, [TEAM_IDS.Engineering, SEED_CONNECTORS.design.channel])).rows[0]);
    if (earlier) throw new Error('seed connectors: #design is already there (seed once per database)');
    const made = await ok(url, OMAR, 'POST', `/api/teams/${SEED_CONNECTORS.design.team}/channels`, { name: SEED_CONNECTORS.design.channel, purpose: 'Design reviews and the things we look at together.' });
    const designChannelId = made.body.channel.id as string;
    log(`#design is ${designChannelId}`);

    // ---- verified addresses: the team rule counts only those ------------------------------------------------------------------------------------------
    await sys(async (tx) => {
      for (const p of [OMAR, NADIA, RAFI]) {
        await tx.query('INSERT INTO app.person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING', [p.workspaceId, p.personId, p.email]);
      }
    });

    // ---- Nadia reads and writes in #support: her Telegram group message is posted there as her, which needs her on the Customer support team (she is on Engineering only) -----------
    await sys(async (tx) => {
      await tx.query('INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [TEAM_IDS['Customer support'], NADIA.actorId, NADIA.workspaceId, 'member']);
    });

    // ---- the sign-ins that already exist ---------------------------------------------------------------------------------------------------------------
    const connections: Record<string, string> = {};
    for (const [index, g] of SEED_CONNECTORS.grants.entries()) {
      const tokens = saas.seedTokens(g.provider, g.who.email);
      const id = await sealPersonGrant(
        { db: options.db, ...(options.secrets ? { secrets: options.secrets } : {}), now },
        { workspaceId: g.who.workspaceId, ownerActorId: g.who.actorId, provider: g.provider, accountLabel: g.who.email, scopes: SEED_GRANT_SCOPES[g.provider], accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      );
      connections[`${g.provider}:${g.who.key}`] = id;
      await sys(async (tx) => {
        for (const [day, [calls, failures]] of usageFor(index).entries()) {
          await tx.query(
            `INSERT INTO app.connection_usage_daily (workspace_id, connection_id, provider, day, calls, failures)
             VALUES ($1, $2, $3, (now() AT TIME ZONE 'utc')::date - $4::int, $5, $6) ON CONFLICT (connection_id, day) DO UPDATE SET calls = EXCLUDED.calls, failures = EXCLUDED.failures`,
            [g.who.workspaceId, id, g.provider, day, calls, failures],
          );
        }
      });
    }
    log(`sealed ${Object.keys(connections).length} sign-ins`);

    // ---- the planned room --------------------------------------------------------------------------------------------------------------------------
    const start = designReviewStart(now());
    const planned = await ok(url, NADIA, 'POST', `/api/channels/${designChannelId}/scheduled-meetings`, {
      title: SEED_CONNECTORS.design.title,
      startsAt: start.toISOString(),
      lengthMinutes: 45,
      agendaMd: SEED_CONNECTORS.design.agenda,
      calendarProvider: 'google',
      attendeePersonIds: [RAFI.personId],
      outsideAddresses: [],
    });
    const scheduledMeetingId = planned.body.scheduledMeeting.id as string;
    log(`planned "${SEED_CONNECTORS.design.title}" at ${start.toISOString()}`);

    // ---- the work-app address and the bot that listens ---------------------------------------------------------------------------------------------
    const supportChannelId = SEED_IDS.channels['customer-support/support'];
    const hook = await ok(url, OMAR, 'POST', `/api/channels/${supportChannelId}/provider-hooks`, {
      provider: 'zendesk',
      slug: SEED_CONNECTORS.zendesk.slug,
      name: SEED_CONNECTORS.zendesk.name,
      signingSecret: SEED_CONNECTORS.zendesk.secret,
    });
    const zendeskEndpointId = hook.body.endpoint.id as string;
    const proposal = await call(url, OMAR, 'POST', `/api/teams/${SEED_CONNECTORS.responder.team}/proposals`, {
      path: `bots/${SEED_CONNECTORS.responder.slug}/BOT.md`,
      op: 'put',
      content: RESPONDER_BOT_MD,
      title: 'Set up the ticket watcher',
      applyNow: true,
    });
    if (proposal.status >= 300 && !(proposal.status === 400 && JSON.stringify(proposal.body).includes('does not change the file'))) {
      throw new Error(`seed connectors: could not set up the ticket watcher: ${String(proposal.status)} ${JSON.stringify(proposal.body).slice(0, 300)}`);
    }
    await until('the loader to load the ticket watcher', timeoutMs, async () =>
      sys(async (tx) => (await tx.query(`SELECT 1 FROM app.bots WHERE team_id = $1 AND slug = $2 AND status = 'active'`, [TEAM_IDS['Customer support'], SEED_CONNECTORS.responder.slug])).rows.length > 0),
    );

    // ---- Telegram: the admin's account, Nadia's chat user, and #support joined to a group ------------------------------------------------------------
    const tgToken = saas.telegram.bots[0]?.token;
    if (!tgToken) throw new Error('seed connectors: the Telegram stand-in has no bot');
    await ok(url, OMAR, 'PUT', '/api/admin/bridges/telegram', { displayName: SEED_CONNECTORS.telegram.displayName });
    await ok(url, OMAR, 'PUT', '/api/admin/bridges/telegram/credentials', { botToken: tgToken });
    const on = await ok(url, OMAR, 'POST', '/api/admin/bridges/telegram/switch', { on: true });
    if (on.body.account?.status !== 'on') throw new Error(`seed connectors: Telegram did not switch on: ${JSON.stringify(on.body).slice(0, 300)}`);
    const telegramAccountId = on.body.account.id as string;
    const code = await ok(url, NADIA, 'POST', '/api/me/bridges/telegram/link-code');
    await saas.control.telegramSend({ fromUserId: SEED_CONNECTORS.telegram.nadiaUserId, text: `/start ${code.body.code as string}`, username: 'nadia_k', firstName: 'Nadia' });
    await until("Nadia's Telegram user to be linked", timeoutMs, async () => ((await ok(url, NADIA, 'GET', '/api/me/bridges')).body.identities as unknown[]).length > 0);
    const joinCode = await ok(url, OMAR, 'POST', `/api/channels/${supportChannelId}/bridge-links/telegram/code`);
    await saas.control.telegramSend({
      fromUserId: SEED_CONNECTORS.telegram.nadiaUserId,
      chatId: SEED_CONNECTORS.telegram.groupChatId,
      chatType: 'group',
      chatTitle: SEED_CONNECTORS.telegram.groupTitle,
      text: joinCode.body.command as string,
      username: 'nadia_k',
      firstName: 'Nadia',
    });
    await until('#support to be joined to the Telegram group', timeoutMs, async () => ((await ok(url, OMAR, 'GET', `/api/channels/${supportChannelId}/bridge-links`)).body.links as unknown[]).length > 0);
    log('Telegram is on, Nadia is linked, #support is joined');

    // ---- the handbook base with a Drive folder -----------------------------------------------------------------------------------------------------
    const h = SEED_CONNECTORS.handbook;
    const modified = new Date(now().getTime() - 2 * 86_400_000).toISOString();
    saas.workspace.putFile(OMAR.email, { id: h.folderId, name: h.folderName, mimeType: 'application/vnd.google-apps.folder', modified, text: '' });
    saas.workspace.putFile(OMAR.email, {
      id: h.shared.id,
      name: h.shared.name,
      mimeType: 'text/plain',
      modified,
      parentId: h.folderId,
      permissions: [{ type: 'anyone' }],
      text: 'On-call engineers carry the pager for one week at a time. The hand-over is on Monday at ten, in #dev.\n',
    });
    saas.workspace.putFile(OMAR.email, {
      id: h.limited.id,
      name: h.limited.name,
      mimeType: 'text/plain',
      modified,
      parentId: h.folderId,
      permissions: [{ type: 'user', email: NADIA.email }],
      text: 'Notes only Omar and Nadia may read: the settings page layout and the open questions on the icon set.\n',
    });
    const base = await ok(url, OMAR, 'POST', `/api/teams/${h.team}/knowledge`, { slug: h.base, name: h.name });
    const handbookBaseId = base.body.base.id as string;
    await ok(url, OMAR, 'POST', `/api/teams/${h.team}/knowledge/${h.base}/connector-sources`, { provider: 'google_drive', root: h.folderId, label: h.folderName, acknowledgeTeamRule: true });
    await until('the Drive folder to be read', timeoutMs, async () => {
      const detail = (await ok(url, OMAR, 'GET', `/api/teams/${h.team}/knowledge/${h.base}`)).body as { documents: unknown[]; sources: Array<{ kind: string; status?: string; skippedLimited?: number }> };
      const source = detail.sources.find((s) => s.kind === 'connector');
      return source && source.status === 'ready' && detail.documents.length >= 1 && (source.skippedLimited ?? 0) >= 1 ? true : false;
    });
    log('the handbook folder is read: one document in, one left out');

    return { designChannelId, scheduledMeetingId, startsAt: start.toISOString(), zendeskEndpointId, supportChannelId, telegramAccountId, handbookBaseId, connections };
  } finally {
    await pool.end();
  }
}
