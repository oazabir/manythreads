import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { BotRunner, BotServer, BotServerCode, ListBotServersResponse } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { useQuery } from '../../../app/useQuery';
import { Dialog } from '../../../components/Dialog';
import { QueryView } from '../../../components/states';
import { Alert, Field } from '../../../components/ui';
import { AgentSignInDialog } from './AgentSignInDialog';
import { fetchBotRunners } from './api';
import { createBotServer, deleteBotServer, fetchBotServers, mintBotServerCode, rotateBotServerKey } from './servers-api';
import {
  AGENT_TITLE,
  HASH_NOTE,
  REACH_NOTE,
  SIGNIN_NOTE,
  agentLine,
  askCommand,
  carefulSteps,
  codeWords,
  hasOwnSignin,
  hostLine,
  installCommand,
  removeWords,
  removedWords,
  rotateWords,
  rotatedWords,
  serverNameProblem,
  statusWords,
  suggestServerName,
  waitingWords,
} from './servers';

/*
 * Servers (PLAN P26-13, docs/plans/agents-anywhere.md §5.1). A server is a machine of your own where the installer put the agent bridge: you press "Add a server", paste one
 * command there, and the machine shows up with the agents it has, each with a Sign-in button. Each agent becomes a runner (listed above) that you share with teams like any
 * other. The page shows the command once (the code in it works once, for 15 minutes); the careful way and the variant that asks for the code on the keyboard are under it.
 * Rotate key and Remove server are here too. No key is ever shown: the page says only whether one exists.
 */

const message = (e: unknown): string => (isApiError(e) ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');
const site = (): string => window.location.origin;

type Dialogs =
  | { kind: 'add' }
  | { kind: 'code'; server: BotServer }
  | { kind: 'rotate'; server: BotServer }
  | { kind: 'remove'; server: BotServer }
  | { kind: 'signin'; runner: BotRunner }
  | null;

export function ServersSection({ onRunnersChanged }: { onRunnersChanged?: () => void } = {}) {
  const q = useQuery('servers-section', async () => {
    const [servers, runners] = await Promise.all([fetchBotServers(), fetchBotRunners().catch(() => ({ items: [] as BotRunner[] }))]);
    return { servers, runners: runners.items };
  });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => setDialog(null);
  const reload = q.reload;
  // The servers and the runners above them change together: what a person did here makes the runner list read itself again; so does a server that connected or went away by itself.
  const changed = (): void => {
    reload();
    onRunnersChanged?.();
  };
  const seen = useRef<string | null>(null);
  const shape = q.status === 'ok' ? q.data.servers.items.map((s) => `${s.id}:${s.status}:${s.agents.map((a) => a.agent).join(',')}`).join('|') : null;
  useEffect(() => {
    if (shape === null) return;
    if (seen.current !== null && seen.current !== shape) onRunnersChanged?.();
    seen.current = shape;
  }, [shape, onRunnersChanged]);

  // A server that has not connected yet, or is not connected now, comes back by itself: look again every few seconds while the tab is visible.
  const waiting = q.status === 'ok' && q.data.servers.items.some((s) => s.status !== 'connected');
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload();
    }, 5000);
    return () => clearInterval(timer);
  }, [waiting, reload]);

  const say = (text: string): void => {
    setError(null);
    setNote(text);
  };

  return (
    <section className="block" aria-labelledby="servers-title" data-testid="servers-section">
      <h2 className="bh" id="servers-title">
        Servers {q.status === 'ok' ? <span className="cnt">{q.data.servers.items.length}</span> : null}
      </h2>
      <div className="block-body">
        <p className="lede">
          A server is a machine of your own where Claude Code, Codex or Hermes run for your teams. You paste one command on it; it connects out to this site, so it needs no open port.
          Each agent it has becomes a runner above.
        </p>
        <p>
          <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'add' })} data-testid="server-add">Add a server</button>
        </p>
        {error ? <Alert>{error}</Alert> : null}
        <div className="rn-status" role="status" aria-live="polite" data-testid="server-status">{note ? <p className="notice ok">{note}</p> : null}</div>
        <QueryView q={q}>
          {(data) => (
            <>
              {data.servers.items.length === 0 ? (
                <p className="faint" data-testid="server-none">No server yet.</p>
              ) : (
                <ul className="rn-list" data-testid="server-list">
                  {data.servers.items.map((s) => (
                    <ServerRow
                      key={s.id}
                      server={s}
                      onCode={() => setDialog({ kind: 'code', server: s })}
                      onRotate={() => setDialog({ kind: 'rotate', server: s })}
                      onRemove={() => setDialog({ kind: 'remove', server: s })}
                      onSignin={(agent) => {
                        const runner = data.runners.find((r) => r.serverId === s.id && r.agent === agent);
                        if (runner) setDialog({ kind: 'signin', runner });
                        else setError('That agent has no runner yet. It appears when the server connects.');
                      }}
                    />
                  ))}
                </ul>
              )}
              {dialog?.kind === 'add' ? <AddServerDialog install={data.servers.install} onClose={() => { close(); changed(); }} /> : null}
              {dialog?.kind === 'code' ? <CodeDialog server={dialog.server} install={data.servers.install} onClose={() => { close(); changed(); }} /> : null}
              {dialog?.kind === 'rotate' ? (
                <ConfirmDialog
                  title="Change this server’s key"
                  words={rotateWords(dialog.server)}
                  action="Change key"
                  run={async () => {
                    await rotateBotServerKey(dialog.server.id);
                    return rotatedWords(dialog.server);
                  }}
                  onClose={close}
                  onDone={(text) => {
                    close();
                    say(text);
                    changed();
                  }}
                />
              ) : null}
              {dialog?.kind === 'remove' ? (
                <ConfirmDialog
                  title="Remove this server"
                  words={removeWords(dialog.server)}
                  action="Remove server"
                  danger
                  run={async () => {
                    await deleteBotServer(dialog.server.id);
                    return removedWords(dialog.server);
                  }}
                  onClose={close}
                  onDone={(text) => {
                    close();
                    say(text);
                    changed();
                  }}
                />
              ) : null}
              {dialog?.kind === 'signin' ? (
                <AgentSignInDialog
                  runner={data.runners.find((r) => r.id === dialog.runner.id) ?? dialog.runner}
                  onClose={() => {
                    close();
                    changed();
                  }}
                  onChanged={(text) => {
                    say(text);
                    changed();
                  }}
                />
              ) : null}
            </>
          )}
        </QueryView>
        <p className="faint" data-testid="server-reach-note">{REACH_NOTE}</p>
      </div>
    </section>
  );
}

function ServerRow({ server: s, onCode, onRotate, onRemove, onSignin }: { server: BotServer; onCode: () => void; onRotate: () => void; onRemove: () => void; onSignin: (agent: BotServer['agents'][number]['agent']) => void }) {
  const state = statusWords(s);
  const host = hostLine(s);
  return (
    <li className="rn-row" data-server={s.name} data-testid="server-row">
      <div className="rn-main">
        <div className="rn-title">
          <strong className="rn-label">{s.label}</strong>
          <span className="mono faint">{s.name}</span>
        </div>
        <div className="rn-meta">
          <span className={`rn-state ${state.tone}`} data-state={s.status} data-testid="server-state">{state.label}</span>
          {s.allowFullAccess ? <span className="rn-warn">Codex full access is allowed on this machine</span> : null}
        </div>
        {host ? <div className="rn-detail" data-testid="server-host">{host}</div> : null}
        {s.agents.length > 0 ? (
          <ul className="sv-agents" data-testid="server-agents">
            {s.agents.map((a) => (
              <li key={a.agent} data-agent={a.agent}>
                <span>{agentLine(a)}</span>
                {hasOwnSignin(a.agent) ? (
                  <button type="button" className="btn sm" onClick={() => onSignin(a.agent)} disabled={s.status !== 'connected'} aria-label={`Sign-in for ${AGENT_TITLE[a.agent]} on ${s.label}`} data-testid="server-agent-signin">Sign-in</button>
                ) : (
                  <span className="faint">no sign-in needed</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {s.agents.length > 0 ? <div className="rn-detail faint">{SIGNIN_NOTE}</div> : null}
        {!s.enrolled ? <div className="rn-detail faint">{codeWords(s)}</div> : null}
      </div>
      <div className="rn-actions">
        {!s.enrolled ? <button type="button" className="btn sm" onClick={onCode} aria-label={`Show the install command for ${s.label}`} data-testid="server-code">Install command</button> : null}
        {s.enrolled ? <button type="button" className="btn sm" onClick={onCode} aria-label={`New code for ${s.label}`} data-testid="server-new-code">New code</button> : null}
        <button type="button" className="btn sm" onClick={onRotate} disabled={s.status !== 'connected'} aria-label={`Change the key of ${s.label}`} data-testid="server-rotate">Rotate key</button>
        <button type="button" className="btn sm" onClick={onRemove} aria-label={`Remove ${s.label}`} data-testid="server-remove">Remove server</button>
      </div>
    </li>
  );
}

// ---- add ---------------------------------------------------------------------------------------------------------

function AddServerDialog({ install, onClose }: { install: ListBotServersResponse['install']; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<BotServerCode | null>(null);
  const sending = useRef(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (sending.current) return;
    const p = label.trim() === '' ? 'Give the server a name people will read.' : serverNameProblem(name);
    setProblem(p);
    setError(null);
    if (p) return;
    sending.current = true;
    try {
      setMade(await createBotServer({ name, label: label.trim() }));
    } catch (err) {
      setError(message(err));
    } finally {
      sending.current = false;
    }
  }

  if (made) return <CommandDialog code={made} install={install} onClose={onClose} />;
  return (
    <Dialog
      title="Add a server"
      onClose={onClose}
      testId="server-add-form"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="server-add" className="btn primary" data-testid="server-add-submit">Make the command</button>
        </>
      }
    >
      <form id="server-add" className="rn-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Display name"
          data-autofocus=""
          value={label}
          maxLength={80}
          placeholder="Build machine"
          hint="What people read on this page."
          onChange={(e) => {
            setLabel(e.target.value);
            if (!touched) setName(suggestServerName(e.target.value));
          }}
        />
        <Field
          label="Short name"
          className="mono"
          value={name}
          maxLength={31}
          hint="Its runners are called <name>-claude, <name>-codex and <name>-hermes. It cannot be changed later."
          {...(problem ? { error: problem } : {})}
          onChange={(e) => {
            setTouched(true);
            setName(e.target.value);
          }}
        />
        {error ? <p className="dlg-error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

/** A server that exists and has no key yet, or a new code for one that has: the same view as after "Add a server". */
function CodeDialog({ server, install, onClose }: { server: BotServer; install: ListBotServersResponse['install']; onClose: () => void }) {
  const [code, setCode] = useState<BotServerCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    mintBotServerCode(server.id).then(setCode, (e: unknown) => setError(message(e)));
  }, [server.id]);
  if (code) return <CommandDialog code={code} install={install} onClose={onClose} />;
  return (
    <Dialog title={`Install command for ${server.label}`} onClose={onClose} testId="server-code-dialog" footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error ? <p className="dlg-error" role="alert">{error}</p> : <p aria-busy="true">Making a code…</p>}
    </Dialog>
  );
}

/** The command, the careful way, the variant that asks for the code, and the wait for the machine to connect. */
function CommandDialog({ code, install, onClose }: { code: BotServerCode; install: ListBotServersResponse['install']; onClose: () => void }) {
  const [server, setServer] = useState<BotServer>(code.server);
  const [copied, setCopied] = useState<string | null>(null);
  const origin = site();
  const hash = code.install?.scriptSha256 ?? install?.scriptSha256 ?? null;
  const cert = code.install?.siteCert ?? install?.siteCert ?? null;

  const look = useCallback(async () => {
    try {
      const now = (await fetchBotServers()).items.find((s) => s.id === code.server.id);
      if (now) setServer(now);
    } catch {
      // the next look tries again
    }
  }, [code.server.id]);
  useEffect(() => {
    if (server.status === 'connected') return undefined;
    const timer = setInterval(() => void look(), 3000);
    return () => clearInterval(timer);
  }, [server.status, look]);

  const copy = (id: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
      },
      () => setCopied(null),
    );
  };
  const careful = hash ? carefulSteps(origin, hash, code.code, cert).join('\n') : null;
  const connected = server.status === 'connected';

  return (
    <Dialog title={`Install on ${code.server.label}`} onClose={onClose} wide testId="server-command" footer={<button type="button" className="btn primary" onClick={onClose} data-testid="server-command-done">{connected ? 'Done' : 'Close'}</button>}>
      {install === null && code.install === null ? <Alert>This site has no installer built in. Ask whoever runs it to build one, then try again.</Alert> : null}
      <p>Run this on the machine, as a user who may use <span className="mono">sudo</span>:</p>
      <div className="sv-cmd">
        <pre className="sv-pre mono" data-testid="server-command-text">{installCommand(origin, code.code, cert)}</pre>
        <button type="button" className="btn sm" onClick={() => copy('main', installCommand(origin, code.code, cert))} data-testid="server-copy">{copied === 'main' ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="faint">{codeWords(code.server)} It installs a program and a service, and creates a user called manythreads-bridge.</p>

      <details className="sv-more">
        <summary>The careful way</summary>
        <p>Download the script, read it, check its hash against the one here, then run it.</p>
        {careful ? (
          <div className="sv-cmd">
            <pre className="sv-pre mono" data-testid="server-careful-text">{careful}</pre>
            <button type="button" className="btn sm" onClick={() => copy('careful', careful)}>{copied === 'careful' ? 'Copied' : 'Copy'}</button>
          </div>
        ) : null}
        <p className="faint">{HASH_NOTE}</p>
      </details>

      <details className="sv-more">
        <summary>Keep the code out of your shell history</summary>
        <p>This asks for the code on the keyboard, so it is in neither the history nor the process list. Type the code when it asks.</p>
        <div className="sv-cmd">
          <pre className="sv-pre mono" data-testid="server-ask-text">{askCommand(origin, cert)}</pre>
          <button type="button" className="btn sm" onClick={() => copy('ask', askCommand(origin, cert))}>{copied === 'ask' ? 'Copied' : 'Copy'}</button>
        </div>
        <div className="sv-cmd">
          <pre className="sv-pre mono" data-testid="server-code-text">{code.code}</pre>
          <button type="button" className="btn sm" onClick={() => copy('code', code.code)}>{copied === 'code' ? 'Copied' : 'Copy the code'}</button>
        </div>
      </details>

      <div role="status" aria-live="polite" className="sv-wait" data-testid="server-wait">
        {connected ? (
          <>
            <p className="notice ok"><strong>{code.server.label}</strong> is connected.</p>
            {hostLine(server) ? <p>{hostLine(server)}</p> : null}
            <ul className="sv-agents">
              {server.agents.map((a) => (
                <li key={a.agent}>{agentLine(a)}</li>
              ))}
            </ul>
            <p className="faint">Sign each agent in from its Sign-in button on the page. {SIGNIN_NOTE}</p>
          </>
        ) : (
          <p aria-busy="true">{waitingWords(code.server.name)}</p>
        )}
      </div>
    </Dialog>
  );
}

// ---- confirm -----------------------------------------------------------------------------------------------------

function ConfirmDialog({ title, words, action, danger, run, onClose, onDone }: { title: string; words: string; action: string; danger?: boolean; run: () => Promise<string>; onClose: () => void; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  async function go(): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      onDone(await run());
    } catch (err) {
      setError(message(err));
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      testId="server-confirm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => void go()} disabled={busy} data-testid="server-confirm-go">{action}</button>
        </>
      }
    >
      <p>{words}</p>
      {error ? <p className="dlg-error" role="alert" data-testid="server-confirm-error">{error}</p> : null}
    </Dialog>
  );
}
