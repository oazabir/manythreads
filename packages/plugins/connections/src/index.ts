import { definePlugin, type PluginEvent } from '@manythreads/sdk';
import { ChannelMessagePostedEvent } from '@manythreads/shared';
import { compileBot, compileTeam, dropBot, type Declared } from './compile.ts';
import { registerAdminRoutes } from './admin-routes.ts';
import { registerCalendarProvider } from './calendar-provider.ts';
import { registerDocumentsProvider } from './documents-provider.ts';
import { registerOffboard } from './offboard.ts';
import { registerInboxDoorSetup } from './email/inbox-door.ts';
import { createConnectionDeployStep } from './deploy.ts';
import { linkPost } from './link.ts';
import { createReconnectNotifier } from './oauth/notice.ts';
import { registerRefreshJob } from './oauth/refresh.ts';
import type { OAuthDeps } from './oauth/store.ts';
import { registerOAuthAppRoutes } from './oauth-app-routes.ts';
import { registerPersonRoutes } from './person-routes.ts';
import { PERSON_TOOL_DEFS } from './person-tools.ts';
import { registerRoutes } from './routes.ts';
import { createConnectionsSource } from './source.ts';
import { registerWatch } from './watch.ts';

export { compileBot, compileTeam, dropBot } from './compile.ts';
export { inputProblem, kindOf, kindServes, TOOLS } from './kinds.ts';
export { createDummyTransport } from './email/dummy.ts';
export type { EmailTransport, ListMailQuery, MailMessage, MailSummary, OutgoingMail } from './email/transport.ts';
export { claimBehindRun, mailBehindRun } from './email/tools.ts';
export { linkPost } from './link.ts';
export { triggerMatches, watchInbox, WATCH_QUEUE } from './watch.ts';
export { PERSON_TOOLS } from './person-tools.ts';
export { CHECK_NAME, evaluatePull, publishReport, type GithubTarget, type PullReport } from './github-pr-evals.ts';
export { issueKubernetesToken, readKubernetes } from './brokers/kubernetes.ts';
export { issueSshCredential, runSshCommand, stepCaSigner } from './brokers/ssh.ts';
export { clampLifetime, MAX_CREDENTIAL_SECONDS } from './brokers/limits.ts';
export { deleteConnectionAndSecrets, putConnectionSecret, readConnectionSecret } from './secrets.ts';

/**
 * connections: a team's links to outside services, and the tools a bot gets from them (PLAN P8-01, P8-28). A connection holds the place and the sealed
 * credentials; a grant says which bot may call which of its tools; this plugin is the source those tools come from (`ctx.toolSources`), so the MCP gateway lists
 * them for a bot that has a grant and hands the call here after the capability broker allowed it. It compiles `capabilities.connections` of each BOT.md into the
 * grants when the bot is loaded. The only kind today is `email`, served through the `EmailTransport` interface by the dummy transport (a table), with the admin-only delivery door
 * and the `inbox` watch (P8-29, P8-30). docs/plugins/connections.md.
 */
export default definePlugin({
  manifest: {
    name: 'connections',
    version: '0.1.0',
    kind: 'server',
    migrations: 'migrations',
    // tool.source: this plugin offers tools to bots; secret.seal: credentials are sealed by the platform's secret service; event.subscribe: the compile
    // job.register: the inbox watch and the renewal of people's sign-ins (P16-02); event.emit: `connections.connection.changed`, `connections.inbox.claimed`,
    // `connections.oauth_app.changed` and `connections.sign_in.expired`
    // Bundle D (docs/plugins/connections.md "Bundle D contracts"): `connections.person.offboarded` when a leaving person's connections are removed; `workspace.member.status_changed` starts that;
    // the calendar and documents doors are providers of kinds `connector.calendar` and `connector.documents`
    // provider.deploy.step: the connection step of the bot page's Deploy action (P8-34), composed by the workshop plugin
    extends: ['tool.source', 'secret.seal', 'event.subscribe', 'event.emit', 'job.register', 'provider.deploy.step', 'provider.connector.calendar', 'provider.connector.documents'],
    events: {
      emits: ['connections.connection.changed', 'connections.inbox.claimed', 'connections.oauth_app.changed', 'connections.sign_in.expired', 'connections.person.offboarded'],
      consumes: ['bots.bot.loaded', 'bots.bot.removed', 'connections.connection.changed', 'channel.message.posted', 'workspace.member.status_changed'],
    },
    // Every tool a connection can serve is a capability the broker knows by name. None is destructive: a tool that deletes outside data is not offered through a
    // connection (the compile refuses a destructive tool, and the broker never grants one).
    capabilities: [
      { name: 'email.read', destructive: false },
      { name: 'email.draft', destructive: false },
      { name: 'email.send', destructive: false },
      // the tools of a person's own Google, Microsoft and Notion connection (person-tools.ts); the ones that write always wait for approval
      ...PERSON_TOOL_DEFS.map((t) => ({ name: t.name, destructive: false })),
      // not destructive by construction: ssh.run starts only commands an administrator listed word for word; kubernetes.get only reads
      { name: 'ssh.run', destructive: false },
      { name: 'kubernetes.get', destructive: false },
    ],
    // app.connection_grants references app.team_members (teams); the compile and the watch read app.bots and its projection (bots); the link reads the posts (channels);
    // the "Reconnect" notice is written into the person's Reminders conversation with the functions of the reminders plugin
    dependsOn: ['teams', 'bots', 'channels', 'reminders'],
  },
  register(ctx) {
    const declared: Declared = new Map(ctx.manifest.capabilities.map((c) => [c.name, { destructive: c.destructive }]));
    const oauth: OAuthDeps = { db: ctx.db, secrets: ctx.secrets, now: () => ctx.runtime.now(), env: process.env, onNeedsReconnect: createReconnectNotifier(ctx) };
    ctx.toolSources.register(createConnectionsSource(oauth));

    // Runs as the system actor in the outbox consumer, after the loader committed the bot's row and its projection; idempotent, so a redelivery changes nothing.
    ctx.events.subscribe('bots.bot.loaded', async (event: PluginEvent, tx) => {
      const { workspaceId, teamId, botId } = event as PluginEvent & { workspaceId?: unknown; teamId?: unknown; botId?: unknown };
      if (typeof workspaceId !== 'string' || typeof teamId !== 'string' || typeof botId !== 'string') return;
      await compileBot(tx, declared, { workspaceId, teamId, botId });
    });
    ctx.events.subscribe('bots.bot.removed', async (event: PluginEvent, tx) => {
      const { workspaceId, botId } = event as PluginEvent & { workspaceId?: unknown; botId?: unknown };
      if (typeof workspaceId !== 'string' || typeof botId !== 'string') return;
      await dropBot(tx, { workspaceId, botId });
    });

    // A connection that appears may be the one a definition was waiting for: compile the team's bots again once it is committed. One that goes takes the broker's
    // rows that came from it (the grants of its own table go with it by cascade); the source refuses a call to a connection that is gone either way.
    ctx.events.subscribe('connections.connection.changed', async (event: PluginEvent, tx) => {
      const { workspaceId, teamId, slug, change } = event as PluginEvent & { workspaceId?: unknown; teamId?: unknown; slug?: unknown; change?: unknown };
      if (typeof workspaceId !== 'string' || typeof teamId !== 'string') return;
      if (change === 'created') await compileTeam(tx, declared, { workspaceId, teamId });
      if (change === 'deleted' && typeof slug === 'string') {
        await tx.query(`DELETE FROM app.capability_grants WHERE team_id = $1 AND constraints->>'connection' = $2`, [teamId, slug]);
      }
    });

    // The bot's post about a new mail thread is tied to the mail through the post's `meta.runId` (link.ts).
    ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx) => {
      await linkPost(tx, ChannelMessagePostedEvent.parse(raw).messageId);
    });

    registerWatch(ctx);
    registerRoutes(ctx, oauth);
    registerInboxDoorSetup(ctx);
    ctx.providers.register('deploy.step', createConnectionDeployStep(ctx));
    registerPersonRoutes(ctx, oauth);
    registerOAuthAppRoutes(ctx, oauth);
    registerRefreshJob(ctx, oauth);
    // Bundle D: one call per module, each a stub until its work package fills it in.
    registerCalendarProvider(ctx);
    registerDocumentsProvider(ctx);
    registerAdminRoutes(ctx, oauth);
    registerOffboard(ctx, oauth);
  },
});
