import { HttpError, MediaNotConfiguredError, MediaTokenRefusedError, type MediaProvider, type PluginContext, type PluginLogger } from '@manythreads/sdk';
import type { MediaStatusResponse } from '@manythreads/shared';

// Which media provider carries the calls, and what to say when there is none. `MANYTHREADS_MEDIA_PROVIDER` names it (`livekit` by default; `fake` in tests).
// Looked up when a request arrives, never in `register`: the provider's plugin may load after this one.

export const NOT_SET_UP = 'Voice rooms are not set up on this server. Ask a workspace admin to connect a media server.';

export function mediaProviderId(): string {
  return (process.env['MANYTHREADS_MEDIA_PROVIDER'] ?? '').trim().toLowerCase() || 'livekit';
}

export function currentMedia(ctx: PluginContext): MediaProvider | undefined {
  return ctx.providers.get<MediaProvider>('media', mediaProviderId());
}

export function mediaStatus(ctx: PluginContext): MediaStatusResponse {
  const provider = currentMedia(ctx);
  if (!provider) return { configured: false, provider: null, reason: NOT_SET_UP };
  const s = provider.status();
  return { configured: s.configured, provider: provider.id, reason: s.reason };
}

/** The provider, or a 409 with the plain reason (before anything is written). */
export function requireMedia(ctx: PluginContext): MediaProvider {
  const provider = currentMedia(ctx);
  if (!provider) throw new HttpError(409, 'conflict', NOT_SET_UP);
  const s = provider.status();
  if (!s.configured) throw new HttpError(409, 'conflict', s.reason ?? NOT_SET_UP);
  return provider;
}

/** What a failed call to the media server becomes for the person: a plain message, never the server's own text. */
export function mediaFailure(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof MediaNotConfiguredError) return new HttpError(409, 'conflict', err.message);
  if (err instanceof MediaTokenRefusedError) return new HttpError(403, 'forbidden', err.message);
  return new HttpError(502, 'internal', 'The voice server did not answer. Try again in a moment.');
}

/** Runs a media call whose failure must not undo what was just written (a kick, closing a room already closed in the database). Logs one line when it has a logger, never the error text. */
export async function bestEffort(log: Pick<PluginLogger, 'warn'> | undefined, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // a route has no logger: the database already says what happened, and the sweep and the token expiry finish the job
    log?.warn(`meetings: ${what} did not reach the media server (${err instanceof Error ? err.name : 'error'})`);
  }
}
