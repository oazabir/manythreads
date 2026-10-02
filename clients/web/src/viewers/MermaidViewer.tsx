import { useCallback, useEffect, useRef, useState } from 'react';
// The browser build of Mermaid is a file of this build (an asset of our origin); it is read as text and handed to the sandbox.
import bundleUrl from 'mermaid/dist/mermaid.min.js?url';
import type { ViewerProps } from '../kernel/viewers';
import { ViewerBar } from './common';
import { RENDER_TIMEOUT_MS, buildSandboxDoc, parseSandboxMessage, reduceMermaid, type MermaidState, MERMAID_CHANNEL } from './mermaid/sandbox';

let sandboxDoc: Promise<string> | undefined;
/** The srcdoc, built once per page load (the bundle is several MB: fetch it once, from our own origin). */
const loadSandboxDoc = (): Promise<string> => {
  sandboxDoc ??= fetch(bundleUrl, { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error(`renderer ${r.status}`);
      return r.text();
    })
    .then(buildSandboxDoc)
    .catch((err: unknown) => {
      sandboxDoc = undefined;
      throw err;
    });
  return sandboxDoc;
};

/**
 * Mermaid diagram in a sandboxed frame, with a Source toggle. A syntax error never throws: the message and the source are shown
 * (PLAN criterion 8).
 */
export default function MermaidViewer({ path, text = '' }: ViewerProps) {
  const [doc, setDoc] = useState<string | null>(null);
  const [state, setState] = useState<MermaidState>({ status: 'loading' });
  const [showSource, setShowSource] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const request = useRef(0);
  const ready = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    loadSandboxDoc().then(
      (d) => alive && setDoc(d),
      () => alive && setState({ status: 'error', message: 'The diagram renderer could not be loaded.' }),
    );
    return () => {
      alive = false;
    };
  }, []);

  const render = useCallback(() => {
    const win = frame.current?.contentWindow;
    if (!win || !ready.current) return;
    const id = ++request.current;
    setState({ status: 'loading' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (request.current === id) setState({ status: 'error', message: 'The diagram took too long to draw.' });
    }, RENDER_TIMEOUT_MS);
    win.postMessage({ channel: MERMAID_CHANNEL, type: 'render', id, source: text }, '*');
  }, [text]);

  // replies: only from our own frame, only well-formed
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!frame.current || ev.source !== frame.current.contentWindow) return;
      const msg = parseSandboxMessage(ev.data);
      if (!msg) return;
      if (msg.type === 'ready') {
        ready.current = true;
        render();
        return;
      }
      if (msg.id === request.current) window.clearTimeout(timer.current);
      setState((s) => reduceMermaid(s, msg, request.current));
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer.current);
    };
  }, [render]);

  // a new source after the frame is ready
  useEffect(() => {
    if (ready.current) render();
  }, [render]);

  const failed = state.status === 'error';
  return (
    <div className="vw mermaid" data-testid="viewer-mermaid" data-state={state.status}>
      <ViewerBar path={path}>
        <button type="button" className="btn sm" aria-pressed={showSource || failed} disabled={failed} onClick={() => setShowSource((v) => !v)}>Source</button>
      </ViewerBar>
      {failed ? (
        <div className="mm-error" role="alert" data-testid="mermaid-error">
          <p className="mm-error-title">This diagram could not be drawn</p>
          <pre className="mm-error-msg" data-testid="mermaid-error-message">{state.message}</pre>
        </div>
      ) : null}
      <div className="mm-stage" data-off={failed || showSource ? '' : undefined} aria-busy={state.status === 'loading'}>
        {doc ? (
          <iframe
            ref={frame}
            className="mm-frame"
            title={`Diagram ${path}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={doc}
            style={{ height: state.status === 'ready' ? state.height : 160 }}
          />
        ) : null}
      </div>
      {showSource || failed ? (
        <pre className="mm-source" data-testid="mermaid-source" aria-label="Diagram source">{text}</pre>
      ) : null}
    </div>
  );
}
