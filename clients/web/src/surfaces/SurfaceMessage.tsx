import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SurfaceChangedPush, WS_SURFACE_CHANGED, type Surface as SurfaceDto } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchSurface, sendSurfaceEvent } from '../api/endpoints';
import { isMockMode } from '../api/setup';
import { realtimeClient } from '../realtime';
import { Surface } from './Surface';
import { SurfaceActionsContext, type SurfaceActions } from './views';

/*
 * A bot's screen inside the message that announces it (PLAN P9-04). The message carries only the surface's id (`meta.surfaceRef`); the screen itself is read
 * from the server as the person who reads the channel, and read again when the server says it changed (a new version, or an answer). A press goes back as
 * data about one part (`{ nodeId, name, payload }`) together with the version the person was looking at; the server decides whether it is allowed.
 * Without the right to post in the channel the screen is drawn but cannot be pressed.
 */

/** What the person is told when an answer was refused. */
export function pressFailure(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 409) return 'This screen has just changed. Look at the new one and try again.';
    if (e.status === 429) return 'Too many answers are waiting for the bot. Try again in a moment.';
    if (e.status === 403) return 'You cannot answer in this channel.';
    return e.message;
  }
  return 'The answer could not be sent. Try again.';
}

const NONE: ReadonlySet<string> = new Set();

export function SurfaceMessage({ channelId, surfaceId, canPost }: { channelId: string; surfaceId: string; canPost: boolean }): ReactNode {
  const [surface, setSurface] = useState<SurfaceDto | null>(null);
  const [missing, setMissing] = useState<'gone' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The presses that went through, per version: a new version of the screen starts clean.
  const [answered, setAnswered] = useState<{ version: number; ids: ReadonlySet<string> }>({ version: 0, ids: NONE });
  const alive = useRef(true);

  const load = useCallback(async () => {
    // One more try for a busy or failing server; a refusal that is final (no right to read, no such screen) is not retried.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const next = await fetchSurface(channelId, surfaceId);
        if (alive.current) {
          setSurface((prev) => (prev !== null && prev.version > next.version ? prev : next));
          setMissing(null);
        }
        return;
      } catch (e) {
        const retry = attempt === 0 && (!isApiError(e) || e.status === 429 || e.status >= 500);
        if (retry) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        if (alive.current) setMissing(isApiError(e) && (e.status === 403 || e.status === 404) ? 'gone' : 'failed');
        return;
      }
    }
  }, [channelId, surfaceId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (isMockMode()) return;
    return realtimeClient().onPush((push) => {
      if (push.type !== WS_SURFACE_CHANGED) return;
      const parsed = SurfaceChangedPush.safeParse(push.payload);
      if (parsed.success && parsed.data.surfaceId === surfaceId) void load();
    });
  }, [surfaceId, load]);

  const version = surface?.version ?? 0;
  const send = useCallback(
    async (nodeId: string, name: string, payload: Record<string, unknown>): Promise<void> => {
      if (version === 0) return;
      setBusy(true);
      setError(null);
      try {
        await sendSurfaceEvent(channelId, surfaceId, { nodeId, name, version, payload });
        if (alive.current) setAnswered((prev) => ({ version, ids: new Set([...(prev.version === version ? prev.ids : NONE), nodeId]) }));
      } catch (e) {
        if (alive.current) {
          setError(pressFailure(e));
          if (isApiError(e) && e.status === 409) void load();
        }
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [channelId, surfaceId, version, load],
  );

  if (surface === null) {
    return (
      <div className="sf-message" data-testid="surface-message">
        <div className="sf-message-note" role={missing !== null ? 'note' : undefined}>
          {missing === 'gone' ? 'This screen is not available to you' : missing === 'failed' ? 'Could not load the screen' : 'Loading the screen'}
        </div>
      </div>
    );
  }
  const actions: SurfaceActions = { send: canPost ? send : null, answered: answered.version === version ? answered.ids : NONE, busy };
  return (
    <div className="sf-message" data-testid="surface-message" data-version={surface.version}>
      <div className="sf-message-title">{surface.title}</div>
      <SurfaceActionsContext.Provider value={actions}>
        <Surface source={surface.source} ended />
      </SurfaceActionsContext.Provider>
      {error ? (
        <div className="sf-message-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
