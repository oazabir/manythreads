import { useEffect, useRef, useState } from 'react';
import { AppBridgeRequest, EMBEDDED_APP_SANDBOX, IssueAppTokenRequest, IssueAppTokenResponse, issueAppTokenRoute, type AppBridgeResponse } from '@manythreads/shared';
import { call } from '../../api/client';
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
 * The address for the iframe. A sandboxed frame has an opaque origin and does not send the SameSite session cookie with its sub-resource
 * requests, so the signed-in page asks for a short-lived token for this one app and puts it in the address (a path segment, so the app's
 * relative URLs keep it). Until the answer arrives there is no frame; if the server cannot issue one (an older server, the dev fixtures'
 * stand-in route) the plain address is used, which works for the page itself with the cookie.
 */
function useAppSrc(slug: string, folder: string, plainUrl: string | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    // The /dev/viewers fixtures (team `_dev`) have no session and a stand-in route: no token to ask for.
    if (slug === '_dev') {
      setSrc(plainUrl ?? '');
      return;
    }
    call(issueAppTokenRoute, { request: IssueAppTokenRequest, response: IssueAppTokenResponse }, { path: folder }, { slug }, { noSessionExpiry: true }).then(
      (issued) => alive && setSrc(issued.url),
      () => alive && setSrc(plainUrl ?? ''),
    );
    return () => {
      alive = false;
    };
  }, [slug, folder, plainUrl]);
  return src;
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
  const src = useAppSrc(context.teamSlug, path, url);

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
      {src ? (
        <iframe
          ref={frame}
          className="app-frame"
          title={`App ${name}`}
          data-testid="app-frame-embed"
          sandbox={EMBEDDED_APP_SANDBOX}
          referrerPolicy="no-referrer"
          src={src}
        />
      ) : (
        <div className="vw-loading" role="status" aria-busy="true">Opening the app…</div>
      )}
      <p className="vw-note app-note">{APP_COPY}</p>
    </div>
  );
}
