# onboarding

The first admin's setup checklist (PLAN P10-01, SPEC §16): nine steps from a fresh install to a first answer from Brain, shown as a card in the sidebar and as a wizard at `/onboarding` (Settings, Workspace, Setup). To use it you need to be a workspace owner or admin; nobody else sees the card, the page or the routes.

Package: `packages/plugins/onboarding`. Manifest: `extends: ['event.emit']`, emits `onboarding.step.marked`, `onboarding.goal.launched` and `onboarding.checklist.dismissed`. Schemas: `packages/shared/src/api/onboarding`, `packages/shared/src/events/onboarding.*.ts`.

## What it keeps, and what it does not

The plugin keeps only what a person decided or did. Everything else on the checklist is a fact, and a fact is read from the place that owns it each time the page opens, so a step cannot be green by default or from a click.

| Step | Done when | Where the fact lives |
|---|---|---|
| 0 Sign in as the workspace owner | always (you are signed in) | the session |
| 1 Sign-in methods | a single sign-on method is switched on, or an admin confirmed "passwords only" (a decision, recorded here) | identity-oidc, this plugin's mark |
| 2 Models | the `smart` or `fast` alias (the ones the shipped Brain asks for) answered a test call made after the alias and its provider were last saved | gateway-llm, `app.llm_alias_tests` |
| 3 Code | the first team has a project | projects |
| 4 Domain and HTTPS | the page is served over HTTPS | the browser's address |
| 5 Teams | one team exists | teams |
| 6 Bots | Brain is on the first team | bots |
| 7 Servers | the first team has a runner (a program on your own server that runs bots' commands there) | runners |
| 8 Your first goal | the first goal was sent to Brain | this plugin, `app.onboarding_state` |

Steps 3, 4 and 7 are optional: they never hold the checklist open, and an admin can set them aside with "We do not need this". A step whose fact is true cannot be set aside, and a fact always wins over a mark. The checklist is finished when every required step is done.

A plugin may not read another plugin's tables, so the browser assembles the facts from each owner's own routes (`clients/web/src/screens/onboarding/steps.ts`, pure and unit-tested) and this plugin stores only the decisions.

## What the database holds

| table | what it is |
|---|---|
| `app.onboarding_state` | one row per workspace: when and by whom the first goal was sent (with the team and the conversation channel), and when and by whom the checklist was put away. A row that says it was put away must also say a goal was sent (a CHECK). |
| `app.onboarding_marks` | one row per decision: `signin` is `acknowledged` (passwords only), `code`, `infrastructure` and `servers` are `skipped`. |

Both are readable and writable by workspace owners and admins only (row-level security: the database itself refuses anyone else). Migration `0001_onboarding.sql`.

## Routes

All under `/api/workspace/onboarding`, workspace owner or admin (`403` for a member):

| method | path | what |
|---|---|---|
| GET | `/` | `{ state }`: marks, the launch, the dismissal |
| PUT | `/marks/:step` | `{ kind }`: confirm password-only sign-in, or set an optional step aside. A repeat changes nothing |
| DELETE | `/marks/:step` | take the decision back |
| POST | `/launch` | `{ teamId, channelId }`: records the first goal. The first one wins; a repeat changes nothing and writes no second event |
| POST | `/dismiss` | puts the checklist away. `409` until a first goal was launched |

## The first goal

The wizard opens the person's conversation with Brain on the first team, posts their question as their own message, records the launch, and lands them in that thread (`/t/<team>/bots/brain/chat?thread=<message id>`). The question goes through the normal message path, so Brain answers like it would for anyone.

## Events and audit

Each change writes one event, only when something really changed: `onboarding.step.marked` (also when a mark is removed, with `kind: null`), `onboarding.goal.launched`, `onboarding.checklist.dismissed`. The audit console shows them as `setup.step_marked`, `setup.goal_launched` and `setup.checklist_dismissed` (category settings); rows carry ids and fixed phrases, never the question.

## Test servers start put away; the demo seed does not

`seedFinishedSetup` (test-utils) writes a launched and put-away row for the seeded workspace, so the sidebar card does not appear in the visual baselines. Only the two e2e test servers call it (`e2e/api/support/start-server.ts`, `e2e/fixtures/stack-server.ts`, not the empty stack). `createPersonas` does not, because `pnpm seed --demo` runs it on the live demo site, where the checklist must show the truth. A spec that wants a fresh install deletes both tables' rows first (`e2e/onboarding/onboarding-wizard.spec.ts`).

## Honest limits

- The launch is reported by the browser (ids only). The server checks the caller is an admin and that a launch exists before it lets the checklist be put away, but it does not verify the message was posted, because the messages table belongs to another plugin.
- The facts behind steps 1 and 3 to 7 are read by the browser, not recorded: a step can go from done back to not done (a deleted team, a removed Brain).
- Step 3 has no GitHub App or GitLab sign-in flow, step 4 has no generated Kubernetes manifest or `sshd_config` line with token and SSH checks, and step 7 has no install one-liner with a waiting indicator. The server has no code for any of them, so those rows report what exists and link to the page that does the work.

## Rules to keep

- A step turns done only from a fact. Never add a button that ticks a step.
- A check button re-reads facts; if nothing changed, the step stays as it was.
- A new decision the server should remember is a new `step` value: update the migration's CHECK, `OnboardingMarkStep` in `packages/shared` and `ENUM_COLUMNS` in `packages/kernel/test/schema-enums.test.ts` together.
