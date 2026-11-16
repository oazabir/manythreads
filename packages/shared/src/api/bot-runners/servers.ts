import { z } from 'zod';
import { BotServer, BotServerAgent, BotServerHost, BotServerName } from '../../entities/bot-server.ts';
import { BotServerId } from '../../ids.ts';
import { ProjectName } from '../../entities/project.ts';
import { BotSlug } from '../bots/pairing.ts';
import { TeamSlug } from '../teams/common.ts';
import { BotRunnerLabel } from '../../entities/bot-runner.ts';
import { BRIDGE_KEY_PATTERN, ENROL_CODE_PATTERN } from '../../runner/bridge-tunnel.ts';

// Enrolled servers (PLAN P26-13, docs/plans/agents-anywhere.md §5.1 and §5.4). An admin makes a server on the Runners page and gets one command with a one-time code;
// the installer redeems the code at `POST /api/bridge/enrol` and gets the bridge key, which is shown once and kept on the site as a hash.

export const BotServerPathParams = z.object({ id: BotServerId });

/** The installer the site serves: the hash of the script (so a broken download is noticed) and the bridge version the bundle holds. Null when this install has no bundle. */
export const BotServerInstall = z.object({
  scriptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bridgeVersion: z.string().max(40),
  /** Only a site with its own (self-signed) certificate: the hash the install command pins (`--ca-sha256`) and the key hash `curl --pinnedpubkey` takes. Absent for a site with a public certificate. */
  siteCert: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), spkiSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }).optional(),
});
export type BotServerInstall = z.infer<typeof BotServerInstall>;

export const ListBotServersResponse = z.object({ items: z.array(BotServer), install: BotServerInstall.nullable() });
export type ListBotServersResponse = z.infer<typeof ListBotServersResponse>;
export const listBotServersRoute = { method: 'GET', path: '/api/admin/bot-servers' } as const;

export const CreateBotServerRequest = z.strictObject({ name: BotServerName, label: BotRunnerLabel });
export type CreateBotServerRequest = z.infer<typeof CreateBotServerRequest>;

/** The code is shown once; only its hash is kept. */
export const BotServerCode = z.object({
  server: BotServer,
  code: z.string().regex(ENROL_CODE_PATTERN),
  expiresAt: z.string(),
  install: BotServerInstall.nullable(),
});
export type BotServerCode = z.infer<typeof BotServerCode>;
export const CreateBotServerResponse = BotServerCode;
export const createBotServerRoute = { method: 'POST', path: '/api/admin/bot-servers' } as const;

export const MintBotServerCodeResponse = BotServerCode;
export const mintBotServerCodeRoute = { method: 'POST', path: '/api/admin/bot-servers/:id/code' } as const;

export const RotateBotServerKeyResponse = z.object({ server: BotServer });
export type RotateBotServerKeyResponse = z.infer<typeof RotateBotServerKeyResponse>;
export const rotateBotServerKeyRoute = { method: 'POST', path: '/api/admin/bot-servers/:id/rotate-key' } as const;

export const DeleteBotServerResponse = z.object({ deleted: z.literal(true) });
export type DeleteBotServerResponse = z.infer<typeof DeleteBotServerResponse>;
export const deleteBotServerRoute = { method: 'DELETE', path: '/api/admin/bot-servers/:id' } as const;

/** What the installer says when it redeems the code. */
export const EnrolBridgeRequest = z.strictObject({
  code: z.string().regex(ENROL_CODE_PATTERN),
  bridgeVersion: z.string().max(40),
  host: BotServerHost,
  agents: z.array(BotServerAgent).max(8),
  allowFullAccess: z.boolean().default(false),
});
export type EnrolBridgeRequest = z.infer<typeof EnrolBridgeRequest>;
export const EnrolBridgeResponse = z.object({ serverId: BotServerId, name: BotServerName, key: z.string().regex(BRIDGE_KEY_PATTERN) });
export type EnrolBridgeResponse = z.infer<typeof EnrolBridgeResponse>;
export const enrolBridgeRoute = { method: 'POST', path: '/api/bridge/enrol' } as const;

/** The installer asks (with its key) whether the server has connected, so it can say so before it ends. */
export const BridgeStatusResponse = z.object({ status: z.enum(['waiting', 'connected', 'offline']), name: BotServerName });
export type BridgeStatusResponse = z.infer<typeof BridgeStatusResponse>;
export const bridgeStatusRoute = { method: 'GET', path: '/api/bridge/status' } as const;

/** The tunnel's address: a WebSocket upgrade with the bridge key as a bearer token (the frames are in `runner/bridge-tunnel.ts`). */
export const bridgeConnectRoute = { method: 'GET', path: '/api/bridge/connect' } as const;

/**
 * The installer's `--uninstall` tells the site the server is gone (with its key): the server and its runners are removed if no bot is placed on them; otherwise the
 * server stays (offline) and `removed` is false, so a person decides what the bots do.
 */
export const BridgeUninstallResponse = z.object({ removed: z.boolean() });
export type BridgeUninstallResponse = z.infer<typeof BridgeUninstallResponse>;
export const bridgeUninstallRoute = { method: 'POST', path: '/api/bridge/uninstall' } as const;

/**
 * The repositories a server's repo-sync step clones (PLAN P26-15, docs/plans/agents-anywhere.md section 5.6): one line per project of each team on the server's runners, for each bot of the team
 * placed on one of them. Asked with the bridge key. Only plain https addresses that start with an allowed prefix are listed (the same rule as for a pod), and no credential is in a line.
 */
export const BridgeReposResponse = z.object({
  repos: z
    .array(z.object({ team: TeamSlug, bot: BotSlug, project: ProjectName, branch: z.string().min(1).max(100).nullable(), origin: z.string().min(1).max(500) }))
    .max(2000),
});
export type BridgeReposResponse = z.infer<typeof BridgeReposResponse>;
export const bridgeReposRoute = { method: 'GET', path: '/api/bridge/repos' } as const;
