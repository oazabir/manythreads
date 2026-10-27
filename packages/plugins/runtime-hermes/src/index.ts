import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, type RunnerDoor } from '@manythreads/sdk';
import { createHermesProvider, sweepStaleProfiles } from './hermes.ts';
import { registerConnectionRoutes, resolveTarget } from './connections.ts';
import { createProfilesProvider, managedEnvFrom } from './profiles.ts';
import { registerProfileChanges } from './profile-changes.ts';
import { registerApprovalResume, registerRouter, registerRunJob } from './router.ts';

export { renderGatewayProfile, GATEWAY_ENV, type GatewayProfileInput, type GatewayProfileFiles } from './gateway-profile.ts';
export { runOnGateway, managedProfileName, profileFor, sessionIdFor, sseFrames, type GatewayRuntimeOptions, type GatewayTarget } from './gateway.ts';
export { runConcurrencyFrom } from './run-job.ts';
export { chatArgs, profileHome, renderConfig, renderProfile } from './profile.ts';
export { GUARDED_TOOLSETS, RUNTIME_GRANT_TOOLSETS, hermesToolsets, type HermesToolsets } from './toolsets.ts';
export { parseHermesLine, replyText, type HermesEvent } from './stream.ts';
export { childEnv, createHermesProvider, HERMES_RUNTIME_ID, sweepStaleProfiles, type HermesRuntimeOptions } from './hermes.ts';
export { CLASSIFIER_INSTRUCTION, GATE_BUDGET_MS, wrapMessage, checkList, chunksOf, classifierPrompt, hasGate, parseAnswer, runGate, type ClassifierDoor, type GateInput, type GateVerdict } from './gate.ts';
export { RUN_QUEUE, buildPrompt, matchTrigger, mentionedHandles, registerApprovalResume, registerRouter, registerRunJob, type MessageView, type RunPayload, type RoutedTrigger } from './router.ts';

/** A profile directory older than this is a dead run's (the platform's own ceiling on a run is an hour). */
const STALE_PROFILE_MS = 2 * 60 * 60 * 1000;

/**
 * runtime-hermes: the agent runtime (SPEC §7.1, PLAN P5-10). One `bot_runtime` provider — `hermes` — that renders a Hermes
 * profile from a `BOT.md` (its body is `SOUL.md`), starts one Hermes process per run in that profile and stops it, plus the
 * router that decides which `conversation`, `mention` and `channel_message` triggers a posted message fires and the job
 * that runs one. `runtime-rules` registers the other provider, so a `rules` bot runs with no model at all; both are looked
 * up by the value in `bots.runtime` (`ctx.providers.get('bot_runtime', runtime)`).
 *
 * The run's authority is the run's own MCP endpoint (`ctx.runs`): the profile is pointed at it, and nothing else — no
 * provider key, no repo credential, no memory address — is written into a profile. That invariant is the phase's exit gate.
 */
export default definePlugin({
  manifest: {
    name: 'runtime-hermes',
    version: '0.1.0',
    kind: 'server',
    // The run/tool door (mint a run per invocation, post the reply as the run's bot), the message subscription that routes
    // triggers, the job a run executes in, and the provider itself.
    extends: ['event.subscribe', 'event.emit', 'job.register', 'provider.bot_runtime', 'provider.hermes.profiles', 'tool.invoke', 'hook.pre_egress'],
    migrations: 'migrations',
    // `runtime.gate.held`: the gate stopped a run before any model call (P5-11). `hook.pre_egress` is used to redact the message an approver is shown.
    events: {
      emits: [
        'runtime.gate.held',
        'runtime.task.not_woken',
        'runtime.rhythm.started',
        'runtime.rhythm.finished',
        'hermes.connection.created',
        'hermes.connection.updated',
        'hermes.connection.deleted',
        'hermes.connection.tested',
        'hermes.profiles.changed',
      ],
      consumes: ['channel.message.posted', 'approvals.approval.decided', 'tasks.task.handed_off', 'tasks.task.completed', 'rhythms.rhythm.ran', 'bots.bot.loaded', 'bots.bot.removed', 'llm.key.changed'],
    },
    // `bots` owns the rows this routes (and compiles what it needs into them); `channels` owns the messages it reacts to.
    // `guardrails-dlp` redacts the message an approver is shown when the gate holds one (a preview that cannot be redacted is not shown).
    dependsOn: ['bots', 'channels', 'teams', 'guardrails-dlp', 'projects'],
  },
  register(ctx) {
    const dataRoot = (process.env['MANYTHREADS_RUNTIME_DIR'] ?? join(tmpdir(), 'manythreads-runtime')).trim();
    // A server that died mid-run left its profiles (run token, bot key) on disk: anything older than the longest run goes.
    void sweepStaleProfiles(dataRoot, STALE_PROFILE_MS).catch(() => undefined);
    ctx.providers.register(
      'bot_runtime',
      createHermesProvider({
        bin: (process.env['MANYTHREADS_HERMES_BIN'] ?? 'hermes').trim() || 'hermes',
        prefix: (process.env['MANYTHREADS_HERMES_PREFIX'] ?? '')
          .split(' ')
          .map((part) => part.trim())
          .filter((part) => part !== ''),
        dataRoot,
        // The whole environment is offered; the provider passes on only its allowlist (`childEnv`).
        env: process.env,
        killGraceSeconds: Number(process.env['MANYTHREADS_HERMES_KILL_GRACE'] ?? '15') || 15,
        // Looked up per run: the runners plugin may load after this one.
        runners: () => ctx.providers.get<RunnerDoor>('runner'),
        // The Hermes gateways of the team's connections (`placement.gateway`), looked up per run.
        gateways: { resolve: (query) => resolveTarget(ctx, query) },
      }),
    );
    const profiles = createProfilesProvider(
      ctx,
      { info: (line) => void process.stderr.write(`${line}\n`), warn: (line) => void process.stderr.write(`${line}\n`) },
      managedEnvFrom(process.env),
    );
    ctx.providers.register('hermes.profiles', profiles);
    registerProfileChanges(ctx, profiles.notify);
    registerConnectionRoutes(ctx, {}, profiles.notify);
    registerRouter(ctx);
    registerApprovalResume(ctx);
    registerRunJob(ctx);
  },
});
