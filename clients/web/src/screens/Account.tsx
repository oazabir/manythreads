import { useState } from 'react';
import { useNavigate } from 'react-router';
import { isApiError } from '../api/client';
import { fetchSessions, requestPasswordReset, revokeSession, signOut, signOutEverywhere } from '../api/endpoints';
import { useSession, useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { PlainFrame } from '../components/frames';
import { QueryView } from '../components/states';
import { Alert, Notice, Time } from '../components/ui';

export function Account() {
  const session = useSession();
  const { setSession } = useSessionState();
  const navigate = useNavigate();
  const sessions = useQuery('account-sessions', fetchSessions);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  const leave = () => {
    setSession(null);
    navigate('/sign-in', { replace: true });
  };

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setError(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Try again.');
    }
  }

  return (
    <PlainFrame title={`Account · ${session.person.name.split(' ')[0]}`}>
      {error ? <Alert>{error}</Alert> : null}

      <section className="block" aria-labelledby="acc-profile" data-landmark="profile">
        <h2 className="bh" id="acc-profile">Profile</h2>
        <div className="block-body">
          <div className="kv"><span className="k">Name</span><span>{session.person.name}</span></div>
          <div className="kv"><span className="k">Email</span><span>{session.person.email}</span></div>
          <div className="kv"><span className="k">Workspace</span><span>{session.workspace.name} · {session.role}</span></div>
          {session.methods.some((m) => m.kind === 'password') ? (
            <div className="kv">
              <span className="k">Password</span>
              <span>
                <button type="button" className="btn" onClick={() => run(() => requestPasswordReset(session.person.email), () => setResetSent(true))}>
                  Email me a reset link
                </button>
              </span>
            </div>
          ) : null}
          {resetSent ? <Notice>A link to choose a new password is on its way to {session.person.email}.</Notice> : null}
        </div>
      </section>

      <section className="block" aria-labelledby="acc-sessions" data-landmark="sessions">
        <h2 className="bh" id="acc-sessions">Sessions</h2>
        <QueryView q={sessions}>
          {({ sessions: list }) => (
            <>
              <ul className="rows">
                {list.map((s) => (
                  <li key={s.id} className="srow" data-current={s.current || undefined}>
                    <div>
                      <div>{s.label}{s.current ? ' (this browser)' : ''}</div>
                      <div className="d">Last active <Time iso={s.lastSeenAt} /></div>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Sign out ${s.label}${s.current ? ' (this browser)' : ''}`}
                      onClick={() => run(async () => { if (s.current) await signOut(); else await revokeSession(s.id); }, () => { if (s.current) leave(); else sessions.reload(); })}
                    >
                      Sign out
                    </button>
                  </li>
                ))}
              </ul>
              <div className="block-body">
                <button type="button" className="btn" onClick={() => run(signOutEverywhere, leave)}>Sign out everywhere</button>
              </div>
            </>
          )}
        </QueryView>
      </section>

      <section className="block" aria-labelledby="acc-methods" data-landmark="methods">
        <h2 className="bh" id="acc-methods">Sign-in methods</h2>
        <div className="block-body chips">
          {session.methods.map((m) => (
            <span key={`${m.kind}-${m.label}`} className="chip ok">{m.label} ok</span>
          ))}
        </div>
      </section>
    </PlainFrame>
  );
}
