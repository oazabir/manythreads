import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// The browser build of Mermaid is a file of this build (an asset of our origin); the sandbox page loads it by this address.
import bundleUrl from 'mermaid/dist/mermaid.min.js?url';
import type { ViewerProps } from '../kernel/viewers';
import { ViewerBar } from './common';
import { RENDER_TIMEOUT_MS, parseSandboxMessage, reduceMermaid, type MermaidState, MERMAID_CHANNEL, sandboxUrl } from './mermaid/sandbox';

/**
 * Mermaid diagram in a sandboxed frame, with a Source toggle. A syntax error never throws: the message and the source are shown
 * (PLAN criterion 8).
 */
export default function MermaidViewer({ path, text = '' }: ViewerProps) {
  const [state, setState] = useState<MermaidState>({ status: 'loading' });
  const [showSource, setShowSource] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const request = useRef(0);
  const ready = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const src = useMemo(() => sandboxUrl(bundleUrl), []);

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
        <iframe
          ref={frame}
          className="mm-frame"
          title={`Diagram ${path}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={src}
          style={{ height: state.status === 'ready' ? state.height : 160 }}
        />
      </div>
      {showSource || failed ? (
        <pre className="mm-source" data-testid="mermaid-source" aria-label="Diagram source">{text}</pre>
      ) : null}
    </div>
  );
}
