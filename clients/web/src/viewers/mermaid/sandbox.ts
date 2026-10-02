import { z } from 'zod';

/*
 * Mermaid runs inside a sandboxed iframe (`sandbox="allow-scripts"`, no same-origin): its own opaque origin, no access to our
 * DOM, cookies or storage, and a CSP that forbids every network request. A Web Worker cannot host it (Mermaid draws through the
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

/** The sandbox page's own CSP: inline script and style only; nothing can be fetched, framed or connected to. */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** Script text that is safe inside an inline `<script>` element. */
export const escapeForScript = (js: string): string => js.replace(/<\/(script)/gi, '<\\/$1').replaceAll('<!--', '<\\!--');

/** The code that runs in the sandbox next to the Mermaid bundle (kept small and in one place). */
const SANDBOX_RUNTIME = `
(function () {
  var host = window.parent;
  var CH = ${JSON.stringify(MERMAID_CHANNEL)};
  var out = document.getElementById('out');
  var post = function (m) { m.channel = CH; host.postMessage(m, '*'); };
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true, fontFamily: 'Inter Tight, system-ui, sans-serif' });
  } catch (e) { /* reported on the first render */ }
  var n = 0;
  window.addEventListener('message', function (ev) {
    if (ev.source !== host) return;
    var m = ev.data;
    if (!m || m.channel !== CH || m.type !== 'render' || typeof m.source !== 'string') return;
    var id = m.id;
    Promise.resolve()
      .then(function () { return mermaid.parse(m.source); })
      .then(function () { return mermaid.render('d' + (++n), m.source); })
      .then(function (r) {
        out.innerHTML = r.svg;
        post({ type: 'rendered', id: id, height: document.documentElement.scrollHeight });
      })
      .catch(function (e) {
        out.textContent = '';
        post({ type: 'error', id: id, message: String((e && (e.str || e.message)) || e) });
      });
  });
  post({ type: 'ready' });
})();
`;

/** The whole `srcdoc` of the sandbox: policy, style, the Mermaid bundle (text) and the runtime above. */
export function buildSandboxDoc(mermaidBundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">
<style>html,body{margin:0;padding:0;background:transparent}#out{display:block}#out svg{max-width:100%;height:auto;display:block;margin:0 auto}</style>
</head><body><div id="out"></div><script>${escapeForScript(mermaidBundle)}</script><script>${SANDBOX_RUNTIME}</script></body></html>`;
}
