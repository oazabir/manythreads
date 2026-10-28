import { z } from 'zod';

/*
 * Mermaid runs inside a sandboxed iframe (`sandbox="allow-scripts"`, no same-origin): its own opaque origin, no access to our
 * DOM, cookies or storage, and a CSP that forbids every network request. The frame loads a page of our own (not an inline `srcdoc`, which would
 * inherit the app page's policy), so the app page can forbid inline script. A Web Worker cannot host it (Mermaid draws through the
 * DOM), the iframe can. The page talks to it by postMessage only; the diagram's SVG never enters our DOM.
 */

export const MERMAID_CHANNEL = 'manythreads.mermaid';

/** What the sandbox sends back. `height` is the diagram's pixel height so the frame can fit it. */
export const SandboxMessage = z.discriminatedUnion('type', [
  z.strictObject({ channel: z.literal(MERMAID_CHANNEL), type: z.literal('ready') }),
  z.strictObject({ channel: z.literal(MERMAID_CHANNEL), type: z.literal('rendered'), id: z.number().int(), height: z.number().min(0).max(100_000) }),
  z.strictObject({ channel: z.literal(MERMAID_CHANNEL), type: z.literal('error'), id: z.number().int(), message: z.string().max(10_000) }),
]);
export type SandboxMessage = z.infer<typeof SandboxMessage>;

export function parseSandboxMessage(data: unknown): SandboxMessage | null {
  const r = SandboxMessage.safeParse(data);
  return r.success ? r.data : null;
}

export type MermaidState =
  | { status: 'loading' }
  | { status: 'ready'; height: number }
  | { status: 'error'; message: string };

/** The reduction of one sandbox message for the render request `current`. Replies for older requests are ignored. */
export function reduceMermaid(state: MermaidState, msg: SandboxMessage, current: number): MermaidState {
  if (msg.type === 'ready') return state;
  if (msg.id !== current) return state;
  if (msg.type === 'rendered') return { status: 'ready', height: Math.max(40, Math.ceil(msg.height)) };
  return { status: 'error', message: msg.message.trim() || 'The diagram has a syntax error.' };
}

export const RENDER_TIMEOUT_MS = 15_000;

/** The sandbox page: a file of this site (`public/mermaid-sandbox.html`) that loads `public/mermaid-sandbox.js` and then the Mermaid bundle. */
export const SANDBOX_PAGE = '/mermaid-sandbox.html';

/**
 * The page's own policy, sent as a header by the web server (`deploy/docker/nginx.conf` repeats it; a test keeps the two equal): scripts of this
 * site only and no inline script, nothing can be fetched, framed or posted to, and only our own page may frame it.
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/** Where the frame loads from: the page, told the address of the bundle (an asset of this build). Anything but a path of this site is refused. */
export function sandboxUrl(bundlePath: string): string {
  if (!/^\/[A-Za-z0-9_.@/-]+\.js$/.test(bundlePath) || bundlePath.includes('//') || bundlePath.includes('..')) throw new Error('not a script of this site');
  return `${SANDBOX_PAGE}?bundle=${encodeURIComponent(bundlePath)}`;
}
