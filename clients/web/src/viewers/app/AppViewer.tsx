import { useEffect, useRef, useState } from 'react';
import { AppBridgeRequest, EMBEDDED_APP_SANDBOX, type AppBridgeResponse } from '@manythreads/shared';
import type { ViewerProps } from '../../kernel/viewers';
import { baseName } from '../mime';

export const APP_COPY = 'This app cannot read your session or other files.';

/**
 * The reply to one bridge request, or null when the message is not ours (not shaped like a request: ignored, never answered).
 * `getContext` is the only method; it carries the app's folder and the team's name, nothing about the person or the session.
 */
export function answerBridge(data: unknown, ctx: { app: string; team: string }): AppBridgeResponse | null {
  const parsed = AppBridgeRequest.safeParse(data);
  if (!parsed.success) {
    // a request with an unknown method still gets an answer (an error), so the app does not hang
    const raw = data as { channel?: unknown; id?: unknown } | null;
    if (raw && typeof raw === 'object' && raw.channel === 'manythreads.app' && typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64) {
      return { channel: 'manythreads.host', id: raw.id, ok: false, error: 'Unknown method.' };
    }
    return null;
  }
  return { channel: 'manythreads.host', id: parsed.data.id, ok: true, result: { app: ctx.app, team: ctx.team } };
}

/**
 * An embedded app: a repo folder with an `index.html` and no `index.md`, served by the content route (`repoAppPath`) with a strict
 * CSP and shown in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`. The app runs on an opaque origin: it has no
 * cookies, no storage and no DOM of ours; the only way out is the postMessage bridge below.
 */
export default function AppViewer({ path, url, context }: ViewerProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [info, setInfo] = useState(false);
  const name = baseName(path);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      // only the frame we made may talk to the bridge
      const win = frame.current?.contentWindow;
      if (!win || ev.source !== win) return;
      const reply = answerBridge(ev.data, { app: path, team: context.teamName });
      // the app's origin is opaque ("null"), so the only target is that window itself
      if (reply) win.postMessage(reply, '*');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [path, context.teamName]);

  return (
    <div className="vw app" data-testid="viewer-app">
      <div className="app-head">
        <span className="app-path" title={path}>{path.replace(/\/+$/, '')}/</span>
        <span className="app-badge" data-testid="app-badge">
          Sandboxed app
          <button type="button" className="app-info" aria-label="About sandboxed apps" aria-expanded={info} title={APP_COPY} onClick={() => setInfo((v) => !v)}>(i)</button>
        </span>
      </div>
      {info ? <p className="app-about" role="note">Apps run in a locked frame. They have no access to your sign-in, to other files or to the network.</p> : null}
      <iframe
        ref={frame}
        className="app-frame"
        title={`App ${name}`}
        data-testid="app-frame-embed"
        sandbox={EMBEDDED_APP_SANDBOX}
        referrerPolicy="no-referrer"
        src={url}
      />
      <p className="vw-note app-note">{APP_COPY}</p>
    </div>
  );
}
