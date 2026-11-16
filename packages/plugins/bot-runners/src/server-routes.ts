import { createHash, X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conflict, createLockout, guardRedemption, HttpError, json, notFound, route, type HttpRequest, type HttpResponse, type Lockout, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  BotServerCode,
  BotServerPathParams,
  BridgeReposResponse,
  BridgeStatusResponse,
  BridgeUninstallResponse,
  CreateBotServerRequest,
  CreateBotServerResponse,
  DeleteBotServerResponse,
  EnrolBridgeRequest,
  EnrolBridgeResponse,
  ListBotServersResponse,
  MintBotServerCodeResponse,
  RotateBotServerKeyResponse,
  abuseLimit,
  isRepoOriginAllowed,
  parseRepoOriginAllow,
  TUNNEL_MAX_FRAME_BYTES,
  bridgeConnectRoute,
  bridgeReposRoute,
  bridgeStatusRoute,
  bridgeUninstallRoute,
  createBotServerRoute,
  deleteBotServerRoute,
  enrolBridgeRoute,
  listBotServersRoute,
  mintBotServerCodeRoute,
  rotateBotServerKeyRoute,
  type BotServer,
  type BotServerInstall,
} from '@manythreads/shared';
import { requireWorkspaceAdmin } from './common.ts';
import { placementsOf } from './rows.ts';
import { allRunnerNamesOf, SERVER_SELECT, syncServerRunners, toBotServer, type ServerRow } from './servers.ts';
import { bearerBridgeKey, hashSecret, newBridgeKey, newEnrolCode } from './tunnel/keys.ts';
import type { TunnelRegistry } from './tunnel/registry.ts';
import { serveBridgeSocket, type BridgeSocketOptions } from './tunnel/socket.ts';

// The enrolled servers' routes (PLAN P26-12 and P26-13, docs/plans/agents-anywhere.md §5):
//   admin   list, add (makes the one-time code), make a new code, rotate the key, remove
//   public  the installer's `enrol` (the code is the credential), `status` and `uninstall` (the bridge key is), and the tunnel's `connect` (a WebSocket)
//   public  `/install/<file>`: the script and the bundle the installer downloads, served from a folder the image build fills
// A key and a code are made here, shown once and kept as SHA-256 hashes (tunnel/keys.ts); no event, audit line or log line carries one.

const READ_LIMIT = { limit: 120, windowMs: 60_000 };
const FIFTEEN_MINUTES = 15 * 60_000;
export const ENROL_CODE_MINUTES = 15;

// --- The installer files ------------------------------------------------------------------------------------------------------------------------------

/** The folder the image build puts the script and the bundle in (`tools/agent-bridge/install/build.mjs`). `MANYTHREADS_BRIDGE_INSTALL_DIR` overrides it (tests). */
export const installDir = (): string => process.env['MANYTHREADS_BRIDGE_INSTALL_DIR'] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'install-dist');

interface InstallManifest {
  bridgeVersion: string;
  bundle: string;
  bundleSha256: string;
}

export interface InstallFiles extends BotServerInstall {
  script: string;
  bundle: string;
  bundlePath: string;
  bundleSha256: string;
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,38}$/;

let cache: { key: string; at: number; value: InstallFiles | null } | null = null;

/** The installer as this site serves it, or null when the image has none (a dev server). The script carries this site's address, so its hash is taken after that. */
export async function loadInstall(publicUrl: string, dir: string = installDir()): Promise<InstallFiles | null> {
  const key = `${dir}\n${publicUrl}`;
  if (cache && cache.key === key && Date.now() - cache.at < 5_000) return cache.value;
  let value: InstallFiles | null = null;
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Partial<InstallManifest>;
    if (typeof manifest.bridgeVersion === 'string' && VERSION.test(manifest.bridgeVersion) && manifest.bundle === `bridge-${manifest.bridgeVersion}.tgz` && typeof manifest.bundleSha256 === 'string' && /^[0-9a-f]{64}$/.test(manifest.bundleSha256)) {
      const template = await readFile(join(dir, 'bridge.sh'), 'utf8');
      const script = template.split('@@SITE@@').join(publicUrl.replace(/\/+$/, '')).split('@@BUNDLE_SHA256@@').join(manifest.bundleSha256).split('@@BRIDGE_VERSION@@').join(manifest.bridgeVersion);
      value = {
        script,
        scriptSha256: createHash('sha256').update(script, 'utf8').digest('hex'),
        bridgeVersion: manifest.bridgeVersion,
        bundle: manifest.bundle,
        bundlePath: join(dir, manifest.bundle),
        bundleSha256: manifest.bundleSha256,
      };
    }
  } catch {
    value = null;
  }
  cache = { key, at: Date.now(), value };
  return value;
}

export interface InstallScripts {
  /** install.sh as this site serves it: the line `DEFAULT_RELEASE_URL=''` carries the address of release.json when the operator set `MANYTHREADS_RELEASE_URL`. */
  script: string;
  scriptSha256: string;
  /** The `manythreads` command (the host command of an installed site), as built into the image. */
  hostCommand: string;
  hostCommandSha256: string;
}

let scriptsCache: { key: string; at: number; value: InstallScripts | null } | null = null;

/** The one-command installer (deploy/install/install.sh) and the host command, from the same folder as the bridge installer. Null when the image has none (a dev server). */
export async function loadInstallScripts(releaseUrl: string = process.env['MANYTHREADS_RELEASE_URL'] ?? '', dir: string = installDir()): Promise<InstallScripts | null> {
  const key = `${dir}\n${releaseUrl}`;
  if (scriptsCache && scriptsCache.key === key && Date.now() - scriptsCache.at < 5_000) return scriptsCache.value;
  let value: InstallScripts | null = null;
  try {
    const template = await readFile(join(dir, 'install.sh'), 'utf8');
    const hostCommand = await readFile(join(dir, 'manythreads'), 'utf8');
    // only an https address (or none) goes into the script: it is read by `bash` on somebody's machine
    const url = /^https:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]{1,500}$/.test(releaseUrl) && !releaseUrl.includes("'") ? releaseUrl : '';
    const script = url === '' ? template : template.replace("DEFAULT_RELEASE_URL=''", `DEFAULT_RELEASE_URL='${url}'`);
    value = {
      script,
      scriptSha256: createHash('sha256').update(script, 'utf8').digest('hex'),
      hostCommand,
      hostCommandSha256: createHash('sha256').update(hostCommand, 'utf8').digest('hex'),
    };
  } catch {
    value = null;
  }
  scriptsCache = { key, at: Date.now(), value };
  return value;
}

/**
 * The certificate this site shows, when the chart mounts it (tls.mode=selfsigned: the Secret `manythreads-tls`, at MANYTHREADS_SITE_CERT_FILE). The hash of the whole
 * certificate goes to `bridge.sh --ca-sha256`; the hash of its public key goes to `curl --pinnedpubkey` for the download of the script itself. Null for a site with a public
 * certificate (the machine's own trust list already covers it) and while the certificate is not yet issued.
 */
export async function loadSiteCert(file: string | undefined = process.env['MANYTHREADS_SITE_CERT_FILE']): Promise<BotServerInstall['siteCert'] | null> {
  if (file === undefined || file === '') return null;
  try {
    const cert = new X509Certificate(await readFile(file));
    return {
      sha256: createHash('sha256').update(cert.raw).digest('hex'),
      spkiSha256: createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
    };
  } catch {
    return null;
  }
}

const installInfo = async (f: InstallFiles | null): Promise<BotServerInstall | null> => {
  if (f === null) return null;
  const siteCert = await loadSiteCert();
  return { scriptSha256: f.scriptSha256, bridgeVersion: f.bridgeVersion, ...(siteCert ? { siteCert } : {}) };
};

// --- The server routes -------------------------------------------------------------------------------------------------------------------------------

export interface ServerRoutesDeps {
  ctx: PluginContext;
  registry: TunnelRegistry;
  /** Handed to the tunnel's socket. */
  socket: Omit<BridgeSocketOptions, 'ctx' | 'registry' | 'lock'>;
}

async function loadServer(tx: PluginTx, id: string, lock = false): Promise<ServerRow> {
  const row = (await tx.query<ServerRow>(`SELECT ${SERVER_SELECT} WHERE s.id = $1::uuid${lock ? ' FOR UPDATE OF s' : ''}`, [id])).rows[0];
  if (!row) throw notFound('No such server');
  return row;
}

/** The server a bearer key belongs to (system transaction). A key that does not open anything counts against the client address. */
async function serverOfKey(ctx: PluginContext, lock: Lockout, req: HttpRequest): Promise<ServerRow> {
  const check = lock.check(req.ip);
  if (check.locked) throw new HttpError(429, 'rate_limited', 'Too many refused keys. Wait and try again.', { 'retry-after': String(Math.max(1, Math.ceil(check.retryAfterMs / 1000))) });
  const key = bearerBridgeKey(req.headers['authorization']);
  const row = key === null ? undefined : await ctx.db.system(async (tx) => (await tx.query<ServerRow>(`SELECT ${SERVER_SELECT} WHERE s.key_hash = $1 OR s.pending_key_hash = $1`, [hashSecret(key)])).rows[0]);
  if (!row) {
    lock.fail(req.ip);
    throw new HttpError(401, 'unauthenticated', 'That key is not accepted.');
  }
  return row;
}

export function registerServerRoutes(deps: ServerRoutesDeps): void {
  const { ctx, registry } = deps;
  const now = (): Date => ctx.runtime.now();
  // Wrong codes and wrong keys, per client address: ten in fifteen minutes lock the address for fifteen minutes (docs/deploy/rate-limits.md).
  const enrolLock = createLockout({ now, max: 10, windowMs: FIFTEEN_MINUTES, lockMs: FIFTEEN_MINUTES });
  const keyLock = createLockout({ now, max: 10, windowMs: FIFTEEN_MINUTES, lockMs: FIFTEEN_MINUTES });
  const present = (row: ServerRow): BotServer => toBotServer(row, registry.get(row.id) !== undefined, now().getTime());

  // The admin's list: servers and the installer's hash.
  ctx.http.route({
    method: listBotServersRoute.method,
    path: listBotServersRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: ListBotServersResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const rows = await tx.query<ServerRow>(`SELECT ${SERVER_SELECT} WHERE s.workspace_id = $1::uuid ORDER BY s.name`, [tx.actor.workspaceId]);
      return json(ListBotServersResponse.parse({ items: rows.rows.map(present), install: await installInfo(await loadInstall(ctx.runtime.publicUrl)) }));
    }),
  });

  async function codeFor(tx: PluginTx, row: ServerRow, actorId: string): Promise<BotServerCode> {
    const code = newEnrolCode();
    const expires = new Date(now().getTime() + ENROL_CODE_MINUTES * 60_000);
    // the code replaces any earlier one; it is bound to this row alone
    await tx.query('UPDATE app.bot_servers SET enrol_code_hash = $2, enrol_code_expires_at = $3::timestamptz, updated_at = now() WHERE id = $1::uuid', [row.id, hashSecret(code), expires.toISOString()]);
    const fresh = await loadServer(tx, row.id);
    await ctx.audit.emit(tx, { type: 'bot_server.server.changed', workspaceId: row.workspace_id, serverId: row.id, name: row.name, change: 'code_minted', actorId, at: now().toISOString() });
    return BotServerCode.parse({ server: present(fresh), code, expiresAt: expires.toISOString(), install: await installInfo(await loadInstall(ctx.runtime.publicUrl)) });
  }

  ctx.http.route({
    method: createBotServerRoute.method,
    path: createBotServerRoute.path,
    rateLimit: abuseLimit(createBotServerRoute.method, createBotServerRoute.path),
    schema: { body: CreateBotServerRequest, response: CreateBotServerResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = CreateBotServerRequest.parse(req.body);
      const workspaceId = tx.actor.workspaceId;
      // the runners of a server are named after it: a name that would collide with a runner somebody made is refused before anything is written
      const taken = await tx.query<{ name: string }>('SELECT name FROM app.bot_runners WHERE workspace_id = $1::uuid AND name = ANY($2::text[])', [workspaceId, allRunnerNamesOf(body.name)]);
      if (taken.rows.length > 0) throw conflict('Runners with that name already exist. Choose another name for the server.');
      const made = (
        await tx.query<{ id: string }>('INSERT INTO app.bot_servers (workspace_id, name, label, created_by) VALUES ($1::uuid, $2, $3, $4::uuid) RETURNING id', [workspaceId, body.name, body.label, tx.actor.id]).catch((err: { code?: string }) => {
          if (err.code === '23505') throw conflict('A server with that name already exists.');
          throw err;
        })
      ).rows[0]!;
      return json(await codeFor(tx, await loadServer(tx, made.id), tx.actor.id), 201);
    }),
  });

  ctx.http.route({
    method: mintBotServerCodeRoute.method,
    path: mintBotServerCodeRoute.path,
    rateLimit: abuseLimit(mintBotServerCodeRoute.method, mintBotServerCodeRoute.path),
    schema: { response: MintBotServerCodeResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { id } = BotServerPathParams.parse(req.params);
      return json(await codeFor(tx, await loadServer(tx, id, true), tx.actor.id));
    }),
  });

  ctx.http.route({
    method: rotateBotServerKeyRoute.method,
    path: rotateBotServerKeyRoute.path,
    rateLimit: abuseLimit(rotateBotServerKeyRoute.method, rotateBotServerKeyRoute.path),
    schema: { response: RotateBotServerKeyResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { id } = BotServerPathParams.parse(req.params);
      const row = await loadServer(tx, id, true);
      const conn = registry.get(row.id);
      if (row.key_hash === null || conn === undefined) throw conflict('The server must be connected to change its key. Connect it first, or make a new code and run the command again.');
      const key = newBridgeKey();
      // A rotation that is still waiting for the bridge's answer is never replaced (the bridge may already have stored its key: a second one would lock it out); one older than 15 minutes is taken as lost.
      const started = await tx.query(
        `UPDATE app.bot_servers SET pending_key_hash = $2, pending_key_at = now(), updated_at = now()
          WHERE id = $1::uuid AND (pending_key_hash IS NULL OR pending_key_at IS NULL OR pending_key_at < now() - interval '15 minutes') RETURNING id`,
        [row.id, hashSecret(key)],
      );
      if (started.rows.length === 0) throw conflict('A key change is already waiting for the server to confirm it. Wait a moment, or try again in 15 minutes.');
      try {
        // the new key goes to the bridge over its own open connection and nowhere else; it answers `rotated` once the key is on its disk
        conn.send({ type: 'rotate', key });
      } catch {
        throw conflict('The server did not take the new key. Try again in a moment.');
      }
      await ctx.audit.emit(tx, { type: 'bot_server.server.changed', workspaceId: row.workspace_id, serverId: row.id, name: row.name, change: 'key_rotated', actorId: tx.actor.id, at: now().toISOString() });
      return json(RotateBotServerKeyResponse.parse({ server: present(await loadServer(tx, row.id)) }));
    }),
  });

  /** The bots placed on the runners of a server (the delete guard). */
  async function placedOn(tx: PluginTx, row: ServerRow): Promise<number> {
    const ids = (await tx.query<{ id: string }>('SELECT id FROM app.bot_runners WHERE server_id = $1::uuid', [row.id])).rows.map((r) => r.id);
    const counts = await ctx.db.system((sys) => placementsOf(sys, row.workspace_id, ids), { workspaceId: row.workspace_id });
    let total = 0;
    for (const c of counts.values()) total += c.count;
    return total;
  }

  ctx.http.route({
    method: deleteBotServerRoute.method,
    path: deleteBotServerRoute.path,
    rateLimit: abuseLimit(deleteBotServerRoute.method, deleteBotServerRoute.path),
    schema: { response: DeleteBotServerResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { id } = BotServerPathParams.parse(req.params);
      const row = await loadServer(tx, id, true);
      const placed = await placedOn(tx, row);
      if (placed > 0) throw conflict(`${placed === 1 ? 'One bot runs' : `${placed} bots run`} on this server. Move ${placed === 1 ? 'it' : 'them'} to another runner first.`);
      await ctx.audit.emit(tx, { type: 'bot_server.server.changed', workspaceId: row.workspace_id, serverId: row.id, name: row.name, change: 'removed', actorId: tx.actor.id, at: now().toISOString() });
      await tx.query('DELETE FROM app.bot_servers WHERE id = $1::uuid', [row.id]);
      // the key is gone from the table, so the socket would end at its next beat; it is closed now
      registry.disconnect(row.id, 1008, 'the server was removed', 'removed');
      return json(DeleteBotServerResponse.parse({ deleted: true }));
    }),
  });

  // --- The installer's calls (no signed-in person) ------------------------------------------------------------------------------------------------------

  ctx.http.route({
    method: enrolBridgeRoute.method,
    path: enrolBridgeRoute.path,
    public: true,
    rateLimit: abuseLimit(enrolBridgeRoute.method, enrolBridgeRoute.path),
    rateLimitBy: 'address',
    schema: { body: EnrolBridgeRequest, response: EnrolBridgeResponse },
    handler: async (req) => {
      const body = EnrolBridgeRequest.parse(req.body);
      // A used, expired or unknown code is the same plain answer, and each counts against the address.
      const out = await guardRedemption(enrolLock, req.ip, 'enrolment codes', async () => {
        const key = newBridgeKey();
        return ctx.db.system(async (tx) => {
          const row = (
            await tx.query<ServerRow>(`SELECT ${SERVER_SELECT} WHERE s.enrol_code_hash = $1 AND s.enrol_code_expires_at > now() FOR UPDATE OF s`, [hashSecret(body.code)])
          ).rows[0];
          if (!row) throw notFound('That code is not valid. It may have been used or may have expired: make a new one on the Runners page.');
          const redeemed = await tx.query(
            `UPDATE app.bot_servers
                SET key_hash = $2, pending_key_hash = NULL, pending_key_at = NULL, enrol_code_hash = NULL, enrol_code_expires_at = NULL, status = 'offline',
                    host_name = $3, host_system = $4, host_arch = $5, bridge_version = $6, agents = $7::jsonb, allow_full_access = $8, last_seen_at = now(), updated_at = now()
              WHERE id = $1::uuid AND enrol_code_hash = $9 AND enrol_code_expires_at > now() RETURNING id`,
            [row.id, hashSecret(key), body.host.hostname, body.host.system, body.host.arch, body.bridgeVersion, JSON.stringify(body.agents), body.allowFullAccess, hashSecret(body.code)],
          );
          if (redeemed.rows.length !== 1) throw notFound('That code is not valid. It may have been used or may have expired: make a new one on the Runners page.');
          await syncServerRunners(tx, row, body.agents, false);
          await ctx.audit.emit(tx, { type: 'bot_server.server.changed', workspaceId: row.workspace_id, serverId: row.id, name: row.name, change: 'enrolled', actorId: null, at: now().toISOString() });
          return { row, key };
        });
      });
      // a new key ends the connection that used the old one
      registry.disconnect(out.row.id, 1008, 'the server was enrolled again', 'revoked');
      return json(EnrolBridgeResponse.parse({ serverId: out.row.id, name: out.row.name, key: out.key }));
    },
  });

  ctx.http.route({
    method: bridgeStatusRoute.method,
    path: bridgeStatusRoute.path,
    public: true,
    rateLimit: { limit: 120, windowMs: 60_000 },
    rateLimitBy: 'address',
    schema: { response: BridgeStatusResponse },
    handler: async (req) => {
      const row = await serverOfKey(ctx, keyLock, req);
      return json(BridgeStatusResponse.parse({ status: registry.get(row.id) ? 'connected' : 'offline', name: row.name }));
    },
  });

  // The repository list of this server's repo-sync (P26-15): the projects of the teams on its runners, for the bots placed on them. The key is the credential, as for `status`.
  ctx.http.route({
    method: bridgeReposRoute.method,
    path: bridgeReposRoute.path,
    public: true,
    rateLimit: abuseLimit(bridgeReposRoute.method, bridgeReposRoute.path),
    rateLimitBy: 'address',
    schema: { response: BridgeReposResponse },
    handler: async (req) => {
      const row = await serverOfKey(ctx, keyLock, req);
      const allow = parseRepoOriginAllow(process.env['MANYTHREADS_CLAUDE_PODS_REPO_ORIGIN_ALLOW'] ?? process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']);
      const rows = await ctx.db.system(
        async (tx) =>
          (
            await tx.query<{ team: string; bot: string; project: string; branch: string | null; origin: string }>(
              // the teams a runner serves (its list, or every team of the workspace when it is open to all) x the bots placed on it x the projects of the team
              `SELECT DISTINCT t.slug AS team, b.slug AS bot, p.name AS project, p.default_branch AS branch, p.repo_url AS origin
                 FROM app.bot_runners r
                 JOIN app.teams t ON t.workspace_id = r.workspace_id AND t.archived_at IS NULL
                      AND (r.all_teams OR EXISTS (SELECT 1 FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id AND rt.team_id = t.id))
                 JOIN app.bots b ON b.team_id = t.id AND b.status = 'active' AND b.placement ->> 'runs_on' = r.name
                 JOIN app.projects p ON p.team_id = t.id
                WHERE r.server_id = $1::uuid AND r.enabled
                ORDER BY t.slug, b.slug, p.name`,
              [row.id],
            )
          ).rows,
        { workspaceId: row.workspace_id },
      );
      return { status: 200, body: BridgeReposResponse.parse({ repos: rows.filter((r) => isRepoOriginAllowed(r.origin, allow)) }), headers: { 'cache-control': 'no-store' } };
    },
  });

  ctx.http.route({
    method: bridgeUninstallRoute.method,
    path: bridgeUninstallRoute.path,
    public: true,
    rateLimit: { limit: 20, windowMs: 60_000 },
    rateLimitBy: 'address',
    schema: { response: BridgeUninstallResponse },
    handler: async (req) => {
      const row = await serverOfKey(ctx, keyLock, req);
      const removed = await ctx.db.system(
        async (tx) => {
          const locked = (await tx.query<ServerRow>(`SELECT ${SERVER_SELECT} WHERE s.id = $1::uuid FOR UPDATE OF s`, [row.id])).rows[0];
          if (!locked) return true;
          const ids = (await tx.query<{ id: string }>('SELECT id FROM app.bot_runners WHERE server_id = $1::uuid', [row.id])).rows.map((r) => r.id);
          const counts = await placementsOf(tx, row.workspace_id, ids);
          let placed = 0;
          for (const c of counts.values()) placed += c.count;
          if (placed > 0) {
            // bots still run there: the server stays, offline, and a person decides
            await tx.query("UPDATE app.bot_servers SET status = 'offline', updated_at = now() WHERE id = $1::uuid", [row.id]);
            return false;
          }
          await ctx.audit.emit(tx, { type: 'bot_server.server.changed', workspaceId: row.workspace_id, serverId: row.id, name: row.name, change: 'removed', actorId: null, at: now().toISOString() });
          await tx.query('DELETE FROM app.bot_servers WHERE id = $1::uuid', [row.id]);
          return true;
        },
        { workspaceId: row.workspace_id },
      );
      registry.disconnect(row.id, 1008, 'the server was uninstalled', 'removed');
      return json(BridgeUninstallResponse.parse({ removed }));
    },
  });

  // The tunnel. The key is the credential: the upgrade is public, and a socket that does not present one the site knows is closed with 1008 at once.
  ctx.http.route({
    method: bridgeConnectRoute.method,
    path: bridgeConnectRoute.path,
    public: true,
    rateLimit: abuseLimit(bridgeConnectRoute.method, bridgeConnectRoute.path),
    rateLimitBy: 'address',
    // the bridge's data frames are a 64 KiB chunk in base64: the site-wide 64 KiB socket limit would close the tunnel at the first big answer
    wsMaxPayload: TUNNEL_MAX_FRAME_BYTES,
    ws: (socket, request) => serveBridgeSocket({ ...deps.socket, ctx, registry, lock: keyLock }, socket, request),
  });

  // --- The files the installer downloads ---------------------------------------------------------------------------------------------------------------

  ctx.http.route({
    method: 'GET',
    path: '/install/:file',
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    rateLimitBy: 'address',
    handler: async (req): Promise<HttpResponse> => {
      const file = String((req.params as { file?: string }).file ?? '');
      const found = await loadInstall(ctx.runtime.publicUrl);
      const text = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
      if (found === null) throw notFound('This install has no installer.');
      if (file === 'bridge.sh') return { status: 200, body: found.script, headers: { ...text, 'content-type': 'text/x-shellscript; charset=utf-8' } };
      if (file === 'bridge.sh.sha256') return { status: 200, body: `${found.scriptSha256}  bridge.sh\n`, headers: text };
      if (file === found.bundle + '.sha256') return { status: 200, body: `${found.bundleSha256}  ${found.bundle}\n`, headers: text };
      if (file === found.bundle) {
        const size = (await stat(found.bundlePath)).size;
        return { status: 200, body: createReadStream(found.bundlePath), headers: { 'content-type': 'application/gzip', 'content-length': String(size), 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } };
      }
      if (file === 'manythreads' || file === 'manythreads.sha256') {
        const scripts = await loadInstallScripts();
        if (scripts === null) throw notFound('This install has no installer.');
        return file === 'manythreads'
          ? { status: 200, body: scripts.hostCommand, headers: { ...text, 'content-type': 'text/x-shellscript; charset=utf-8' } }
          : { status: 200, body: `${scripts.hostCommandSha256}  manythreads\n`, headers: text };
      }
      throw notFound('No such file.');
    },
  });

  // The one-command installer of a whole manythreads site (`curl -fsSL https://<site>/install.sh | sudo bash`, docs/deploy/install.md) and its hash.
  for (const [path, sha] of [['/install.sh', false], ['/install.sh.sha256', true]] as const) {
    ctx.http.route({
      method: 'GET',
      path,
      public: true,
      rateLimit: { limit: 60, windowMs: 60_000 },
      rateLimitBy: 'address',
      handler: async (): Promise<HttpResponse> => {
        const scripts = await loadInstallScripts();
        if (scripts === null) throw notFound('This install has no installer.');
        const headers = { 'content-type': sha ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
        return { status: 200, body: sha ? `${scripts.scriptSha256}  install.sh\n` : scripts.script, headers };
      },
    });
  }
}
