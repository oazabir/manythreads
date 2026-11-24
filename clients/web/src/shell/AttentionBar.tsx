import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { GetAttentionResponse, getAttentionRoute, type AttentionProblem } from '@manythreads/shared';
import { call } from '../api/client';
import { isAdmin, useSession } from '../app/session';

/*
 * The bar at the top of the screen (owner request 2026-11-24): a Claude Code, Codex or Hermes sign-in that expired or was refused, or a model key the provider refused, so the
 * bots that depend on it cannot work. Only for the people who can fix it (workspace owners and admins; the server answers anyone else with nothing). Asked again every two
 * minutes and when the tab comes back. "Hide" hides that one problem for this tab's session; a new problem still shows.
 */

const HIDDEN_KEY = 'manythreads.attention-hidden';
const EVERY_MS = 120_000;

const readHidden = (): Set<string> => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};

export function AttentionBar() {
  const session = useSession();
  const admin = isAdmin(session);
  const [problems, setProblems] = useState<AttentionProblem[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(readHidden);

  const load = useCallback(async () => {
    try {
      setProblems((await call(getAttentionRoute, { response: GetAttentionResponse })).problems);
    } catch {
      /* the bar is a hint: a failed read leaves the last answer */
    }
  }, []);

  useEffect(() => {
    if (!admin) return undefined;
    void load();
    const timer = window.setInterval(() => void load(), EVERY_MS);
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [admin, load]);

  if (!admin) return null;
  const shown = problems.filter((p) => !hidden.has(p.key));
  if (shown.length === 0) return null;
  const hide = (key: string): void => {
    const next = new Set(hidden).add(key);
    setHidden(next);
    try {
      sessionStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    } catch {
      /* private mode: hidden for this page only */
    }
  };
  return (
    <div className="attn" role="alert" data-testid="attention-bar">
      {shown.slice(0, 3).map((p) => (
        <div key={p.key} className="attn-row" data-kind={p.kind} data-testid="attention-problem">
          <span className="attn-dot" aria-hidden="true" />
          <span className="attn-text">{p.text}</span>
          <Link className="btn sm attn-fix" to={p.link} onClick={() => window.setTimeout(() => void load(), 30_000)}>{p.action}</Link>
          <button type="button" className="attn-hide" onClick={() => hide(p.key)} aria-label="Hide this warning for now">Hide</button>
        </div>
      ))}
      {shown.length > 3 ? <div className="attn-more">{`And ${shown.length - 3} more in Settings.`}</div> : null}
    </div>
  );
}
