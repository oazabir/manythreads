# onboarding

The first admin's setup checklist (PLAN P10-01, SPEC §16): thirteen steps from a fresh install to a first delivery by bots (Phase 27, `docs/plans/onboarding-journey.md`), shown as a card in the sidebar and as a wizard at `/onboarding` (Settings, Workspace, Setup). To use it you need to be a workspace owner or admin; nobody else sees the card, the page or the routes.

Package: `packages/plugins/onboarding`. Manifest: `extends: ['event.emit']`, emits `onboarding.step.marked`, `onboarding.goal.launched` and `onboarding.checklist.dismissed`. Schemas: `packages/shared/src/api/onboarding`, `packages/shared/src/events/onboarding.*.ts`.

## What it keeps, and what it does not

The plugin keeps only what a person decided or did. Everything else on the checklist is a fact, and a fact is read from the place that owns it each time the page opens, so a step cannot be green by default or from a click.

| Step | Done when | Where the fact lives |
|---|---|---|
| 0 Your sign-in | always (you are signed in) | the session |
| 1 Pick a look (optional) | the admin's own palette is not Classic, or they chose to keep Classic (a confirmation, recorded here) | the session's appearance, this plugin's mark |
| 2 Your organization | the workspace name is no longer the install's default "My organization"; the step also sets the short name and the time zone | workspace settings |
| 3 Address and HTTPS (optional) | the page is served over HTTPS; otherwise the step shows the address and `sudo manythreads set-domain <name>` | the browser's address |
| 4 Models | the `smart` alias (the one the shipped Brain asks for) answered a test call made after the alias and its provider were last saved. The step binds `smart`, `fast` and `code` from a preset (`LLM_PRESETS` in `packages/shared/src/api/llm/presets.ts`): a provider key, a coding plan (address plus key) or a local model, with a monthly spending limit | gateway-llm, `app.llm_alias_tests` |
| 5 Sign-in methods (optional) | a single sign-on method is switched on, or an admin confirmed "passwords only" | identity-oidc, this plugin's mark |
| 6 Teams | one team exists. Every template is shown and ticked; the admin unticks what they do not want | teams |
| 7 Servers (optional) | a server is connected, or a team runner exists. The step makes the one-line enrol command | bot-runners, runners |
| 8 Runners | **a runner the wizard proved**: an enabled, ready runner that answered a real question asked through a bot. The wizard records that proof as a `checked` mark with the runner's id; the step is done only while that runner is still enabled and ready | this plugin's mark, bot-runners |
| 9 Where bots run | Brain is on a team and a runner is the workspace default | bots, bot-runners |
| 10 Code (optional) | the first team has a project | projects |
| 11 Check that Brain answers | the question was sent and a run in its thread ended with an answer (the launch record carries the thread's message id) | this plugin, `app.onboarding_state`, runs |
| 12 A first delivery (optional) | a task of a team has a pull request created after the `started` mark | tasks, this plugin's mark |

**A working runner is required (owner decision 2026-11-16).** Without a runner no bot can run, so the wizard does not let the admin finish with none: step 8 is required, and a ready runner alone does not satisfy it, only one that answered a real question. When no runner exists, the step offers to deploy a Hermes pod (a small program in the site's own cluster that runs bots on the models of step 4). Its model credentials are the same preset form as step 4: an API key or a coding plan, saved on LiteLLM as the aliases the pod uses. The wizard creates the runner, makes it the default, asks Brain a test question, waits for the answer and only then records the proof. A failure is shown in one sentence with a retry. This replaces plan decision 7 (Brain on the `models` runner) for a fresh install.

Steps 1, 3, 5, 7, 10 and 12 are optional: they never hold the checklist open, and an admin can set them aside ("We do not need this"). A step whose fact is true cannot be set aside, and a fact always wins over a mark. The checklist is finished when every required step (0, 2, 4, 6, 8, 9, 11) is done.

The wizard opens one step at a time: the one named in `?step=<id>`, else the first required step still to do, so a person who comes back lands where they stopped. "Continue" opens the next step.

A plugin may not read another plugin's tables, so the browser assembles the facts from each owner's own routes (`clients/web/src/screens/onboarding/steps.ts`, pure and unit-tested) and this plugin stores only the decisions.

## What the database holds

| table | what it is |
|---|---|
| `app.onboarding_state` | one row per workspace: when and by whom the first goal was sent (with the team, the conversation channel and the message the wizard watches for the answer), and when and by whom the checklist was put away. A row that says it was put away must also say a goal was sent (a CHECK). |
| `app.onboarding_marks` | one row per decision or proof. `signin` and `theme` are `acknowledged`; `code`, `infrastructure`, `servers` and `delivery` can be `skipped`; `runners` is `checked` with the id of the runner that answered; `delivery` can be `started` with the id of the message that started it. A decision keeps its first record; a proof or a start keeps the latest. A CHECK ties each step to the kinds it takes and to having (or not having) a `ref_id`. |

Both are readable and writable by workspace owners and admins only (row-level security: the database itself refuses anyone else). Migrations `0001_onboarding.sql` and `0002_wizard_steps.sql` (the new steps and kinds, `ref_id`, `launch_message_id`).

## Routes

All under `/api/workspace/onboarding`, workspace owner or admin (`403` for a member):

| method | path | what |
|---|---|---|
| GET | `/` | `{ state }`: marks, the launch, the dismissal |
| PUT | `/marks/:step` | `{ kind, refId? }`: confirm (sign-in, theme), set an optional step aside, record a proof (`checked` plus the runner id) or a start (`started` plus the message id). A repeat of a decision changes nothing; a proof for a different runner replaces the first |
| DELETE | `/marks/:step` | take the decision back |
| POST | `/launch` | `{ teamId, channelId, messageId? }`: records the first goal. The first one wins and writes the one event; a later call with a new `messageId` only moves the thread the wizard watches, until the checklist is put away |
| POST | `/dismiss` | puts the checklist away. `409` until a first goal was launched |

## The first goal

The wizard opens the person's conversation with Brain on the first team, posts their question as their own message, records the launch, and lands them in that thread (`/t/<team>/bots/brain/chat?thread=<message id>`). The question goes through the normal message path, so Brain answers like it would for anyone.

## Events and audit

Each change writes one event, only when something really changed: `onboarding.step.marked` (also when a mark is removed, with `kind: null`), `onboarding.goal.launched`, `onboarding.checklist.dismissed`. The audit console shows them as `setup.step_marked`, `setup.goal_launched` and `setup.checklist_dismissed` (category settings); rows carry ids and fixed phrases, never the question.

## Test servers start put away; the demo seed does not

`seedFinishedSetup` (test-utils) writes a launched and put-away row for the seeded workspace, so the sidebar card does not appear in the visual baselines. Only the two e2e test servers call it (`e2e/api/support/start-server.ts`, `e2e/fixtures/stack-server.ts`, not the empty stack). `createPersonas` does not, because `pnpm seed --demo` runs it on the live demo site, where the checklist must show the truth. A spec that wants a fresh install deletes both tables' rows first (`e2e/onboarding/onboarding-wizard.spec.ts`).

## Honest limits

- The launch is reported by the browser (ids only). The server checks the caller is an admin and that a launch exists before it lets the checklist be put away, but it does not verify the message was posted, because the messages table belongs to another plugin.
- The facts behind most steps are read by the browser, not recorded: a step can go from done back to not done (a deleted team, a removed Brain, a runner switched off after it answered).
- The runner proof is checked by the server before it is stored (a screen is not a gate). `PUT /marks/runners` with `checked` and a runner id answers `409` unless the runner exists in this workspace, is of a kind the wizard can try (`hermes_gateway`, `hermes_pod`), is enabled and `ready`, is the workspace default (the place bots run), and the caller has a real test answer: a rehearsal question the caller asked, a finished rehearsal run that started after the runner was made, and a reply in that thread from someone else. `POST /dismiss` also needs a `checked` runner mark whose runner is still enabled and ready. The server does not re-ask the runner itself.
- The wizard makes its Hermes pod runner for every team (`teams: { all: true }`): a pod runner made for no team is used by no team and no pod would ever be made (`hermes-pods/test/wizard-deploy.test.ts` runs the action against the in-memory Kubernetes stand-in and shows the mark refused before a test answer and accepted after).
- The address and HTTPS step shows the address and the command to move to an own domain; it has no server route that changes the domain, because that is the host command's job (`manythreads set-domain`).
- The Code step creates the project from an address, but the access token is entered on the Projects page.
- The first delivery needs the Engineering team, a project with a token and the chain's bots on a working runner; it is optional for that reason.

## Rules to keep

- A step turns done only from a fact. Never add a button that ticks a step.
- A check button re-reads facts; if nothing changed, the step stays as it was.
- A new decision or proof the server should remember is a new `step` value: update the migration's CHECK, `OnboardingMarkStep` in `packages/shared` and `ENUM_COLUMNS` in `packages/kernel/test/schema-enums.test.ts` together.
