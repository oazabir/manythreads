import type { GetNotificationLevelsResponse, NotificationLevel } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchNotificationLevels, saveChannelLevel, saveWorkspaceLevel } from '../api/endpoints';
import { onPersonChange } from '../app/caches';
import { withChannelLevel } from './settingsModel';

/*
 * The person's notification levels (PLAN P14-09): their own choice per channel and the workspace default. Shared by the bell menu in a channel's
 * header and the Notifications settings, so a change in one shows in the other. A change shows at once and is undone if the server refuses it.
 */

export type LevelsSnapshot = {
  status: 'idle' | 'loading' | 'ok' | 'error';
  levels: GetNotificationLevelsResponse | null;
};

const INITIAL: LevelsSnapshot = { status: 'idle', levels: null };

export class LevelsStore {
  private snap: LevelsSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): LevelsSnapshot => this.snap;
  private set(next: Partial<LevelsSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of [...this.listeners]) l();
  }
  reset(): void {
    this.snap = INITIAL;
    this.inflight = null;
    for (const l of [...this.listeners]) l();
  }

  /** Loads once; a later call returns the same answer unless `force` asks again. */
  load(force = false): Promise<void> {
    if (!force && (this.snap.status === 'ok' || this.inflight)) return this.inflight ?? Promise.resolve();
    if (this.snap.status !== 'ok') this.set({ status: 'loading' });
    const run = fetchNotificationLevels().then(
      (levels) => this.set({ status: 'ok', levels }),
      (e: unknown) => {
        // a server without the settings (older release) simply has no levels to show
        this.set({ status: this.snap.levels ? 'ok' : 'error' });
        if (!isApiError(e)) throw e;
      },
    );
    this.inflight = run.finally(() => {
      this.inflight = null;
    });
    return this.inflight.catch(() => undefined);
  }

  /** Sets one channel's level for the person (`null`: follow the default). Throws a sentence for the screen when the server refuses. */
  async setChannel(channel: { channelId: string; channelName: string | null; channelKind: 'channel' | 'dm' | 'bot_conversation' }, level: NotificationLevel | null): Promise<void> {
    const before = this.snap.levels;
    if (before) this.set({ levels: withChannelLevel(before, channel, level) });
    try {
      await saveChannelLevel(channel.channelId, level);
      // chosen before the list had loaded: there was nothing to change on screen, so read it again
      if (!before) void this.load(true);
    } catch (e) {
      this.set({ levels: before });
      throw new Error(isApiError(e) ? e.message : 'Could not save the setting. Try again.');
    }
  }

  async setWorkspaceDefault(level: NotificationLevel): Promise<void> {
    const before = this.snap.levels;
    if (before) this.set({ levels: { ...before, workspaceDefault: level } });
    try {
      await saveWorkspaceLevel({ level });
    } catch (e) {
      this.set({ levels: before });
      throw new Error(isApiError(e) ? e.message : 'Could not save the setting. Try again.');
    }
  }
}

export const levelsStore = new LevelsStore();
onPersonChange(() => levelsStore.reset());
