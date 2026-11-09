// Runs one journey on one viewport: do each step, take its picture, record how it went (PLAN P12-01).
import type { Browser, PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../../fixtures/stack.ts';
import { resolvePersona, type JourneyDeclaration, type StepDeclaration } from './journey.ts';
import { clearJourney, recordResult, type JourneyResult, type StepStatus } from './manifest.ts';
import { openJourney, type JourneySession } from './persona.ts';
import { shot } from './shot.ts';

export interface RunOptions {
  /** Every journey of the persona (numbering depends on all of them, not only this one). */
  all: readonly JourneyDeclaration[];
  journey: JourneyDeclaration;
  kind: 'desktop' | 'mobile';
  stack: Stack;
  browser: Browser;
  playwright: PlaywrightWorkerArgs['playwright'];
  root: string;
  /**
   * Keep going after a failed step and record every failure (the canary run needs to know all the steps that fail, not only the first). The journey is still
   * `failed`; the caller decides whether to throw.
   */
  continueOnFailure?: boolean;
  /** Opens the windows of the journey (default: `openJourney`, which signs the persona in on the stack). A test seam: a unit test hands in a page of its own. */
  open?: () => Promise<JourneySession>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runJourney(options: RunOptions): Promise<JourneyResult> {
  const { journey, kind, root } = options;
  const resolved = resolvePersona(options.all, journey.persona).filter((s) => s.journeyId === journey.id);
  const started = Date.now();
  const steps: Record<string, StepStatus> = {};
  const errors: string[] = [];
  const finish = (status: JourneyResult['status']): JourneyResult => {
    const result: JourneyResult = {
      persona: journey.persona,
      journey: journey.id,
      kind,
      status,
      durationMs: Date.now() - started,
      steps,
      ...(errors.length > 0 ? { error: errors.join('\n') } : {}),
    };
    recordResult(root, result);
    return result;
  };
  clearJourney(root, journey.persona, journey.id, kind);
  if (journey.pending !== undefined) {
    for (const s of journey.steps) steps[s.id] = 'pending';
    return finish('pending');
  }
  const session = options.open
    ? await options.open()
    : await openJourney(options.browser, options.playwright, options.stack, journey.persona, kind, { empty: journey.start === 'empty' });
  let failed = false;
  try {
    for (const declared of journey.steps) {
      const step = resolved.find((r) => r.id === declared.id)!;
      if (step.pending !== undefined) {
        steps[declared.id] = 'pending';
        continue;
      }
      if (failed && !options.continueOnFailure) {
        steps[declared.id] = 'not-run';
        continue;
      }
      try {
        await doStep(declared, session.ctx);
        await shot(session.ctx.page, step, { kind, root });
        steps[declared.id] = 'passed';
      } catch (e) {
        failed = true;
        steps[declared.id] = 'failed';
        errors.push(`${journey.persona}/${journey.id}/${declared.id} (${kind}): ${message(e)}`);
      }
    }
    if (!failed && journey.outcome) {
      try {
        await journey.outcome(session.ctx);
      } catch (e) {
        failed = true;
        errors.push(`${journey.persona}/${journey.id} outcome (${kind}): ${message(e)}`);
      }
    }
  } finally {
    await session.close();
  }
  return finish(failed ? 'failed' : 'passed');
}

/** The most one step may take (its own waits are 20 s each; this stops a step that loops). */
export const STEP_BUDGET_MS = 90_000;

async function doStep(step: StepDeclaration, ctx: Parameters<NonNullable<StepDeclaration['run']>>[0]): Promise<void> {
  if (!step.run) return;
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the step "${step.id}" took more than ${STEP_BUDGET_MS / 1000} s`)), STEP_BUDGET_MS);
  });
  try {
    await Promise.race([step.run(ctx), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
