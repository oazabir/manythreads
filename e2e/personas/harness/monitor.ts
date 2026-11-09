// Watches a page for the things a screenshot must not hide: console errors, uncaught errors, failed requests, error answers (PLAN P12-01).
import type { Page } from '@playwright/test';

export interface PageProblem {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'response';
  text: string;
  url?: string;
  status?: number;
}

/** Answers and failures that are normal and not a defect of the screen. */
export interface IgnoreRule {
  /** Only for this status (a failed request has none). */
  status?: number;
  url: RegExp;
}

export const DEFAULT_IGNORE: readonly IgnoreRule[] = [
  // the session probe of a page nobody is signed in on answers 401 by design
  { status: 401, url: /\/api\/session(\?|$)/ },
  // Known client noise, only these two exact shapes (nothing wider): opening a bot's post made for somebody else's question asks `GET /api/runs/<id>/origin`, and a
  // Brain conversation's first message is followed by `GET .../bots/<bot>/conversations/<id>/state` before the conversation exists. Both answer 404 and the screen is fine.
  { status: 404, url: /\/api\/runs\/[^/?#]+\/origin(\?|$)/ },
  { status: 404, url: /\/conversations\/[^/?#]+\/state(\?|$)/ },
];

export interface PageMonitor {
  /** What happened since the last call, oldest first. */
  take(): PageProblem[];
}

const monitors = new WeakMap<Page, PageMonitor>();

const ignoreRules = new WeakMap<Page, IgnoreRule[]>();

/**
 * Attach once per page, before it navigates (`loginAs` does). Safe to call again: the first monitor stays and keeps listening, and the extra rules of a later call
 * are added to it (a persona's own known noise), so attaching early never drops them.
 */
export function monitorPage(page: Page, extraIgnore: readonly IgnoreRule[] = []): PageMonitor {
  const existing = monitors.get(page);
  if (existing) {
    ignoreRules.get(page)?.push(...extraIgnore);
    return existing;
  }
  const ignore = [...DEFAULT_IGNORE, ...extraIgnore];
  ignoreRules.set(page, ignore);
  let seen: PageProblem[] = [];
  const skipped = (url: string, status?: number): boolean => ignore.some((r) => r.url.test(url) && (r.status === undefined || r.status === status));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location().url;
    // the browser repeats a failed load as a console line without the status; the response handler below already has it
    // (Chromium words it "...the server responded with a status of 404 (Not Found)"; the status is read from it so a rule that names a status also covers its console line)
    if (/^Failed to load resource/.test(msg.text()) && skipped(url, Number(/status of (\d{3})/.exec(msg.text())?.[1]) || undefined)) return;
    seen.push({ kind: 'console', text: msg.text(), url });
  });
  page.on('pageerror', (error) => seen.push({ kind: 'pageerror', text: error.message }));
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? 'failed';
    // a request the page itself cancelled (a navigation, a closed popover, an unmounted list) is not a defect
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) return;
    if (skipped(req.url())) return;
    seen.push({ kind: 'requestfailed', text: `${req.method()} ${req.url()} ${failure}`, url: req.url() });
  });
  page.on('response', (res) => {
    if (res.status() < 400 || skipped(res.url(), res.status())) return;
    seen.push({ kind: 'response', text: `${res.request().method()} ${res.url()} answered ${res.status()}`, url: res.url(), status: res.status() });
  });
  const monitor: PageMonitor = {
    take() {
      const out = seen;
      seen = [];
      return out;
    },
  };
  monitors.set(page, monitor);
  return monitor;
}

/** The problems that fail a normal step, or what a denial step is allowed to contain. */
export function judge(problems: readonly PageProblem[], expectDenied: number | undefined): string[] {
  if (expectDenied !== undefined) {
    const answered = problems.some((p) => p.kind === 'response' && p.status === expectDenied);
    if (!answered) return [`this step expects the server to answer ${expectDenied}, and nothing did${problems.length ? ` (saw: ${problems.map((p) => p.text).slice(0, 3).join('; ')})` : ''}`];
    // The refusal itself, and the browser's console line about it, are what this step is for. Everything else that went wrong while it ran still fails it: a page that threw,
    // a request that never arrived, a server fault (5xx) hidden behind the refusal.
    return problems
      .filter((p) => p.kind === 'pageerror' || p.kind === 'requestfailed' || (p.kind === 'response' && p.status !== expectDenied && (p.status ?? 0) >= 500))
      .map((p) => `${p.kind}: ${p.text}`);
  }
  return problems.map((p) => `${p.kind}: ${p.text}`);
}
