import type { OnboardingStep } from './steps';

// Which steps of the Setup page are folded to one line. No React here, so it is unit tested.

/** The steps that were already handled (done, or set aside) when the page opened. */
export function collapsedAtStart(steps: readonly Pick<OnboardingStep, 'id' | 'status'>[]): ReadonlySet<string> {
  return new Set(steps.filter((s) => s.status !== 'todo').map((s) => s.id));
}

/** A step is open unless it was handled when the page opened; a person's own choice (`chosen`) wins either way. */
export function isStepOpen(id: string, foldedAtStart: ReadonlySet<string>, chosen: Readonly<Record<string, boolean>>): boolean {
  return chosen[id] ?? !foldedAtStart.has(id);
}
