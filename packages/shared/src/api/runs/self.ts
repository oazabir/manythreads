import { z } from 'zod';
import { ProjectName } from '../../entities/project.ts';
import { RunId } from '../../ids.ts';
import { BotSlug } from '../bots/pairing.ts';
import { TeamSlug } from '../teams/common.ts';

// Who a run is (PLAN Bundle E, WP-R1, docs/plugins/claude-pods.md). The publisher container of a Claude or Codex pod presents the run's own token
// (`Authorization: Bearer <run token>`, the one the run already uses to call the platform's tools) and learns which team, bot and run it belongs to. The
// publisher takes the folder to publish from this answer and never from the caller's words. The answer holds no token and no address.

export const RunSelfResponse = z.object({
  teamSlug: TeamSlug,
  botSlug: BotSlug,
  runId: RunId,
  /** The bot's definition grants `tasks.pull_request`: only then may the run publish a branch. */
  mayPublish: z.boolean(),
});
export type RunSelfResponse = z.infer<typeof RunSelfResponse>;
export const runSelfRoute = { method: 'GET', path: '/api/runs/self' } as const;

// The push credential and the deployer's kubeconfig for a run on an enrolled server (PLAN P26-15, docs/plans/agents-anywhere.md section 5.6). The server's publisher (its own user, its own unit)
// and the server-mode bridge present the run's own token over HTTPS, exactly as the pod's publisher does for `/api/runs/self`. The answers are credentials: never cached, never logged.

export const PushCredentialQuery = z.object({ project: ProjectName });
export type PushCredentialQuery = z.infer<typeof PushCredentialQuery>;

/** The project's push document as `mt-publish.sh` reads it (the token is resolved: a project on its owner's token gets that token here). */
export const PushCredentialResponse = z.object({
  project: ProjectName,
  origin: z.string().min(1).max(500),
  branch: z.string().min(1).max(100),
  token: z.string().min(1).max(500),
  provider: z.enum(['github', 'gitlab']).optional(),
  login: z.string().max(255).optional(),
  userId: z.string().max(20).optional(),
  commitAs: z.enum(['bot', 'requester']).optional(),
  refused: z.boolean().optional(),
});
export type PushCredentialResponse = z.infer<typeof PushCredentialResponse>;
export const pushCredentialRoute = { method: 'GET', path: '/api/runs/self/push-credential' } as const;

/** The team's deployer login for the machine the server is (the host variant: its API address is the host's). Only the team's deployer bot is answered; any other bot gets 404. */
export const KubeconfigResponse = z.object({ kubeconfig: z.string().min(1).max(64_000) });
export type KubeconfigResponse = z.infer<typeof KubeconfigResponse>;
export const kubeconfigRoute = { method: 'GET', path: '/api/runs/self/kubeconfig' } as const;
