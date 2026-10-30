import { describe, expect, it } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { refreshDirectory } from '../src/shell/channelFeed';

// A directory asked for again while a fetch is under way must be fetched once more: the first fetch may have started before the change that
// asked (a channel was just created), so skipping the second ask left the new channel out of the sidebar until the next push.

describe('refreshDirectory', () => {
  it('fetches once more when it is asked again during a fetch', async () => {
    const seen: TransportRequest[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setTransport(async (req) => {
      seen.push(req);
      if (seen.length === 1) await gate;
      return { status: 200, body: { groups: [] } };
    });
    const first = refreshDirectory('again-team');
    await refreshDirectory('again-team'); // asked while the first is waiting
    expect(seen).toHaveLength(1);
    release?.();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(2);
  });
});
