import type { LinkPreviewImageType } from '@manythreads/shared';
import type { HostBreaker } from './limits.ts';
import { EMPTY_META, decodeHtml, hasContent, imageSizeAllowed, parseHtmlMeta, parseOembed, sniffImage, type PageMeta } from './parse.ts';
import { DEFAULT_DEPS, SafeFetchError, safeFetch, type SafeFetchDeps, type SafeFetchOptions } from './safe-fetch.ts';

// One link, from address to card: read the page, read its Open Graph tags, ask its oEmbed endpoint when the tags leave a hole, then fetch the picture.
// Every read goes through `safeFetch` (public addresses only, redirects capped, size and time bounded) and through the caller's `check` (the
// workspace's allow and deny lists and the egress guard), so the picture's host and the oEmbed host are judged exactly like the page's host.

/** The page: at most 1 MiB is read (the tags we want are near the top), in at most 3 seconds, after at most 3 redirects. */
export const PAGE_LIMITS = { maxBytes: 1024 * 1024, timeoutMs: 3000, maxRedirects: 3 } as const;
/** The oEmbed answer is JSON and small. */
export const OEMBED_LIMITS = { maxBytes: 256 * 1024, timeoutMs: 3000, maxRedirects: 3 } as const;
/** The picture: whole or nothing, at most 512 KiB (a card shows it at 88 pixels), in at most 3 seconds. */
export const IMAGE_LIMITS = { maxBytes: 512 * 1024, timeoutMs: 3000, maxRedirects: 3 } as const;
/** The whole job (page, oEmbed and picture together) is over after this long, whatever each read was still allowed. */
export const OVERALL_MS = 8000;

export interface FetchedPreview {
  status: 'ok' | 'failed' | 'blocked';
  /** A short machine word for the log and the cache row: why a read failed. Never page text. */
  reason: string;
  finalUrl: string | null;
  title: string | null;
  description: string | null;
  siteName: string | null;
  image: { bytes: Buffer; type: LinkPreviewImageType } | null;
}

const NOTHING = { finalUrl: null, title: null, description: null, siteName: null, image: null } as const;

const HTML_TYPE = /^\s*(?:$|(?:text\/html|application\/xhtml\+xml)\b)/i;
const JSON_TYPE = /^\s*(application|text)\/([a-z0-9.+-]*\+)?json\b/i;
const IMAGE_ACCEPT = 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1';

/** The failures that say "this site is not answering" (not a 404 or a page of the wrong kind): three in a row open the host's breaker. */
const COUNTED_FAILURES = new Set(['timeout', 'network', 'dns_failed']);

export interface FetchPreviewExtras {
  /** Asked before each read of a host and told how it went. */
  breaker?: HostBreaker;
  /** Time for the whole job. Default `OVERALL_MS`. */
  overallMs?: number;
  now?: () => number;
}

type Limits = typeof PAGE_LIMITS | typeof IMAGE_LIMITS | typeof OEMBED_LIMITS;

const refusalOf = (err: unknown): FetchedPreview => {
  if (err instanceof SafeFetchError) {
    const blocked = err.code.startsWith('blocked_');
    return { status: blocked ? 'blocked' : 'failed', reason: err.code, ...NOTHING };
  }
  return { status: 'failed', reason: 'error', ...NOTHING };
};

/** Fills the holes of the page's own tags with what its oEmbed endpoint said. The page wins where both have a value. */
const merge = (page: PageMeta, extra: PageMeta): PageMeta => ({
  title: page.title ?? extra.title,
  description: page.description ?? extra.description,
  siteName: page.siteName ?? extra.siteName,
  image: page.image ?? extra.image,
  oembed: page.oembed,
});

/**
 * Reads one address for its card. Never throws: a refusal or a failure is a `FetchedPreview` with a status and a reason, so the caller can remember
 * it (a failed read is not retried for an hour). `check` runs for every address that would be requested, the page's, each redirect's, the oEmbed
 * endpoint's and the picture's. The whole call ends by `extras.overallMs` (8 seconds) however the reads share it.
 */
export async function fetchPreview(
  address: string,
  check: SafeFetchOptions['check'],
  deps: SafeFetchDeps = DEFAULT_DEPS,
  extras: FetchPreviewExtras = {},
): Promise<FetchedPreview> {
  const now = extras.now ?? Date.now;
  const deadlineAt = now() + (extras.overallMs ?? OVERALL_MS);
  const { breaker } = extras;

  // Every read: the breaker of the host first, then the guarded fetch under the job's one deadline, then the breaker is told how it went.
  const read = async (target: string, l: Limits, o: Pick<SafeFetchOptions, 'overflow' | 'accept' | 'contentType'>) => {
    let host: string | null = null;
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch {
      host = null; // safeFetch refuses it with its own word
    }
    if (breaker && host !== null && !breaker.allow(host)) throw new SafeFetchError('host_cooling', 'That site did not answer lately; it is not asked again for a few minutes.');
    try {
      const result = await safeFetch(target, { ...l, ...o, deadlineAt, ...(check ? { check } : {}) }, deps);
      if (host !== null) breaker?.success(host);
      return result;
    } catch (err) {
      if (host !== null && err instanceof SafeFetchError && COUNTED_FAILURES.has(err.code)) breaker?.failure(host);
      throw err;
    }
  };

  let page;
  try {
    page = await read(address, PAGE_LIMITS, { overflow: 'truncate', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', contentType: HTML_TYPE });
  } catch (err) {
    return refusalOf(err);
  }
  let meta = parseHtmlMeta(decodeHtml(page.body, page.contentType), page.url);

  if (meta.oembed !== null && (meta.title === null || meta.image === null)) {
    try {
      const endpoint = await read(meta.oembed, OEMBED_LIMITS, { overflow: 'fail', accept: 'application/json', contentType: JSON_TYPE });
      meta = merge(meta, parseOembed(endpoint.body.toString('utf8'), endpoint.url));
    } catch {
      // the page's own tags still make a card; a refused or failed oEmbed read only leaves the holes
      meta = merge(meta, EMPTY_META);
    }
  }
  if (!hasContent(meta)) return { status: 'failed', reason: 'no_metadata', ...NOTHING, finalUrl: page.url.href };

  let image: FetchedPreview['image'] = null;
  if (meta.image !== null) {
    try {
      const picture = await read(meta.image, IMAGE_LIMITS, { overflow: 'fail', accept: IMAGE_ACCEPT });
      const type = sniffImage(picture.body);
      // the size the picture says it has, from its own header: a small file can decode to a huge bitmap, and a header that cannot be read is a no
      if (type !== null && imageSizeAllowed(picture.body, type)) image = { bytes: picture.body, type };
    } catch {
      // a card without its picture is still a card
    }
  }
  if (meta.title === null && meta.description === null && image === null) {
    return { status: 'failed', reason: 'no_metadata', ...NOTHING, finalUrl: page.url.href };
  }
  return { status: 'ok', reason: '', finalUrl: page.url.href, title: meta.title, description: meta.description, siteName: meta.siteName, image };
}
