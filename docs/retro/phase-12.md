# Phase 12: the persona harness (P12-01, P12-02, P12-04)

What was built, how to use it, and what to watch. The journeys themselves (P12-03) are written on top of this; one short example journey proves the harness.

## What exists

| Piece | Where |
|---|---|
| Journey declaration, numbering, plan rules | `e2e/personas/harness/journey.ts` |
| `shot()` and the `onShot` hook | `e2e/personas/harness/shot.ts` |
| Windows, sign-in, colleagues in a second window | `e2e/personas/harness/persona.ts` |
| Running a journey, results | `e2e/personas/harness/run.ts`, `register.ts` |
| Manifest, results, run log | `manifest.ts`, `runlog.ts`, `docs/journeys/manifest.schema.json` |
| Completeness check | `completeness.ts`, `e2e/personas/completeness.spec.ts` |
| Journey-set rules | `e2e/personas/journeys.meta.spec.ts` |
| Keyboard walk, states sweep helpers | `tabwalk.ts`, `states.ts` |
| Page objects | `e2e/pages/` (`Pages` in `index.ts`, ids in `testids.ts`) |
| Saved starting points | `tools/seed/` (`snapshot` command) |
| Ready marker | `clients/web/src/api/ready.ts` (`data-ready` on the page) |
| Canary | `VITE_MANYTHREADS_CANARY`, `tools/review/canary.sh` |

## Writing a journey

A journey is the file `e2e/personas/<persona>/<id>-<slug>.journey.ts`. It default-exports `defineJourney({...})`:

```ts
export default defineJourney({
  id: 'N2', persona: 'nadia', goal: 'One sentence in her words.',
  markers: ['B'],                    // B: a Brain question, A: an acting bot; empty for a journey of refusals
  start: 'week-2',                   // 'day-1' | 'week-2' | 'empty'
  steps: [
    { id: 'open-dev', expect: 'channel-view', next: { testid: 'composer', label: 'Message box' },
      run: async ({ pages }) => { await pages.channel.open('dev'); } },
    // pending: { id: 'mail-door', expect: 'x', pending: 'P8-19' }   a feature not built yet: counted, no picture, fails nothing
    // denied:  { ..., expectDenied: 403 }                             the picture proves a refusal
  ],
  outcome: async (ctx) => { /* the result, not the last picture */ },
});
```

Every step does something (`run`), then `shot()` checks the landmark in `expect`, waits for the screen to settle and writes
`docs/journeys/<persona>/[mobile/]NN-<journey>-<step>.png`. `NN` counts the persona's built steps in journey-id order, so a step built later does not renumber
the earlier ones. Five pictures per journey, or say why with `fewerShots`.

Run one persona: `cd e2e && npx playwright test --project=personas-desktop --grep @omar`, then `--project=personas-mobile-web`. Then
`--project=personas-meta` for the completeness and journey-set checks. One shard at a time: each starts a stack on the one shared Postgres.
`MANYTHREADS_JOURNEY_SET=example` runs the harness example instead (pictures in `docs/journeys/_example`).

## Starting points

`pnpm --filter @manythreads/tools-seed snapshot build all` saves two databases and their folders (`day-1`, `week-2`) in `~/.cache/manythreads/snapshots`.
A stack with `MANYTHREADS_STACK_SNAPSHOT=week-2` copies one in about a third of a second. The saved copy is named after a hash of the migrations, the seed
sources and the recipes; a stale copy is refused with the command that rebuilds it. `snapshot list`, `snapshot prune` and `snapshot hash` are there too.

## The canary

A web build with the message box hidden must fail exactly the steps that use the message box (the flag is derived from `expect` and `next`, or set with
`composer`). `tools/review/canary.sh` builds it into `clients/web/dist-canary`, runs the example journeys against it, compares, then runs them on the normal
build, deletes one picture and requires the completeness check to fail and to name it. Exit 0 only when all of that holds. The canary branch is
compiled out of a normal build; `clients/web/test/canary-build.test.ts` builds both and reads the files.

## Watch for

- A picture is taken only after `data-ready` is true: no request for 300 ms, fonts loaded, no `aria-busy`. A screen that keeps asking the server never settles;
  fix the screen, do not raise the timeout. A step that shows a loading state on purpose sets `loading: true`.
- `shot()` fails on a console error, a failed request or a 4xx/5xx. The browser prints a refusal as a console error too, so a refusal step sets `expectDenied`.
- Journeys of one persona share a stack and run in id order. A journey that must not see another's posts says so in its `stackEnv` (its own stack).
