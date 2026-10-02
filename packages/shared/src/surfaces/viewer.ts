import { z } from 'zod';

/*
 * `provider.viewer` (SPEC section 3, section 5.2): how a plugin says "this is how a file of this kind is shown".
 * The contribution is plain data (it is what a plugin manifest carries); the web client pairs it with a lazy `load` function
 * (clients/web/src/kernel/viewers). Matching is a pure function here so the server side can answer "which viewer opens this?"
 * with the same rules later.
 */

/** What the host hands a viewer: text for editors and highlighters, a URL for media, the bytes when a viewer needs them, nothing for a card. */
export const ViewerInput = z.enum(['text', 'bytes', 'url', 'none']);
export type ViewerInput = z.infer<typeof ViewerInput>;

const Ext = z.string().regex(/^[a-z0-9]{1,12}$/);
const MimePattern = z.string().regex(/^[a-z0-9.+-]+\/([a-z0-9.+-]+|\*)$/);
const PathGlob = z.string().min(1).max(200);

/** A viewer matches when ANY of `mime`, `ext`, `path` matches (and every other given condition holds). */
export const ViewerMatch = z.strictObject({
  /** `application/pdf`, or `image/*` for a family. */
  mime: z.array(MimePattern).max(40).optional(),
  /** Lowercase, no dot: `ts`, `md`. */
  ext: z.array(Ext).max(80).optional(),
  /** Repo-path globs: `*` stays inside a folder, `**` crosses folders (`bots/**` is every file under bots; `pages/*.md` the pages directly in pages). */
  path: z.array(PathGlob).max(40).optional(),
  /** Top-level keys the file's YAML frontmatter must all carry (`google`). Only meaningful for text files. */
  frontmatter: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)).max(10).optional(),
  /** `file` (default) or a `folder`, matched on the names it holds. */
  folder: z
    .strictObject({
      has: z.array(z.string().min(1).max(200)).max(10),
      lacks: z.array(z.string().min(1).max(200)).max(10).default([]),
    })
    .optional(),
});
export type ViewerMatch = z.infer<typeof ViewerMatch>;

export const ViewerContribution = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1).max(40),
  /** The higher number wins; equal priorities keep the later registration. Built-ins use 0..100, a catch-all card uses -100. */
  priority: z.number().int().min(-100).max(1000).default(0),
  match: ViewerMatch,
  input: ViewerInput.default('url'),
  /** A viewer that can write back (`onSave`). The host still passes `readOnly` when the person may not. */
  editable: z.boolean().default(false),
  /** Matches every file: the last resort (a download card). */
  fallback: z.boolean().default(false),
});
export type ViewerContribution = z.input<typeof ViewerContribution>;
export type ViewerContributionParsed = z.output<typeof ViewerContribution>;

/** What is being opened. */
export type ViewerSubject = {
  /** Repo-relative path (`pages/reports/signups.csv`), or the folder path for a folder. */
  path: string;
  /** Lowercase mime type when known (`application/pdf`); an empty or missing value falls back to the extension. */
  mime?: string | undefined;
  kind?: 'file' | 'folder' | undefined;
  /** Names directly inside a folder. */
  entries?: readonly string[] | undefined;
  /** Top-level frontmatter keys, once the text is known. */
  frontmatterKeys?: readonly string[] | undefined;
};

export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** Glob match without regular expressions (linear, no backtracking blow-up): `*` inside a segment, `**` across segments. */
export function matchPathGlob(glob: string, path: string): boolean {
  const g = glob.split('/');
  const p = path.split('/');
  const segment = (pat: string, s: string): boolean => {
    // two-pointer wildcard match for `*` inside one segment
    let pi = 0;
    let si = 0;
    let star = -1;
    let mark = 0;
    while (si < s.length) {
      if (pi < pat.length && pat[pi] === '*') {
        star = pi++;
        mark = si;
      } else if (pi < pat.length && pat[pi] === s[si]) {
        pi++;
        si++;
      } else if (star >= 0) {
        pi = star + 1;
        si = ++mark;
      } else return false;
    }
    while (pi < pat.length && pat[pi] === '*') pi++;
    return pi === pat.length;
  };
  // dynamic programme over segments so `**` is O(g * p)
  const memo = new Map<number, boolean>();
  const go = (gi: number, pi: number): boolean => {
    const key = gi * (p.length + 1) + pi;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let out: boolean;
    if (gi === g.length) out = pi === p.length;
    else if (g[gi] === '**') out = go(gi + 1, pi) || (pi < p.length && go(gi, pi + 1));
    else out = pi < p.length && segment(g[gi] ?? '', p[pi] ?? '') && go(gi + 1, pi + 1);
    memo.set(key, out);
    return out;
  };
  return go(0, 0);
}

const mimeMatches = (pattern: string, mime: string): boolean =>
  pattern.endsWith('/*') ? mime.startsWith(pattern.slice(0, -1)) : pattern === mime;

/** Does this contribution claim the subject? Folders match only folder rules; files never match a folder rule. */
export function viewerMatches(c: ViewerContribution, subject: ViewerSubject): boolean {
  const m = c.match;
  if (c.fallback) return (subject.kind ?? 'file') === 'file';
  if (m.folder) {
    if (subject.kind !== 'folder') return false;
    const names = new Set(subject.entries ?? []);
    return m.folder.has.every((n) => names.has(n)) && (m.folder.lacks ?? []).every((n) => !names.has(n));
  }
  if (subject.kind === 'folder') return false;
  if (m.frontmatter && !m.frontmatter.every((k) => subject.frontmatterKeys?.includes(k))) return false;
  const mime = (subject.mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  const ext = extensionOf(subject.path);
  const byMime = mime !== '' && (m.mime ?? []).some((p) => mimeMatches(p, mime));
  const byExt = ext !== '' && (m.ext ?? []).includes(ext);
  const byPath = (m.path ?? []).some((g) => matchPathGlob(g, subject.path));
  if (!m.mime && !m.ext && !m.path) return m.frontmatter !== undefined; // frontmatter alone (rare)
  return byMime || byExt || byPath;
}

/** Contributions in the order they were given (earlier first) to the one that opens the subject; undefined when nothing claims it. */
export function pickViewerContribution<T extends ViewerContribution>(items: readonly T[], subject: ViewerSubject): T | undefined {
  let best: T | undefined;
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (!viewerMatches(item, subject)) continue;
    const priority = item.priority ?? 0;
    if (priority >= bestPriority) {
      best = item;
      bestPriority = priority;
    }
  }
  return best;
}

/* ---- embedded apps (SPEC 5.2, PLAN P4-10) ---- */

/**
 * The content route of a repo folder that is an app. Contract (served by repo-git/files; the dev server mocks it):
 *   GET /api/teams/:slug/repo/app/<folder>/<file...>
 * answers the file with its mime type and the headers below, on the session cookie and the folder's read access.
 */
export const repoAppPath = (slug: string, folder: string, file = 'index.html'): string => {
  // `.` and `..` never reach the URL (a browser would resolve them before the server could refuse them)
  const enc = (s: string): string => s.split('/').filter((seg) => seg !== '' && seg !== '.' && seg !== '..').map(encodeURIComponent).join('/');
  return `/api/teams/${encodeURIComponent(slug)}/repo/app/${enc(folder)}/${enc(file)}`;
};

/** The route as a Fastify/URL-pattern prefix; the server adds the app headers to every response under it. */
export const REPO_APP_PATH_RE = /^\/api\/teams\/[^/]+\/repo\/app\//;

/** The same route as Fastify names it once matched (`req.routeOptions.url`): server hooks key on this, never on the raw request URL. */
export const REPO_APP_ROUTE_PREFIX = '/api/teams/:slug/repo/app/';

/** `sandbox` attribute of the iframe: scripts only. Never `allow-same-origin` (that would hand the app our cookies and DOM). */
export const EMBEDDED_APP_SANDBOX = 'allow-scripts';

/** CSP sent with every embedded-app file (PLAN P4-10). `connect-src 'none'`: an app cannot call /api or anything else. */
export const EMBEDDED_APP_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob: 'self'; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'";

/**
 * The bridge between an embedded app and the page that frames it (window.postMessage; the app's origin is opaque).
 * One method is allowlisted: `getContext`, which answers the app's folder and the team's name, nothing else.
 */
export const APP_BRIDGE_METHODS = ['getContext'] as const;

export const AppBridgeRequest = z.strictObject({
  channel: z.literal('manythreads.app'),
  id: z.string().min(1).max(64),
  method: z.enum(APP_BRIDGE_METHODS),
});
export type AppBridgeRequest = z.infer<typeof AppBridgeRequest>;

export const AppBridgeContext = z.strictObject({ app: z.string(), team: z.string() });
export type AppBridgeContext = z.infer<typeof AppBridgeContext>;

export const AppBridgeResponse = z.discriminatedUnion('ok', [
  z.strictObject({ channel: z.literal('manythreads.host'), id: z.string(), ok: z.literal(true), result: AppBridgeContext }),
  z.strictObject({ channel: z.literal('manythreads.host'), id: z.string(), ok: z.literal(false), error: z.string() }),
]);
export type AppBridgeResponse = z.infer<typeof AppBridgeResponse>;

/** A virtual file every app folder can load (`<script src="__manythreads.js">`): the content route answers it with the client below. */
export const APP_BRIDGE_CLIENT_FILE = '__manythreads.js';

/** The app side of the bridge: `manythreads.getContext()` resolves `{ app, team }` (the framing page answers over postMessage). */
export const APP_BRIDGE_CLIENT_JS =
  "(function(){var pending={},n=0;window.addEventListener('message',function(e){var m=e.data;if(!m||m.channel!=='manythreads.host'||e.source!==window.parent)return;var p=pending[m.id];if(!p)return;delete pending[m.id];if(m.ok)p.res(m.result);else p.rej(new Error(m.error))});window.manythreads={getContext:function(){return new Promise(function(res,rej){var id='r'+(++n);pending[id]={res:res,rej:rej};window.parent.postMessage({channel:'manythreads.app',id:id,method:'getContext'},'*')})}}})();";

/** Headers for every response of the app content route. `nosniff` keeps a text file from being run as a script by sniffing. */
export const embeddedAppHeaders = (): Record<string, string> => ({
  // `sandbox allow-scripts` as a header too: the same lock as the iframe attribute, so a file opened directly (not in our frame) is an opaque
  // origin as well and cannot reach the cookies or the DOM of the page it is served from.
  'content-security-policy': `${EMBEDDED_APP_CSP}; sandbox ${EMBEDDED_APP_SANDBOX}`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-cache',
});
