import { definePlugin } from '@manythreads/sdk';
import { registerJobs } from './jobs.ts';
import { registerRoutes } from './routes.ts';

export { openArchive, looksLikeArchive, ArchiveError } from './archive.ts';
export { ZipArchive, ZipRefused, isSafeEntryName } from './zip.ts';
export { SlackReader, convertSlackText, slackEmoji } from './slack.ts';
export { MattermostReader } from './mattermost.ts';
export { splitJsonArray, splitLines, decodeText, cleanMessageText } from './text.ts';
export { runImport } from './engine.ts';
export { DEFAULT_LIMITS, importMaxBytes } from './limits.ts';

/**
 * import (PLAN P14-13): brings a Slack or Mattermost export into a team. An admin uploads the archive, reads a dry-run report that writes nothing, then
 * starts the import, which runs in the background and ends with a plain report. Channels and messages are written through the channels plugin (the message
 * provider and the direct-conversation function), keep the time they were written at, and raise no notification. People are matched by verified email;
 * the rest become placeholders that a later sign-in with the same email takes over. docs/plugins/import.md.
 *
 * Queues: `import.analyse` (the dry run), `import.run` (the import) and a daily `import.purge` (drops stored archives nobody started) and `import.sweep` every 10 minutes (ends a run nothing works on any more).
 * `MANYTHREADS_IMPORT_MAX_BYTES` sets the largest upload (default 1 GiB).
 */
export default definePlugin({
  manifest: {
    name: 'import',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'job.register'],
    events: { emits: ['import.run.uploaded', 'import.run.analysed', 'import.run.started', 'import.run.finished', 'import.person.claimed'], consumes: [] },
    // channels (messages, the provider), direct-messages (app.dms_get_or_create), teams (team_members) and webhooks (the author-naming function this plugin extends)
    dependsOn: ['channels', 'direct-messages', 'reminders', 'teams', 'webhooks'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    registerJobs(ctx);
  },
});
