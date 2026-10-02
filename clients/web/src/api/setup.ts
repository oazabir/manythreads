import { setTransport } from './client';
import { createMockTransport, type MockOptions } from './mock';

const STORE_KEY = 'manythreads_mock';

function readStore(): string | null {
  try {
    return window.sessionStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}
function writeStore(value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(STORE_KEY);
    else window.sessionStorage.setItem(STORE_KEY, value);
  } catch {
    /* storage can be blocked; the mock then lasts for this page load only */
  }
}

/** Mock query string for this tab: `?mock=1&...` wins, `?mock=0` clears, otherwise what the tab remembered. */
export function resolveMockQuery(search: string, envFlag: string | undefined, stored: string | null): string | null {
  const q = new URLSearchParams(search);
  const flag = q.get('mock');
  if (flag === '0') return null;
  if (flag === '1') return search;
  if (stored) return stored;
  return envFlag === '1' ? '?mock=1' : null;
}

export function mockOptionsFrom(search: string): MockOptions {
  const q = new URLSearchParams(search);
  const providers = q.get('providers');
  return {
    as: q.get('as') ?? undefined,
    anon: q.get('anon') === '1',
    providers: providers ? providers.split(',').filter(Boolean) : undefined,
    noTeams: q.get('teams') === 'none',
    latencyMs: q.has('latency') ? Number(q.get('latency')) : undefined,
  };
}

let mocked = false;
export const isMockMode = (): boolean => mocked;

/** Pick the transport for this page load. Called once from main.tsx before the first render. */
export function configureApi(): void {
  const flag = resolveMockQuery(window.location.search, import.meta.env.VITE_MANYTHREADS_MOCK, readStore());
  if (flag === null) {
    if (new URLSearchParams(window.location.search).get('mock') === '0') writeStore(null);
    return;
  }
  writeStore(flag);
  mocked = true;
  setTransport(createMockTransport(mockOptionsFrom(flag)));
}
