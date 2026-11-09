/**
 * `data-ready` on <html> (PLAN P12-01, Bundle E decision E31): "this screen has finished loading", so a screenshot is never taken of a half-loaded one.
 *
 * It is `true` when all of these hold, and `false` otherwise:
 *   - no API request has been in flight for 300 ms (requests are counted in api/client.ts through `trackRequest`),
 *   - the web fonts are loaded,
 *   - no element on screen says `aria-busy="true"` (a skeleton or a loading page).
 *
 * The persona harness (e2e/personas/harness/shot.ts) waits for `data-ready="true"` before it takes a picture. Nothing else reads it.
 */

/** How long the app must be quiet (no request starting or ending) before the screen counts as loaded. */
export const READY_QUIET_MS = 300;
/** How often the gate looks again while it waits (a request ending, a skeleton going away, a font arriving). */
const POLL_MS = 100;

export interface ReadyGateOptions {
  now: () => number;
  /** The fonts are loaded (document.fonts.status === 'loaded'). */
  fontsReady: () => boolean;
  /** An element with aria-busy="true" is on screen. */
  hasBusy: () => boolean;
  /** Called with the new value whenever it changes (writes the attribute). */
  publish: (ready: boolean) => void;
}

export interface ReadyGate {
  /** A request started. */
  begin(): void;
  /** A request ended (answered or failed). */
  end(): void;
  /** Look again: publishes `true` when everything holds. Called by the poll and by tests. */
  check(): boolean;
  readonly inFlight: number;
}

export function createReadyGate(options: ReadyGateOptions): ReadyGate {
  let inFlight = 0;
  let lastActivity = options.now();
  let published: boolean | null = null;
  const set = (ready: boolean): void => {
    if (published === ready) return;
    published = ready;
    options.publish(ready);
  };
  return {
    begin() {
      inFlight += 1;
      lastActivity = options.now();
      set(false);
    },
    end() {
      inFlight = Math.max(0, inFlight - 1);
      lastActivity = options.now();
    },
    check() {
      const ready = inFlight === 0 && options.now() - lastActivity >= READY_QUIET_MS && options.fontsReady() && !options.hasBusy();
      set(ready);
      return ready;
    },
    get inFlight() {
      return inFlight;
    },
  };
}

let gate: ReadyGate | null = null;

function install(): ReadyGate | null {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !document.documentElement) return null;
  const root = document.documentElement;
  const created = createReadyGate({
    now: () => Date.now(),
    fontsReady: () => (document.fonts ? document.fonts.status === 'loaded' : true),
    hasBusy: () => document.querySelector('[aria-busy="true"]') !== null,
    publish: (ready) => root.setAttribute('data-ready', ready ? 'true' : 'false'),
  });
  root.setAttribute('data-ready', 'false');
  // A cheap poll: one attribute lookup and one selector query every 100 ms. It is the only thing that can see a skeleton go away.
  const timer = window.setInterval(() => created.check(), POLL_MS);
  // A test page that is torn down must not leave the timer behind.
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
  return created;
}

/** Counts one request: call it around the real fetch. Safe on the server and in tests (it just runs the promise). */
export function trackRequest<T>(run: () => Promise<T>): Promise<T> {
  gate ??= install();
  if (!gate) return run();
  gate.begin();
  const g = gate;
  return run().finally(() => g.end());
}

/** Starts the gate without a request (the first paint of a page that has not asked the API anything yet). */
export function startReadyMarker(): void {
  gate ??= install();
}
