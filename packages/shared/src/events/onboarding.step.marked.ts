import { z } from 'zod';
import { OnboardingMarkKind, OnboardingMarkStep } from '../api/onboarding/index.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/** An admin set an optional setup step aside, confirmed "password only" sign-in, or took that back (`kind` null). Ids and short codes only. */
export const OnboardingStepMarkedEvent = z.object({
  type: z.literal('onboarding.step.marked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  step: OnboardingMarkStep,
  kind: OnboardingMarkKind.nullable(),
  markedBy: ActorId,
  at: IsoDateTime,
});
export type OnboardingStepMarkedEvent = z.infer<typeof OnboardingStepMarkedEvent>;
