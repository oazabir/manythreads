import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link } from 'react-router';
import type { BotRunner, BotRunnerKind, ListRunnerNodesResponse, OldConnection } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { useQuery } from '../../../app/useQuery';
import { Dialog } from '../../../components/Dialog';
import { Field } from '../../../components/ui';
import { adoptOldConnection, createBotRunner, deleteBotRunner, fetchRunnerNodes, setBotRunnerTeams, setRunnerNode, testBotRunner, updateBotRunner } from './api';
import {
  cardsFor,
  type KindCard,
  NODE_AUTO,
  moveWarning,
  needsMoveConfirm,
  nodeOption,
  nodeSavedWords,
  placementLine,
  singleNodeLine,
  volumesElsewhere,
  adoptWords,
  choiceOf,
  deleteWarning,
  editChanged,
  emptyForm,
  kindWords,
  nameProblem,
  suggestName,
  teamsBody,
  teamsProblem,
  testProfile,
  validateEdit,
  validateNew,
  type FormErrors,
  type RunnerFormValues,
  type TeamsChoice,
} from './commands';
import { TeamsControl, type TeamOption } from './TeamsControl';

/*
 * The dialogs of the Runners page. Each is a modal (`Dialog`): focus moves into it, Tab stays inside, Esc closes it and focus goes back to the button that
 * opened it. A failed action keeps the dialog open and says why in a sentence under the form.
 */

const message = (e: unknown): string => (isApiError(e) ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');

function FormError({ text }: { text: string | null }) {
  return text ? <p className="dlg-error" role="alert" data-testid="runner-form-error">{text}</p> : null;
}

// ---- add -------------------------------------------------------------------------------------------------------

type AddProps = { claudePodsAvailable?: boolean; teams: readonly TeamOption[]; aliases: readonly string[]; onClose: () => void; onDone: (runner: BotRunner) => void };

export function AddRunnerDialog({ claudePodsAvailable = false, teams, aliases, onClose, onDone }: AddProps) {
  const [kind, setKind] = useState<BotRunnerKind | null>(null);
  return kind === null ? <Chooser cards={cardsFor(claudePodsAvailable)} onClose={onClose} onPick={setKind} /> : <AddForm kind={kind} teams={teams} aliases={aliases} onBack={() => setKind(null)} onClose={onClose} onDone={onDone} />;
}

function Chooser({ cards, onClose, onPick }: { cards: readonly KindCard[]; onClose: () => void; onPick: (k: BotRunnerKind) => void }) {
  return (
    <Dialog title="Add a runner" onClose={onClose} wide testId="runner-add-chooser" footer={<button type="button" className="btn" onClick={onClose}>Cancel</button>}>
      <p className="dlg-text">A runner is a place where bots run. Choose what kind of place to add.</p>
      <ul className="rn-kinds">
        {cards.map((c) => (
          <li key={c.kind}>
            {/* aria-disabled, not disabled: a keyboard user can still reach the card and hear why it is not available yet */}
            <button
              type="button"
              className={`rn-kind ${c.available ? '' : 'off'}`}
              aria-disabled={c.available ? undefined : true}
              aria-describedby={`rn-kind-${c.kind}`}
              data-kind={c.kind}
              data-testid={`runner-kind-${c.kind}`}
              onClick={() => {
                if (c.available) onPick(c.kind);
              }}
            >
              <span className="rn-kind-title">{c.title}</span>
              <span className="rn-kind-text" id={`rn-kind-${c.kind}`}>{c.sentence}{c.available ? '' : ` ${c.unavailable ?? ''}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function AddForm({ kind, teams, aliases, onBack, onClose, onDone }: AddProps & { kind: BotRunnerKind; onBack: () => void }) {
  const [v, setV] = useState<RunnerFormValues>(emptyForm());
  const [nameTouched, setNameTouched] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a ref, not the state: two quick presses (or Enter twice) can both pass before the first re-render sets `busy`
  const sending = useRef(false);
  const set = (patch: Partial<RunnerFormValues>): void => setV((old) => ({ ...old, ...patch }));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (sending.current) return;
    const checked = validateNew(kind, v);
    setErrors(checked.ok ? {} : checked.errors);
    setError(null);
    if (!checked.ok) return;
    sending.current = true;
    setBusy(true);
    try {
      onDone((await createBotRunner(checked.body)).runner);
    } catch (err) {
      setError(message(err));
      // a failed send must not leave the key in the field or in state: type it again
      set({ apiKey: '' });
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Add a runner: ${kindWords(kind)}`}
      onClose={onClose}
      wide
      testId="runner-add-form"
      footer={
        <>
          <button type="button" className="btn" onClick={onBack} disabled={busy}>Back</button>
          <button type="submit" form="runner-add" className="btn primary" disabled={busy} data-testid="runner-add-submit">Add runner</button>
        </>
      }
    >
      <form id="runner-add" className="rn-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Display name"
          data-autofocus=""
          value={v.label}
          maxLength={80}
          placeholder={kind === 'hermes_gateway' ? 'Office Hermes' : kind === 'llm_gateway' ? 'Plain answers' : 'Team Hermes pod'}
          hint="What people read when they pick this runner."
          error={errors.label}
          onChange={(e) => set({ label: e.target.value, ...(nameTouched ? {} : { name: suggestName(e.target.value) }) })}
        />
        <Field
          label="Short name"
          value={v.name}
          maxLength={63}
          className="mono"
          hint="A bot’s definition uses this name to say where it runs. It cannot be changed later."
          error={errors.name}
          onChange={(e) => {
            setNameTouched(true);
            set({ name: e.target.value });
          }}
        />

        {kind === 'hermes_gateway' ? (
          <>
            <Field label="Address" type="url" value={v.baseUrl} placeholder="https://hermes.example.com:8642" hint="Where the gateway answers. Addresses inside this cluster, on this machine and the cloud’s metadata address are refused." error={errors.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
            <Field label="Key" type="password" autoComplete="new-password" value={v.apiKey} hint="Stored once, encrypted. It is never shown again." error={errors.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
            <Field label="Profile name rule" className="mono" value={v.profileRule} hint="How a bot’s profile is named on the gateway. {bot} stands for the bot’s short name." error={errors.profileRule} onChange={(e) => set({ profileRule: e.target.value })} />
          </>
        ) : null}

        {kind === 'claude_cli' ? (
          <div className="rn-field">
            <div className="fld">
              <label htmlFor="runner-concurrency">Runs at once</label>
              <select id="runner-concurrency" value={v.maxConcurrent} onChange={(e) => set({ maxConcurrent: Number(e.target.value) })} data-testid="runner-concurrency">
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <div className="fld-hint">How many bot runs this runner does at the same time. Each Claude runner needs its own sign-in file; you upload it after adding the runner.</div>
            </div>
          </div>
        ) : null}

        {kind === 'hermes_pod' ? <p className="dlg-text">Nothing else to type. Each team that you choose below gets its own Hermes pod inside this cluster.</p> : null}

        {kind === 'llm_gateway' ? <AliasPick aliases={aliases} value={v.modelAlias} onChange={(modelAlias) => set({ modelAlias })} problem={errors.modelAlias} /> : null}

        <TeamsControl value={v.teams} onChange={(teamsChoice: TeamsChoice) => set({ teams: teamsChoice })} teams={teams} />
        {errors.teams ? <span className="rn-problem" role="alert">{errors.teams}</span> : null}
        <FormError text={error} />
      </form>
    </Dialog>
  );
}

function AliasPick({ aliases, value, onChange, problem }: { aliases: readonly string[]; value: string; onChange: (v: string) => void; problem?: string | undefined }) {
  return (
    <div className="rn-field">
      <div className="fld">
        <label htmlFor="runner-alias">Model name</label>
        <select id="runner-alias" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={problem ? true : undefined} aria-describedby={problem ? 'runner-alias-hint runner-alias-err' : 'runner-alias-hint'} data-testid="runner-alias">
          <option value="">Choose a model name</option>
          {aliases.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <div className="fld-hint" id="runner-alias-hint">
          {aliases.length === 0 ? (
            <>No model name is set up yet. Bind one on the <Link to="/settings/workspace/llm">LLM page</Link> first.</>
          ) : (
            <>A model name from the <Link to="/settings/workspace/llm">LLM page</Link>. The bot answers through it; it has no shell, files or browser.</>
          )}
        </div>
      </div>
      {problem ? <span className="rn-problem" role="alert" id="runner-alias-err">{problem}</span> : null}
    </div>
  );
}

// ---- edit ------------------------------------------------------------------------------------------------------

export function EditRunnerDialog({ runner, aliases, onClose, onDone }: { runner: BotRunner; aliases: readonly string[]; onClose: () => void; onDone: (r: BotRunner, note: string) => void }) {
  const [v, setV] = useState({ label: runner.label, baseUrl: runner.baseUrl ?? '', apiKey: '', profileRule: runner.profileRule ?? '{bot}', modelAlias: runner.modelAlias ?? '' });
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const set = (patch: Partial<typeof v>): void => setV((old) => ({ ...old, ...patch }));
  const gateway = runner.kind === 'hermes_gateway';
  const dirty = editChanged(runner, v);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (sending.current) return;
    setError(null);
    const checked = validateEdit(runner, v);
    setErrors(checked.ok ? {} : checked.errors);
    if (!checked.ok) return;
    if (!checked.changed) return onClose();
    sending.current = true;
    setBusy(true);
    try {
      const touchesConnection = checked.body.baseUrl !== undefined || checked.body.apiKey !== undefined;
      const { runner: saved } = await updateBotRunner(runner.id, checked.body);
      onDone(saved, touchesConnection ? `${saved.label} was saved. Run Test again before bots use it.` : `${saved.label} was saved.`);
    } catch (err) {
      setError(message(err));
      // a failed save must not keep the new key in the field or in state
      set({ apiKey: '' });
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Change ${runner.label}`}
      onClose={onClose}
      wide
      testId="runner-edit"
      footer={
        dirty ? (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" form="runner-edit-form" className="btn primary" disabled={busy} data-testid="runner-edit-submit">Save</button>
          </>
        ) : (
          <button type="button" className="btn primary" onClick={onClose} data-testid="runner-edit-close">Close</button>
        )
      }
    >
      <form id="runner-edit-form" className="rn-form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="dlg-text">The short name <code>{runner.name}</code> never changes, so bots that use it keep running.</p>
        <Field label="Display name" data-autofocus="" value={v.label} maxLength={80} error={errors.label} onChange={(e) => set({ label: e.target.value })} />
        {gateway ? (
          <>
            <Field label="Address" type="url" value={v.baseUrl} error={errors.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
            <Field label="New key" type="password" autoComplete="new-password" value={v.apiKey} placeholder={runner.hasKey ? 'A key is set' : 'No key yet'} hint="Leave empty to keep the key that is set. A new address or key needs a new Test." error={errors.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
            <Field label="Profile name rule" className="mono" value={v.profileRule} error={errors.profileRule} onChange={(e) => set({ profileRule: e.target.value })} />
          </>
        ) : null}
        {runner.kind === 'llm_gateway' ? <AliasPick aliases={aliases.includes(v.modelAlias) || v.modelAlias === '' ? aliases : [v.modelAlias, ...aliases]} value={v.modelAlias} onChange={(modelAlias) => set({ modelAlias })} problem={errors.modelAlias} /> : null}
        {!gateway && runner.kind !== 'llm_gateway' ? <p className="dlg-text">There is nothing else to change on this kind of runner.</p> : null}
        <FormError text={error} />
      </form>
    </Dialog>
  );
}

// ---- teams -----------------------------------------------------------------------------------------------------

export function TeamsDialog({ runner, teams, onClose, onDone }: { runner: BotRunner; teams: readonly TeamOption[]; onClose: () => void; onDone: (r: BotRunner) => void }) {
  const [choice, setChoice] = useState<TeamsChoice>(choiceOf(runner));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    const body = teamsBody(choice);
    if (body === null || teamsProblem(choice)?.kind === 'error') return setError('Choose the team.');
    setBusy(true);
    setError(null);
    try {
      onDone((await setBotRunnerTeams(runner.id, body)).runner);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Teams that can use ${runner.label}`}
      onClose={onClose}
      testId="runner-teams-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy} data-testid="runner-teams-save">Save</button>
        </>
      }
    >
      <p className="dlg-text">A team that is not on the list cannot see this runner, and its bots cannot run here.</p>
      <TeamsControl value={choice} onChange={setChoice} teams={teams} legend="Which teams may use it" />
      <FormError text={error} />
    </Dialog>
  );
}

// ---- test ------------------------------------------------------------------------------------------------------

export function TestDialog({ runner, onClose, onTested }: { runner: BotRunner; onClose: () => void; onTested: (r: BotRunner, ok: boolean, text: string) => void }) {
  const [profile, setProfile] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(e: FormEvent): Promise<void> {
    e.preventDefault();
    const p = testProfile(profile);
    if (!p.ok) return setError(p.error);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await testBotRunner(runner.id, p.profile === undefined ? {} : { profile: p.profile });
      const text = res.ok ? 'The gateway answered. This runner is ready.' : (res.error ?? 'The runner is not ready.');
      setResult({ ok: res.ok, text });
      onTested(runner, res.ok, text);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Test ${runner.label}`}
      onClose={onClose}
      testId="runner-test-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="submit" form="runner-test-form" className="btn primary" disabled={busy} data-testid="runner-test-run">{busy ? 'Testing…' : 'Run test'}</button>
        </>
      }
    >
      <form id="runner-test-form" className="rn-form" onSubmit={(e) => void run(e)} noValidate>
        <p className="dlg-text">Asks the gateway whether it answers with the saved key. Nothing the gateway says back is shown here.</p>
        <Field label="Profile to ask for (optional)" data-autofocus="" className="mono" value={profile} onChange={(e) => setProfile(e.target.value)} hint="Leave empty to ask the gateway’s default profile. Name a profile if your gateway has no default one." />
        <FormError text={error} />
        <div role="status" aria-live="polite" data-testid="runner-test-result" data-ok={result ? String(result.ok) : undefined}>
          {result ? <p className={`rn-result ${result.ok ? 'ok' : 'bad'}`}>{result.ok ? '✓ ' : '! '}{result.text}</p> : null}
        </div>
      </form>
    </Dialog>
  );
}

// ---- delete ----------------------------------------------------------------------------------------------------

export function DeleteDialog({ runner, onClose, onDone }: { runner: BotRunner; onClose: () => void; onDone: (r: BotRunner) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const warning = deleteWarning(runner);

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await deleteBotRunner(runner.id);
      onDone(runner);
    } catch (err) {
      // A 409 names how many bots are still placed on the runner and in which teams: the server’s sentence is already plain words.
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Delete ${runner.label}?`}
      onClose={onClose}
      testId="runner-delete-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{error ? 'Close' : 'Cancel'}</button>
          <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy} data-testid="runner-delete-confirm">Delete runner</button>
        </>
      }
    >
      <p className="dlg-text">This takes {runner.label} out of the list. It cannot be undone.</p>
      {warning ? <p className="dlg-text rn-warn" data-testid="runner-delete-warning">{warning}</p> : null}
      <FormError text={error} />
    </Dialog>
  );
}

// ---- node ------------------------------------------------------------------------------------------------------

/**
 * Choose the machine a pod runner's pods stand on (P19-08). The select lists the machines the operator allows; a machine that is not Ready is shown but cannot be
 * picked. A change that leaves a work volume on another machine asks to confirm first, because the volumes are made again, empty.
 */
export function NodeDialog({ runner, onClose, onDone }: { runner: BotRunner; onClose: () => void; onDone: (r: BotRunner, text: string) => void }) {
  const q = useQuery(`runner-nodes-dialog-${runner.id}`, () => fetchRunnerNodes(runner.id));
  const [choice, setChoice] = useState(runner.node ?? NODE_AUTO);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const target = choice === NODE_AUTO ? null : choice;
  const unchanged = target === (runner.node ?? null);
  const listed = q.status === 'ok' ? q.data : null;
  const warning = listed ? moveWarning(runner.label, volumesElsewhere(listed.nodes, target), target ?? '') : null;
  // The machine was changed by something else (Make default, Enable, the Teams list) and the pod stayed where its volumes are: the same machine can be confirmed again here.
  const waitingForWord = listed !== null && needsMoveConfirm(listed.placement) && unchanged && warning !== null;
  // After the select is replaced by the warning, the keyboard goes to the button that goes on; going back, to the select.
  const selectRef = useRef<HTMLSelectElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) selectRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function save(): Promise<void> {
    if (sending.current) return;
    if (warning && !confirming) return setConfirming(true);
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await setRunnerNode(runner.id, target);
      onDone(res.runner, nodeSavedWords(runner.label, target, res.recreatesWorkVolume));
    } catch (err) {
      setError(message(err));
      setConfirming(false);
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={confirming ? `Move ${runner.label} to ${target}?` : `Machine for ${runner.label}`}
      onClose={onClose}
      wide
      testId="runner-node-dialog"
      footer={
        confirming ? (
          <>
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
            <button type="button" className="btn danger" ref={confirmRef} onClick={() => void save()} disabled={busy} data-testid="runner-node-confirm">Move and make the volumes again</button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={busy || (unchanged && !waitingForWord) || listed === null} data-testid="runner-node-save">{waitingForWord ? 'Review the move' : 'Save'}</button>
          </>
        )
      }
    >
      {confirming ? (
        <>
          <p className="dlg-text rn-warn" data-testid="runner-node-warning">{warning}</p>
          <p className="dlg-text">Nothing else changes. Teams, keys and bots stay as they are.</p>
        </>
      ) : q.status === 'loading' ? (
        <p className="loading" aria-busy="true">Loading…</p>
      ) : q.status === 'error' ? (
        <p className="dlg-error" role="alert">{q.error.message}</p>
      ) : (
        <NodePick runner={runner} data={q.data} value={choice} onChange={setChoice} selectRef={selectRef} />
      )}
      <FormError text={error} />
    </Dialog>
  );
}

function NodePick({ runner, data, value, onChange, selectRef }: { runner: BotRunner; data: ListRunnerNodesResponse; value: string; onChange: (v: string) => void; selectRef: RefObject<HTMLSelectElement | null> }) {
  const one = singleNodeLine(data.nodes, data.singleNode);
  const line = placementLine(runner.node, data.placement);
  // a machine saved earlier that the list no longer holds stays in the select, so the dialog does not silently show "let the cluster choose"
  const missing = runner.node !== null && !data.nodes.some((n) => n.name === runner.node);
  return (
    <div className="rn-field">
      {data.note ? <p className="dlg-text rn-warn" data-testid="runner-node-note">{data.note}</p> : null}
      <div className="fld">
        <label htmlFor="runner-node">Machine</label>
        <select id="runner-node" ref={selectRef} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby="runner-node-hint" data-testid="runner-node-select" data-autofocus="">
          <option value={NODE_AUTO}>Let the cluster choose</option>
          {missing ? <option value={runner.node ?? ''}>{runner.node} (not in the list)</option> : null}
          {data.nodes.map((n) => (
            <option key={n.name} value={n.name} disabled={!n.ready && n.name !== runner.node}>{nodeOption(n)}</option>
          ))}
        </select>
        <div className="fld-hint" id="runner-node-hint">
          {one ?? 'Every team’s Hermes pod of this runner runs on the machine you choose. Each pod keeps its files on one machine, so moving it starts its volumes again, empty.'}
        </div>
      </div>
      {line ? <p className={`rn-place ${line.tone}`} data-testid="runner-node-state">{line.text}</p> : null}
    </div>
  );
}

// ---- adopt -----------------------------------------------------------------------------------------------------

export function AdoptDialog({ connection, onClose, onDone }: { connection: OldConnection; onClose: () => void; onDone: (r: BotRunner) => void }) {
  const managed = connection.kind === 'managed';
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bad = name.trim() !== '' ? nameProblem(name) : null;

  async function adopt(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (bad) return;
    setBusy(true);
    setError(null);
    try {
      onDone((await adoptOldConnection(connection.id, name.trim() === '' ? {} : { name: name.trim() })).runner);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Adopt ${connection.name} of ${connection.teamName}`}
      onClose={onClose}
      testId="runner-adopt-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="runner-adopt-form" className="btn primary" disabled={busy || Boolean(bad)} data-testid="runner-adopt-confirm">Adopt</button>
        </>
      }
    >
      <form id="runner-adopt-form" className="rn-form" onSubmit={(e) => void adopt(e)} noValidate>
        <p className="dlg-text">{adoptWords(connection)}</p>
        {managed ? null : (
          <Field label="Short name (optional)" data-autofocus="" className="mono" value={name} placeholder={connection.name} hint="Leave empty to keep the connection’s own name." error={bad ?? undefined} onChange={(e) => setName(e.target.value)} />
        )}
        <FormError text={error} />
      </form>
    </Dialog>
  );
}
