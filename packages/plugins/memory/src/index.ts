import { definePlugin } from '@manythreads/sdk';
import {
  FEED_QUEUE,
  FORGETS_PER_TEAM_PER_MINUTE,
  RECONCILE_QUEUE,
  RETAINS_PER_TEAM_PER_MINUTE,
  WINDOW_MS,
} from './constants.ts';
import { CONSUMED_EVENTS, markRetainedOfChannels, registerConsumers } from './consumers.ts';
import { drainFeed } from './feed.ts';
import { registerRoutes } from './routes.ts';
import { registerWriteTool } from './write.ts';
import { SlidingWindow } from './window.ts';

export { decide } from './decide.ts';
export type { Decision } from './decide.ts';
export { syncConcepts, toMemoryConceptSummary } from './concepts.ts';
export { appendLesson, appendPersonNote, lessonPath, personNotePath, PLATFORM_ENTRY_MAX_CHARS } from './platform.ts';
export { bundleAbsoluteLinks, conceptText, draftPathFor, isPersonOwned, splitPlatformKeys, PLATFORM_OWNED_KEYS } from './write.ts';
export { drainFeed } from './feed.ts';
export type { DrainStats, FeedRuntime } from './feed.ts';
export { SlidingWindow } from './window.ts';
export { contentHash, documentIdFor, renderApproval, renderMessage, renderPage, renderRun, renderThread } from './render.ts';


/**
 * memory: feeds a team's memory bank from what the team did (SPEC §12.1, PLAN P5-13). Team-visible messages and threads, run summaries,
 * decided approvals and pages are retained to the bank of their team — through the memory provider (`provider.memory`, today memory-hindsight), in a
 * system transaction, with source, actor, time and link on every document — and nothing from a private channel, a DM or a run that read a
 * `person` source ever is. `memory_retain_log` records what was retained, replaced, forgotten or withheld and why; `app.run_retain_verdict` is the
 * narrowest-source rule that `memory.retain` and the run summaries share. docs/plugins/memory.md.
 */
export default definePlugin({
  manifest: {
    name: 'memory',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.subscribe', 'job.register'],
    events: { emits: [], consumes: [...CONSUMED_EVENTS] },
    // `memory.write` (P5-26): the one tool a bot writes the team's OKF bundle through. Not destructive: it commits a file like `pages.write`,
    // through the one writer, as the bot, and the broker's path guard is what confines it to `memory/**` outside `memory/shared/`.
    capabilities: [{ name: 'memory.write', destructive: false }],
    // The verdict function and the sources read these plugins' tables (bot_runs and run_source_log, channels and messages, files, approvals, repo_entries).
    dependsOn: ['channels', 'bots', 'files', 'approvals', 'repo-git'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    registerConsumers(ctx);
    registerWriteTool(ctx);

    // Windows live in this process: a per-replica limit that restarts empty (CLAUDE.md: rate limits never go in the database).
    const runtime = {
      retainWindow: new SlidingWindow(RETAINS_PER_TEAM_PER_MINUTE, WINDOW_MS),
      forgetWindow: new SlidingWindow(FORGETS_PER_TEAM_PER_MINUTE, WINDOW_MS),
      now: () => ctx.runtime.now().getTime(),
    };

    // The drain: queued behind every change (after the debounce) and once a minute as the safety net. It talks to the engine, so a failure
    // inside it backs the source off in its own row and never reaches the outbox; one attempt, because the work list is the retry.
    ctx.jobs.register(
      FEED_QUEUE,
      async (_payload, tx, job) => {
        const stats = await drainFeed(ctx, tx, job.log, runtime);
        if (stats.considered > 0) {
          job.log.info(
            `memory: feed considered ${stats.considered}: retained ${stats.retained}, forgot ${stats.forgotten}, withheld ${stats.withheld}, deferred ${stats.deferred}, unchanged ${stats.unchanged}, throttled ${stats.throttled}, failed ${stats.failed}, dropped ${stats.dropped}`,
          );
        }
      },
      { cron: '* * * * *', maxAttempts: 1, concurrency: 1 },
    );

    // The sweep: a document whose channel is no longer a public channel of its team (an operator's change leaves no event) is read again, and goes.
    ctx.jobs.register(
      RECONCILE_QUEUE,
      async (_payload, tx, job) => {
        const marked = await markRetainedOfChannels(ctx, tx, null);
        if (marked > 0) job.log.info(`memory: ${marked} document(s) of channels that are no longer team-visible were queued to be forgotten`);
      },
      { cron: '17 * * * *', maxAttempts: 1, concurrency: 1 },
    );
  },
});
