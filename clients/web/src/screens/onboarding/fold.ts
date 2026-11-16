import type { OnboardingStep } from './steps';

// Which step of the Setup wizard is open. No React here, so it is unit tested.
//
// One step is open at a time when the page opens: the one the address names (`?step=theme`), else the first required step that is still to do (so a person who
// comes back lands where they stopped), else the first optional one still to do, else none. The rest sit folded to one line. What a person opens or folds
// afterwards (`chosen`) wins, and a step that turns done while it is open stays open so its result is not taken from under them.

/** The id of the step to open when the page opens. */
export function stepOpenAtStart(steps: readonly Pick<OnboardingStep, 'id' | 'status' | 'optional'>[], requested: string | null): string | null {
  if (requested !== null && steps.some((s) => s.id === requested)) return requested;
  const todo = steps.filter((s) => s.status === 'todo');
  return (todo.find((s) => !s.optional) ?? todo[0])?.id ?? null;
}

export function isStepOpen(id: string, openAtStart: string | null, chosen: Readonly<Record<string, boolean>>): boolean {
  return chosen[id] ?? id === openAtStart;
}
