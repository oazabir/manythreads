import { definePlugin } from '@manythreads/sdk';
import { registerSetupRoutes } from './routes.ts';
import { registerSetupJob } from './session.ts';

export { checkBotProposal, checkSkill, checkTeamMdChange } from './policy.ts';
export { gradeAll, gradeRequirement, questionsForGaps } from './grade.ts';
export { readTeamDefaults } from './team-defaults.ts';

/**
 * workshop: where a person sets up a bot by describing it (PLAN P7-02 to P7-04, SPEC section 9). A built-in helper (the profile in `templates/_setup/PROFILE.md`) looks at what the team has, the platform grades
 * every requirement of the brief, the person answers one batched list of questions, and the helper proposes the bot's files as proposals that a person approves. It changes nothing itself.
 * docs/plugins/workshop.md.
 */
export default definePlugin({
  manifest: {
    name: 'workshop',
    version: '0.1.0',
    kind: 'server',
    // `job.register`: a model call takes a minute and must not hold a request open (the handler is read like a migration, docs/plugins/security.md). `capability.call`: the helper's tools are
    // the platform's own `knowledge.search` and `proposals.propose`, called in the PERSON's transaction; the narrow door adds no actor.
    extends: ['job.register', 'capability.call'],
    calls: ['knowledge.search', 'proposals.propose'],
    // teams, channels and bots: the tables read for the inventory; proposals and knowledge: the capabilities the tools call; bot-runners: the placement question; gateway-llm: the model; repo-git: TEAM.md and the skills folder.
    dependsOn: ['teams', 'channels', 'bots', 'proposals', 'knowledge', 'bot-runners', 'gateway-llm', 'repo-git'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerSetupRoutes(ctx);
    registerSetupJob(ctx);
  },
});
