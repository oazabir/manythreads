import type { HttpRequest, Lockout, PluginContext, PluginSocket } from '@manythreads/sdk';
import { BridgeToSite, TUNNEL_HEARTBEAT_SECONDS, type BotServerChange, type BotServerId, type SiteToBridge } from '@manythreads/shared';
import { markServerRunnersOffline, reconcileServerScopes, syncServerRunners, helloColumns, type ServerRow } from '../servers.ts';
import { bearerBridgeKey, hashSecret } from './keys.ts';
import type { BridgeConnection, TunnelRegistry, TunnelStream } from './registry.ts';

// One bridge's WebSocket, from the upgrade to the close (docs/plans/agents-anywhere.md §5.3). This file decides who may connect, keeps the key honest while the socket
// is open, and turns the bridge's frames into the registry's calls. What a frame carries is never logged: the lines below say the server's name and a reason.

/** Close codes the bridge understands: 1008 means "this key is not accepted, do not retry it"; the rest are ordinary. */
export const CLOSE_REFUSED = 1008;

export interface BridgeSocketOptions {
  ctx: PluginContext;
  registry: TunnelRegistry;
  /** Wrong keys per client address. */
  lock: Lockout;
  /** Test hooks. */
  heartbeatSeconds?: number;
  helloWaitMs?: number;
  /** How long after the socket drops the server is still "connected" in the row (a bridge restart or a network blip does not flap the audit trail). Default 15 s. */
  offlineAfterMs?: number;
  /** Runs once a server connected (its runners exist): the caller checks what each agent's sign-in says. */
  onConnected?: (server: { id: string; workspaceId: string; name: string }) => void;
  log?: (line: string) => void;
}

interface Found {
  row: ServerRow;
  /** The key was the pending one: it is promoted at once (the bridge wrote it, then lost the connection before it said so). */
  pending: boolean;
}

/** The server a key belongs to, by the hash of the key. */
async function findByKeyHash(ctx: PluginContext, hash: string): Promise<Found | null> {
  return ctx.db.system(async (tx) => {
    const row = (
      await tx.query<ServerRow>(
        `SELECT s.id, s.workspace_id, s.name, s.label, s.status, s.enrol_code_hash, s.enrol_code_expires_at, s.key_hash, s.pending_key_hash, s.host_name, s.host_system, s.host_arch,
                s.bridge_version, s.agents, s.allow_full_access, s.team_users, s.created_by, s.last_seen_at, s.created_at, s.updated_at
           FROM app.bot_servers s WHERE s.key_hash = $1 OR s.pending_key_hash = $1`,
        [hash],
      )
    ).rows[0];
    if (!row) return null;
    return { row, pending: row.key_hash !== hash };
  });
}

/** Does this key still open this server? Asked at every heartbeat, so a removed server or a rotated key is cut within one beat. */
export async function keyStillOpens(ctx: PluginContext, serverId: string, hash: string): Promise<boolean> {
  return ctx.db.system(async (tx) => (await tx.query('SELECT 1 FROM app.bot_servers WHERE id = $1::uuid AND (key_hash = $2 OR pending_key_hash = $2)', [serverId, hash])).rows.length > 0);
}

/** One audit line for a server's change; `actor` is null when the server itself did it. */
export async function auditServer(ctx: PluginContext, row: { id: string; workspace_id: string; name: string }, change: BotServerChange, actorId: string | null): Promise<void> {
  await ctx.db.system(
    (tx) => ctx.audit.emit(tx, { type: 'bot_server.server.changed', workspaceId: row.workspace_id, serverId: row.id, name: row.name, change, actorId, at: ctx.runtime.now().toISOString() }),
    { workspaceId: row.workspace_id },
  );
}

export function serveBridgeSocket(opts: BridgeSocketOptions, socket: PluginSocket, request: HttpRequest): void {
  const { ctx, registry, lock } = opts;
  const beatSeconds = opts.heartbeatSeconds ?? TUNNEL_HEARTBEAT_SECONDS;
  const log = opts.log ?? (() => undefined);
  const address = request.ip;
  const key = bearerBridgeKey(request.headers['authorization']);

  const refuse = (why: string): void => {
    if (key !== null || request.headers['authorization'] !== undefined) lock.fail(address);
    socket.close(CLOSE_REFUSED, why);
  };
  if (lock.check(address).locked) {
    socket.close(CLOSE_REFUSED, 'too many refused keys; wait and try again');
    return;
  }
  if (key === null) {
    refuse('a bridge key is needed');
    return;
  }
  const hash = hashSecret(key);

  let conn: BridgeConnection | null = null;
  let lastFrameAt = ctx.runtime.now().getTime();
  let serverRow: ServerRow | null = null;
  let activeHash = hash;
  let timer: NodeJS.Timeout | null = null;
  let helloTimer: NodeJS.Timeout | null = null;
  let ended = false;

  const stopTimers = (): void => {
    if (timer) clearInterval(timer);
    if (helloTimer) clearTimeout(helloTimer);
    timer = null;
    helloTimer = null;
  };

  const sendRaw = (frame: SiteToBridge): void => {
    socket.send(JSON.stringify(frame));
  };

  // The first frame must come soon; a socket that says nothing is closed.
  helloTimer = setTimeout(() => socket.close(1008, 'no hello'), opts.helloWaitMs ?? 10_000);
  helloTimer.unref?.();

  // Frames can arrive while the key lookup is in flight: they wait for it, in order.
  let ready: Promise<void> = (async () => {
    const found = await findByKeyHash(ctx, hash);
    if (!found) {
      refuse('that key is not accepted');
      return;
    }
    serverRow = found.row;
    if (found.pending) {
      // the bridge wrote the new key and came back with it: it is the key now
      await ctx.db.system((tx) => tx.query('UPDATE app.bot_servers SET key_hash = pending_key_hash, pending_key_hash = NULL, pending_key_at = NULL, updated_at = now() WHERE id = $1::uuid AND pending_key_hash = $2', [found.row.id, hash]), {
        workspaceId: found.row.workspace_id,
      });
    }
  })().catch((err: unknown) => {
    log(`bridge socket failed: ${err instanceof Error ? err.message : 'error'}`);
    socket.close(1011, 'server error');
  });

  const handleHello = async (frame: Extract<BridgeToSite, { type: 'hello' }>): Promise<void> => {
    if (conn !== null || serverRow === null) return;
    const row = serverRow;
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = null;
    const streams = new Map<string, TunnelStream>();
    const made: BridgeConnection = {
      serverId: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      hello: frame,
      socket,
      streams,
      closed: false,
      send: (f) => {
        if (made.closed) throw new Error('the connection is closed');
        sendRaw(f);
      },
      close: (code, reason) => {
        if (made.closed) return;
        socket.close(code, reason);
      },
    };
    conn = made;
    const previous = registry.set(made);
    // A new socket for a server closes the old one (its streams fail: a run on it reads "disconnected" and asks again on the new one).
    if (previous && previous !== made) previous.close(1000, 'replaced by a newer connection', 'replaced');
    await ctx.db.system(
      async (tx) => {
        const was = (await tx.query<{ status: string }>('SELECT status FROM app.bot_servers WHERE id = $1::uuid FOR UPDATE', [row.id])).rows[0]?.status;
        await tx.query(
          `UPDATE app.bot_servers SET status = 'connected', host_name = $2, host_system = $3, host_arch = $4, bridge_version = $5, agents = $6::jsonb, allow_full_access = $7, team_users = $8, signin_scopes = $9::jsonb,
                  last_seen_at = now(), updated_at = now() WHERE id = $1::uuid`,
          (() => {
            const c = helloColumns(frame);
            return [row.id, c.host_name, c.host_system, c.host_arch, c.bridge_version, c.agents, c.allow_full_access, c.team_users, c.signin_scopes];
          })(),
        );
        await syncServerRunners(tx, row, frame.agents, true);
        await reconcileServerScopes(tx, row.id, frame);
        if (was !== 'connected') {
          await ctx.audit.emit(tx, { type: 'bot_server.server.changed', workspaceId: row.workspace_id, serverId: row.id, name: row.name, change: 'connected', actorId: null, at: ctx.runtime.now().toISOString() });
        }
      },
      { workspaceId: row.workspace_id },
    );
    sendRaw({ type: 'welcome', serverId: row.id as BotServerId, name: row.name, heartbeatSeconds: beatSeconds });
    log(`bridge ${row.name} connected`);
    opts.onConnected?.({ id: row.id, workspaceId: row.workspace_id, name: row.name });
    timer = setInterval(() => {
      void (async () => {
        if (ended) return;
        // Three beats of silence: the machine is gone without closing the socket.
        if (ctx.runtime.now().getTime() - lastFrameAt > beatSeconds * 3 * 1000) {
          socket.close(1001, 'silent');
          return;
        }
        if (!(await keyStillOpens(ctx, row.id, activeHash).catch(() => true))) socket.close(CLOSE_REFUSED, 'the key was removed');
      })();
    }, beatSeconds * 1000);
    timer.unref?.();
  };

  const handleBeat = async (): Promise<void> => {
    if (conn === null || serverRow === null) return;
    const row = serverRow;
    if (!(await keyStillOpens(ctx, row.id, activeHash))) {
      socket.close(CLOSE_REFUSED, 'the key was removed');
      return;
    }
    await ctx.db.system((tx) => tx.query('UPDATE app.bot_servers SET last_seen_at = now() WHERE id = $1::uuid', [row.id]), { workspaceId: row.workspace_id });
    if (!conn.closed) sendRaw({ type: 'beat_ack' });
  };

  // The bridge answered `rotated`: the pending key is the key, and the old one stops opening the server.
  const handleRotated = async (): Promise<void> => {
    if (conn === null || serverRow === null) return;
    const row = serverRow;
    const next = await ctx.db.system(
      async (tx) => (await tx.query<{ key_hash: string }>('UPDATE app.bot_servers SET key_hash = pending_key_hash, pending_key_hash = NULL, pending_key_at = NULL, updated_at = now() WHERE id = $1::uuid AND pending_key_hash IS NOT NULL RETURNING key_hash', [row.id])).rows[0],
      { workspaceId: row.workspace_id },
    );
    if (next) activeHash = next.key_hash;
  };

  socket.on('message', (data) => {
    lastFrameAt = ctx.runtime.now().getTime();
    if (typeof data !== 'string') {
      socket.close(1003, 'text frames only');
      return;
    }
    let frame: BridgeToSite;
    try {
      frame = BridgeToSite.parse(JSON.parse(data));
    } catch {
      socket.close(1002, 'that frame is not part of the protocol');
      return;
    }
    // frames are handled one after another: the key lookup first, then in the order they came
    ready = ready.then(async () => {
      if (ended || serverRow === null) return;
      switch (frame.type) {
        case 'hello':
          return handleHello(frame);
        case 'beat':
          return handleBeat();
        case 'rotated':
          return handleRotated();
        default:
          if (conn === null) return;
          if (frame.type === 'head') registry.handleHead(conn, frame.id, frame.status, frame.headers);
          else if (frame.type === 'data') registry.handleData(conn, frame.id, frame.data);
          else if (frame.type === 'end') registry.handleEnd(conn, frame.id);
          else if (frame.type === 'error') registry.handleError(conn, frame.id, frame.message);
          return;
      }
    }).catch((err: unknown) => {
      log(`bridge frame failed: ${err instanceof Error ? err.message : 'error'}`);
      socket.close(1011, 'server error');
    });
  });

  const finish = (): void => {
    if (ended) return;
    ended = true;
    stopTimers();
    const mine = conn;
    const row = serverRow;
    if (mine === null || row === null) return;
    mine.closed = true;
    const wasCurrent = registry.remove(mine, 'closed');
    if (!wasCurrent) return; // a newer connection of the same server took over: nothing went offline
    log(`bridge ${row.name} disconnected`);
    // The row says offline only after a short while, so a restart of the bridge or a network blip does not make a line in the trail each time.
    const wait = opts.offlineAfterMs ?? 15_000;
    const t = setTimeout(() => {
      if (registry.get(row.id)) return;
      void ctx.db
        .system(
          async (tx) => {
            const changed = await tx.query("UPDATE app.bot_servers SET status = 'offline', updated_at = now() WHERE id = $1::uuid AND status = 'connected' RETURNING id", [row.id]);
            if (changed.rows.length === 0) return;
            await markServerRunnersOffline(tx, row.id);
            await ctx.audit.emit(tx, { type: 'bot_server.server.changed', workspaceId: row.workspace_id, serverId: row.id, name: row.name, change: 'disconnected', actorId: null, at: ctx.runtime.now().toISOString() });
          },
          { workspaceId: row.workspace_id },
        )
        .catch(() => undefined);
    }, wait);
    t.unref?.();
  };
  socket.on('close', finish);
  socket.on('error', finish);
}
