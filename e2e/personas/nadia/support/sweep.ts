// The states sweep and the Tab-walk as journey steps (PLAN P13-01): the same screen in its empty, error, loading and denied states, and the first 15 keyboard stops of a screen with
// the focus ring in the picture. Used by Nadia's and Sameera's `states/` and `tabwalk/` files.
import { expect, type Page } from '@playwright/test';
import type { StepDeclaration } from '../../harness/journey.ts';
import { failRequests, holdRequests, emptyRequests } from '../../harness/states.ts';
import { tabWalk, tabWalkProblems, type FocusStop } from '../../harness/tabwalk.ts';

export type StateKind = 'empty' | 'error' | 'loading' | 'denied' | 'natural';

export interface StateScreen {
  /** Step id: `<screen>-<state>`. */
  id: string;
  /** Where the person goes. */
  path: string;
  /** The landmark of the picture. `app-frame` is any screen. */
  expect: string;
  state: StateKind;
  /** The address pattern of the request that is forced (empty, error, loading). */
  pattern?: string | RegExp;
  /** The body an `empty` state answers with (default `{ items: [] }`). */
  emptyBody?: unknown;
  /** What must be on the screen for this state to be the one meant (a message, a testid). Checked before the picture. */
  see?: (page: Page) => Promise<void>;
  /** For `denied`: the status the server answers. For `error`: always 500. */
  status?: number;
}

type Undo = () => Promise<void>;

/** Steps of one sweep. The forced answers of a step are removed at the start of the next one (and by `finish`). */
export function statesSweep(screens: readonly StateScreen[]): { steps: StepDeclaration[]; finish: () => Promise<void> } {
  const undo: Undo[] = [];
  const clean = async (): Promise<void> => {
    for (const u of undo.splice(0).reverse()) await u().catch(() => undefined);
  };
  const steps: StepDeclaration[] = screens.map((s) => ({
    id: s.id,
    expect: s.expect,
    ...(s.state === 'error' ? { expectDenied: s.status ?? 500 } : {}),
    ...(s.state === 'denied' && s.status ? { expectDenied: s.status } : {}),
    ...(s.state === 'loading' ? { loading: true } : {}),
    run: async ({ page }) => {
      await clean();
      if (s.state === 'error' && s.pattern) undo.push(await failRequests(page, s.pattern, s.status ?? 500));
      if (s.state === 'empty' && s.pattern) undo.push(await emptyRequests(page, s.pattern, s.emptyBody));
      if (s.state === 'loading' && s.pattern) {
        const held = await holdRequests(page, s.pattern);
        undo.push(held.release);
      }
      await page.goto(s.path);
      if (s.see) await s.see(page);
    },
  }));
  return { steps, finish: clean };
}

/** The screens a Tab-walk visits: where, the landmark that says it is up, and the stop it must reach first (optional). */
export interface WalkScreen {
  id: string;
  path: string;
  expect: string;
}

/**
 * What a walk of one screen found, by step id: the stops (first 15) and the problems the helper lists. A journey asserts that the problems are exactly the ones it knows about
 * (`known`), with the cause written next to them, so a fixed defect makes the journey say its list is out of date and a new one fails it.
 */
export function tabWalkSteps(
  screens: readonly WalkScreen[],
  known: Readonly<Record<string, readonly string[]>> = {},
): { steps: StepDeclaration[]; results: Map<string, { stops: FocusStop[]; problems: string[] }>; check: () => void } {
  const results = new Map<string, { stops: FocusStop[]; problems: string[] }>();
  const steps: StepDeclaration[] = screens.map((s) => ({
    id: s.id,
    expect: s.expect,
    run: async ({ page }) => {
      await page.goto(s.path);
      await expect(page.locator(`[data-landmark=${JSON.stringify(s.expect)}],[data-testid=${JSON.stringify(s.expect)}]`).first()).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      // Chromium goes on from where focus last was, even after a blur (the Chat screen focuses its message box on load, so the first Tab would land after it and the walk
      // would end at the end of the document): put the starting point at the very top with a throw-away element
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        const mark = document.createElement('span');
        mark.tabIndex = -1;
        document.body.prepend(mark);
        mark.focus();
        mark.remove();
      });
      const stops = await tabWalk(page, { max: 15 });
      results.set(s.id, { stops, problems: tabWalkProblems(stops) });
    },
  }));
  const check = (): void => {
    for (const s of screens) {
      const r = results.get(s.id);
      expect(r, `${s.id}: the walk ran`).toBeTruthy();
      expect(r!.stops.length, `${s.id}: the walk reached stops (${r!.stops.map((x) => `${x.id}[${x.name}]`).join(', ')})`).toBeGreaterThanOrEqual(5);
      expect(r!.problems, `${s.id}: keyboard problems (list the cause in the journey's known list)`).toEqual([...(known[s.id] ?? [])]);
    }
  };
  return { steps, results, check };
}
