import { definePlugin } from '@manythreads/sdk';
import { registerSetupRoutes } from './routes.ts';
import { registerSetupJob } from './session.ts';
import { registerWorkshopJob } from './wsession.ts';
import { registerWorkshopRoutes } from './wroutes.ts';
import { registerReplayRoutes } from './replay.ts';
import { registerReassessmentRoutes, registerReassessmentSubscribers } from './reassess.ts';
import { registerTerminalRoutes } from './terminal/routes.ts';
import { registerDeployRoute } from './deploy.ts';
import { registerRecipeRoutes } from './recipes.ts';

export { checkBotProposal, checkSkill, checkTeamMdChange } from './policy.ts';
export { gradeAll, gradeRequirement, questionsForGaps } from './grade.ts';
export { readTeamDefaults } from './team-defaults.ts';
export { rehearsalTools, wireNames } from './rehearse.ts';
export { runTurn } from './turn.ts';

/**
 * workshop: where a person sets up a bot by describing it (PLAN P7-02 to P7-04, SPEC section 9). A built-in helper (the profile in `templates/_setup/PROFILE.md`) looks at what the team has, the platform grades
 * every requirement of the brief, the person answers one batched list of questions, and the helper proposes the bot's files as proposals that a person approves. It changes nothing itself.
 * docs/plugins/workshop.md.
 */
export default definePlugin({
  manifest: {
    name: 'workshop',
    version: '0.2.0',
    kind: 'server',
    // `job.register`: a model call takes a minute and must not hold a request open (the handler is read like a migration, docs/plugins/security.md). `capability.call`: the helper's tools are
    // the platform's own `knowledge.search` and `proposals.propose`, called in the PERSON's transaction; the narrow door adds no actor.
    // `event.subscribe` and `event.emit` (P7-07): the re-assessment notices follow the platform's events for knowledge bases, runners and eval results and say so with their own events; no model is called there. `event.emit` also carries the terminal's two audit events (P7-09). `hook.pre_egress`: the terminal's record is passed through the data-loss guard before it is stored (the same chain every outgoing message passes).
    extends: ['job.register', 'capability.call', 'event.subscribe', 'event.emit', 'hook.pre_egress'],
    calls: ['knowledge.search', 'proposals.propose'],
    events: {
      emits: ['workshop.reassessment.created', 'workshop.reassessment.closed', 'workshop.replay.started', 'workshop.terminal.opened', 'workshop.terminal.closed'],
      consumes: [
        'knowledge.base.created',
        'knowledge.base.deleted',
        'bot_runner.runner.created',
        'bot_runner.runner.updated',
        'bot_runner.runner.deleted',
        'bot_runner.availability.changed',
        'bot_runner.default.changed',
        'bots.eval.run.finished',
      ],
    },
    // teams, channels and bots: the tables read for the inventory; proposals and knowledge: the capabilities the tools call; bot-runners: the placement question; gateway-llm: the model; repo-git: TEAM.md and the skills folder; gateway-mcp: the sandbox where a bot is rehearsed (P7-05) and the one a terminal opens into (P7-09); connections (P8-34): the Deploy action runs the `deploy.step` providers of proposals, knowledge and connections, and no plugin depends on the workshop, so there is no cycle. The data-loss guard (guardrails-dlp) is deliberately NOT a dependency: without it only the terminal is unavailable (it refuses to open, and its record would never be stored unchecked); the rest of the Workshop still loads.
    dependsOn: ['teams', 'channels', 'bots', 'proposals', 'knowledge', 'bot-runners', 'gateway-llm', 'repo-git', 'gateway-mcp', 'connections'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerSetupRoutes(ctx);
    registerSetupJob(ctx);
    registerWorkshopRoutes(ctx);
    registerWorkshopJob(ctx);
    registerReplayRoutes(ctx);
    registerReassessmentRoutes(ctx);
    registerReassessmentSubscribers(ctx);
    registerTerminalRoutes(ctx);
    registerDeployRoute(ctx);
    registerRecipeRoutes(ctx);
  },
});
