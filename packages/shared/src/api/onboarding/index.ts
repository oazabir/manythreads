import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, ChannelId, TeamId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Workspace → Setup (PLAN P10-01): the first admin's checklist, from a fresh install to a first working bot. Only the few facts that nothing else in the
// product already records live here: that the first goal was sent, that an optional step was set aside on purpose, that the person said sign-in is
// password only, and that the checklist was put away. Every other step (a model that answers, a team, Brain on it) is read from the pages that own
// it, so it cannot go stale or be ticked by a click. Workspace owners and admins only; anyone else gets 403.

/** The nine steps in the order the wizard shows them (numbered 0 to 8 on screen). */
export const ONBOARDING_STEPS = ['bootstrap', 'signin', 'models', 'code', 'infrastructure', 'teams', 'bots', 'servers', 'launch'] as const;
export const OnboardingStep = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

/** The steps a person may set aside or confirm. A model, a team and Brain are facts, so they are never marked. */
export const OnboardingMarkStep = z.enum(['signin', 'code', 'infrastructure', 'servers']);
export type OnboardingMarkStep = z.infer<typeof OnboardingMarkStep>;

/** `skipped`: an optional step the team does not need (code, infrastructure, servers). `acknowledged`: "sign-in is password only", the one way to finish step 1 without a single-sign-on provider. */
export const OnboardingMarkKind = z.enum(['skipped', 'acknowledged']);
export type OnboardingMarkKind = z.infer<typeof OnboardingMarkKind>;

export const OnboardingMark = z.object({
  step: OnboardingMarkStep,
  kind: OnboardingMarkKind,
  markedAt: IsoDateTime,
  markedBy: ActorId.nullable(),
});
export type OnboardingMark = z.infer<typeof OnboardingMark>;

/** The first goal: the person's message to Brain was sent. Only ids, never the text. */
export const OnboardingLaunch = z.object({
  at: IsoDateTime,
  by: ActorId.nullable(),
  teamId: TeamId,
  channelId: ChannelId,
});
export type OnboardingLaunch = z.infer<typeof OnboardingLaunch>;

export const OnboardingState = z.object({
  marks: z.array(OnboardingMark),
  launch: OnboardingLaunch.nullable(),
  dismissedAt: IsoDateTime.nullable(),
  dismissedBy: ActorId.nullable(),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

export const OnboardingStateResponse = z.object({ state: OnboardingState });
export type OnboardingStateResponse = z.infer<typeof OnboardingStateResponse>;

export const OnboardingStepPathParams = z.object({ step: OnboardingMarkStep });
export type OnboardingStepPathParams = z.infer<typeof OnboardingStepPathParams>;

export const SetOnboardingMarkRequest = z.object({ kind: OnboardingMarkKind }).strict();
export type SetOnboardingMarkRequest = z.infer<typeof SetOnboardingMarkRequest>;

export const LaunchOnboardingRequest = z.object({ teamId: TeamId, channelId: ChannelId }).strict();
export type LaunchOnboardingRequest = z.infer<typeof LaunchOnboardingRequest>;

export const getOnboardingRoute = { method: 'GET', path: '/api/workspace/onboarding' } as const satisfies ApiRoute;
export const setOnboardingMarkRoute = { method: 'PUT', path: '/api/workspace/onboarding/marks/:step' } as const satisfies ApiRoute;
export const clearOnboardingMarkRoute = { method: 'DELETE', path: '/api/workspace/onboarding/marks/:step' } as const satisfies ApiRoute;
export const launchOnboardingRoute = { method: 'POST', path: '/api/workspace/onboarding/launch' } as const satisfies ApiRoute;
export const dismissOnboardingRoute = { method: 'POST', path: '/api/workspace/onboarding/dismiss' } as const satisfies ApiRoute;
