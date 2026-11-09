// States sweep helpers (PLAN P12 block B, used by the persona journeys' `states/` files): put a screen into its empty, loading or error state on purpose.
import type { Page, Route } from '@playwright/test';

/** Answers the requests whose address matches `pattern` with `status` and a plain error body, until the returned function is called. The page sees a failed load. */
export async function failRequests(page: Page, pattern: string | RegExp, status = 500): Promise<() => Promise<void>> {
  const handler = (route: Route): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forced', message: 'forced by the states sweep' } }) });
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

/** Holds the requests whose address matches `pattern` until `release()` is called: the screen stays in its loading state meanwhile. */
export async function holdRequests(page: Page, pattern: string | RegExp): Promise<{ release: () => Promise<void> }> {
  const held: Route[] = [];
  let open = false;
  const handler = async (route: Route): Promise<void> => {
    if (open) return route.continue();
    held.push(route);
  };
  await page.route(pattern, handler);
  return {
    async release() {
      open = true;
      await Promise.all(held.splice(0).map((r) => r.continue().catch(() => undefined)));
      await page.unroute(pattern, handler);
    },
  };
}

/** Answers the requests whose address matches `pattern` with an empty list shaped like `body` (default `{ items: [] }`): the empty state of a list. */
export async function emptyRequests(page: Page, pattern: string | RegExp, body: unknown = { items: [] }): Promise<() => Promise<void>> {
  const handler = (route: Route): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

/** Takes the page offline and back: the offline banner and the retry paths. */
export async function goOffline(page: Page): Promise<() => Promise<void>> {
  await page.context().setOffline(true);
  return () => page.context().setOffline(false);
}
