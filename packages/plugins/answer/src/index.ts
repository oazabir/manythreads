import { definePlugin } from '@manythreads/sdk';
import { postAnswer } from './post.ts';

export { buildAnswer, citationRef } from './build.ts';
export type { BuiltAnswer } from './build.ts';
export { postAnswer } from './post.ts';
export type { AnswerToolResult } from './post.ts';
export { AnswerView } from './view.ts';

/**
 * answer: how a bot finishes a reply (SPEC §12.4, §14; PLAN P5-18). The native tool `answer.post` takes a text, the sources it cites by id and
 * some suggestions; the platform re-reads every one of them as the person who asked, keeps what that person may open (and what the reply's
 * readers may), counts what it left out without naming it, stamps who the answer was for from the run, and posts the message into the thread
 * with the payload as the message's `meta.answer`. The web client draws it (`Answer`, numbered citations · Lineage · Sources reached · Outside
 * scope · "Answered for …"). Any bot may call it; nothing in the platform knows Brain is special. docs/plugins/answer.md.
 */
export default definePlugin({
  manifest: {
    name: 'answer',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit'],
    // The tool a bot's BOT.md grants as `answer.post` (or `answer.*`). A write that adds one message like any other: not destructive.
    capabilities: [{ name: 'answer.post', destructive: false }],
    events: { emits: ['answer.answer.posted'], consumes: [] },
    // Its functions read the messages, threads, channels, files, runs and repo index the citations name.
    dependsOn: ['channels', 'bots', 'files', 'repo-git'],
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.capabilities.register('answer.post', (input, tx) => postAnswer(ctx, tx, input));
  },
});
