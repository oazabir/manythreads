// A person's browser asking the server for something the screen does not offer (PLAN P12-03: "negative steps try each must-never"). The screen shows no button; this is the
// request a hand-made one would send, from the page itself, so the same cookies and the server's own answer are what the picture and the monitor see.
import type { Page } from '@playwright/test';

/** Sends `method path` from inside the page with the person's own cookies and CSRF header; returns the HTTP status. */
export async function askFromPage(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<number> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie
        .split('; ')
        .map((c) => c.split('='))
        .find(([k]) => k === 'manythreads_csrf' || k === '__Host-manythreads_csrf')?.[1];
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return res.status;
    },
    { method, path, body },
  );
}
