import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { isApiError } from '../api/client';
import type { QueryState } from '../app/useQuery';
import { Alert, Brand } from './ui';

/** A centred message page (loading, errors, expired links). */
export function FullPageMessage({ title, detail, tone, busy, children }: {
  title: string;
  detail?: ReactNode;
  tone?: 'alert';
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="auth" data-testid="app-frame">
      <main className="auth-card" data-landmark="content" aria-busy={busy || undefined}>
        <Brand />
        <h1 className={`auth-title ${tone ?? ''}`}>{title}</h1>
        {detail ? <p className="auth-lede">{detail}</p> : null}
        {children ? <div className="auth-actions">{children}</div> : null}
      </main>
    </div>
  );
}

export function ForbiddenBody() {
  const navigate = useNavigate();
  return (
    <>
      <h1 className="auth-title">You do not have access</h1>
      <p className="auth-lede">You are signed in, but this page is not available to your account. Ask a workspace admin or the team lead if you need it.</p>
      <div className="auth-actions">
        <Link className="btn primary" to="/">Back to manythreads</Link>
        <button type="button" className="btn" onClick={() => navigate(-1)}>Go back</button>
      </div>
    </>
  );
}

export function NotFoundBody() {
  return (
    <>
      <h1 className="auth-title">Page not found</h1>
      <p className="auth-lede">That page does not exist, or it moved.</p>
      <div className="auth-actions">
        <Link className="btn primary" to="/">Back to manythreads</Link>
      </div>
    </>
  );
}

/** 403 page (route /403, also used inline when an API call is refused). */
export function ForbiddenPage() {
  return (
    <div className="auth" data-testid="app-frame">
      <main className="auth-card" data-landmark="content" role="alert">
        <Brand />
        <ForbiddenBody />
      </main>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="auth" data-testid="app-frame">
      <main className="auth-card" data-landmark="content">
        <Brand />
        <NotFoundBody />
      </main>
    </div>
  );
}

/** Expired or used one-time link (bootstrap URL, invitation). */
export function ExpiredLinkPage({ kind }: { kind: 'invitation' | 'bootstrap' }) {
  return (
    <div className="auth" data-testid="app-frame">
      <main className="auth-card" data-landmark="content">
        <Brand />
        <h1 className="auth-title">{kind === 'invitation' ? 'This invitation has expired' : 'This link has already been used'}</h1>
        <p className="auth-lede">
          {kind === 'invitation'
            ? 'Invitations stop working after a while, or once they are accepted. Ask the person who invited you to send a new one.'
            : 'The first-admin link works once. If your workspace already exists, sign in instead.'}
        </p>
        <div className="auth-actions">
          <Link className="btn primary" to="/sign-in">Go to sign in</Link>
        </div>
      </main>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty" data-landmark="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

/** Render a useQuery result: loading, 403/404/other errors with retry, or the data. */
export function QueryView<T>({ q, children }: { q: QueryState<T> & { reload: () => void }; children: (data: T) => ReactNode }) {
  if (q.status === 'loading') return <p className="loading" aria-busy="true">Loading…</p>;
  if (q.status === 'error') {
    const status = isApiError(q.error) ? q.error.status : 0;
    if (status === 403) return <div className="inline-state"><ForbiddenBody /></div>;
    if (status === 404) return <div className="inline-state"><NotFoundBody /></div>;
    return (
      <div className="inline-state">
        <Alert>{q.error.message}</Alert>
        <button type="button" className="btn" onClick={q.reload}>Try again</button>
      </div>
    );
  }
  return <>{children(q.data)}</>;
}
