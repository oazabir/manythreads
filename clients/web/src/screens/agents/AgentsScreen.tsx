import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { BotSummary, HermesConnection, HermesConnectionAgent } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { Alert, Field, Notice, Time } from '../../components/ui';
import { useHeaderTopic } from '../../shell/topic';
import { fetchBots } from '../bots/api';
import { useBotPerms } from '../bots/store';
import { createConnection, deleteConnection, fetchConnections, testConnection, updateConnection } from './api';
import {
  AGENT_CHOICES,
  agentLabel,
  bridgeCommand,
  BRIDGE_CONFIG,
  botsOnConnection,
  hermesProfileYaml,
  kindLabel,
  mcpAddress,
  statusLine,
  validateEdit,
  bridgeSwitchWarning,
  validateNew,
  type FormErrors,
} from './commands';

/*
 * Agents: which agent runs this team's bots. A connection is a way to reach one agent over HTTP (a Hermes gateway, or the agent bridge
 * that starts the Claude Code or Codex command-line tool). A lead or a workspace admin manages them; everyone else reads the list.
 */

const message = (e: unknown): string => (isApiError(e) || e instanceof Error ? e.message : 'Something went wrong. Try again.');

function CopyBlock({ id, text }: { id: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <div className="ag-code" data-copy={id}>
      <pre className="mono">{text}</pre>
      <button type="button" className="btn s" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

export function HowToConnect({ agent, origin, listen }: { agent: HermesConnectionAgent; origin: string; listen: string }) {
  if (agent === 'hermes') {
    return (
      <div className="ag-how" data-agent="hermes" data-testid="agents-how">
        <ol>
          <li>On your Hermes server, turn on the <span className="mono">api_server</span> platform, so manythreads can send it work over HTTP.</li>
          <li>Make one Hermes profile for each bot (a profile is a named set of settings on the server).</li>
          <li>
            In each profile, add the block below. Every profile points at the same address, <span className="mono">{mcpAddress(origin)}</span>, and
            carries that bot&apos;s own token. Make the token on the bot&apos;s page and put it in the <span className="mono">MANYTHREADS_MCP_TOKEN</span> setting of the profile.
          </li>
        </ol>
        <CopyBlock id="hermes-yaml" text={hermesProfileYaml(origin)} />
        <p className="fld-hint">The bot&apos;s BOT.md file is sent with every run as extra instructions, so the profile needs no copy of it.</p>
      </div>
    );
  }
  const cli = agent === 'claude-code' ? 'Claude Code' : 'Codex';
  const config = agent === 'codex' ? BRIDGE_CONFIG.replace('claude-code', 'codex') : BRIDGE_CONFIG;
  return (
    <div className="ag-how" data-agent={agent} data-testid="agents-how">
      <ol>
        <li>On the machine where the {cli} command is installed and signed in, save this as <span className="mono">bridge.json</span>. It names the folder the agent works in.</li>
      </ol>
      <CopyBlock id="bridge-json" text={config} />
      <ol start={2}>
        <li>Start the bridge, a small program that turns each request into one {cli} run:</li>
      </ol>
      <CopyBlock id="bridge-cmd" text={bridgeCommand(listen)} />
      <ol start={3}>
        <li>Add a connection here with the bridge&apos;s address and the key you gave it.</li>
      </ol>
      <p className="fld-hint">
        Each run gets the bot&apos;s BOT.md as an added system prompt and a token that works for that one run, for <span className="mono">{mcpAddress(origin)}</span>.
        The tools the agent may use (files, shell, web) come from the bot&apos;s <span className="mono">capabilities.runtime</span> setting.
        If you sign the CLI in with a personal subscription, check that subscription&apos;s terms allow running team bots on it.
      </p>
    </div>
  );
}

function AgentPicker({ value, onChange, name }: { value: HermesConnectionAgent; onChange: (a: HermesConnectionAgent) => void; name: string }) {
  return (
    <fieldset className="ag-pick" data-testid="agents-pick">
      <legend className="fld-label">Agent</legend>
      {AGENT_CHOICES.map((c) => (
        <label key={c.id} className={`ag-opt ${value === c.id ? 'on' : ''}`} data-agent={c.id}>
          <input type="radio" name={name} value={c.id} checked={value === c.id} onChange={() => onChange(c.id)} />
          <span><b>{c.label}</b><span className="d">{c.hint}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

const defaultAddress = (a: HermesConnectionAgent): string => (a === 'hermes' ? '' : 'http://localhost:8650');

function AddForm({ slug, origin, onDone }: { slug: string; origin: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [agent, setAgent] = useState<HermesConnectionAgent>('hermes');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateNew({ name, agent, baseUrl, apiKey });
    setErrors(v.ok ? {} : v.errors);
    if (!v.ok) return;
    setBusy(true);
    setError(null);
    try {
      await createConnection(slug, v.body);
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="box" onSubmit={(e) => void submit(e)} data-testid="agents-add" aria-labelledby="ag-add-h">
      <h2 className="box-h" id="ag-add-h">Add a connection</h2>
      {error ? <Alert>{error}</Alert> : null}
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="our-hermes" autoComplete="off"
        hint={errors.name ?? 'A bot names this connection in its Placement settings.'} aria-invalid={errors.name ? true : undefined} />
      <AgentPicker value={agent} onChange={(a) => { setAgent(a); if (baseUrl === '' || baseUrl === defaultAddress(agent)) setBaseUrl(defaultAddress(a)); }} name="ag-new-agent" />
      <Field label="Address" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://hermes.example.com" autoComplete="off"
        hint={errors.baseUrl ?? (agent === 'hermes' ? 'Where the Hermes server answers.' : 'Where the bridge answers. It must be reachable from this workspace.')} aria-invalid={errors.baseUrl ? true : undefined} />
      <Field label="API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password"
        hint={errors.apiKey ?? 'Stored without being shown again.'} aria-invalid={errors.apiKey ? true : undefined} />
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Add connection'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
      <h3 className="ag-sub">How to connect</h3>
      <HowToConnect agent={agent} origin={origin} listen={hostPort(baseUrl)} />
    </form>
  );
}

/** The bridge listens on the very address the connection names (a private one), never on every interface; loopback until one is typed. */
function hostPort(address: string): string {
  try {
    const u = new URL(address);
    return `${u.hostname}:${u.port || '8650'}`;
  } catch {
    return '127.0.0.1:8650';
  }
}

function EditForm({ slug, c, onDone }: { slug: string; c: HermesConnection; onDone: () => void }) {
  const [agent, setAgent] = useState(c.agent);
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const submit = async (e: FormEvent, confirmed = false) => {
    e.preventDefault();
    const v = validateEdit(c, { agent, baseUrl, apiKey });
    setErrors(v.ok ? {} : v.errors);
    if (!v.ok) return;
    if (!v.changed) return onDone();
    const warn = bridgeSwitchWarning(c.agent, agent, baseUrl);
    if (warn !== null && !confirmed) {
      setWarning(warn);
      return;
    }
    setWarning(null);
    setBusy(true);
    setError(null);
    try {
      await updateConnection(slug, c.id, v.body);
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ag-edit" onSubmit={(e) => void submit(e)} data-testid="agents-edit">
      {error ? <Alert>{error}</Alert> : null}
      <AgentPicker value={agent} onChange={setAgent} name={`ag-agent-${c.id}`} />
      <Field label="Address" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" hint={errors.baseUrl} aria-invalid={errors.baseUrl ? true : undefined} />
      <Field label="New API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password"
        placeholder={c.hasApiKey ? 'Leave empty to keep the current key' : ''} hint={errors.apiKey} aria-invalid={errors.apiKey ? true : undefined} />
      {warning ? (
        <Alert>
          <span role="alert" data-testid="agents-switch-confirm">{warning}</span>{' '}
          <button type="button" className="btn s" onClick={(e) => void submit(e as unknown as FormEvent, true)}>Switch anyway</button>
          <button type="button" className="btn s" onClick={() => setWarning(null)}>Keep as is</button>
        </Alert>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function ConnectionRow({ slug, c, bots, canManage, onChanged }: { slug: string; c: HermesConnection; bots: BotSummary[]; canManage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const used = botsOnConnection(bots, c.name);
  const managed = c.kind === 'managed';

  const test = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await testConnection(slug, c.id);
      setResult({ ok: r.ok, text: r.ok ? 'The connection works.' : (r.error ?? 'The check failed.') });
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteConnection(slug, c.id);
      onChanged();
    } catch (e) {
      setError(message(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ag-row" data-testid="agents-row" data-connection={c.name} data-status={c.status}>
      <div className="ag-main">
        <div className="ag-name"><span className="mono">{c.name}</span> <span className="kind ag">{agentLabel(c.agent)}</span> <span className="ag-kind">{kindLabel(c.kind)}</span></div>
        <div className="ag-addr mono" data-vt-mask>{c.baseUrl ?? 'Inside this cluster'}</div>
        <div className="ag-state">
          <span className={`ag-st ${c.status}`}>{statusLine(c)}</span>
          {c.lastCheckedAt ? <span className="d"> · last checked <Time iso={c.lastCheckedAt} /></span> : null}
          {c.lastError ? <div className="ag-err" data-vt-mask>{c.lastError}</div> : null}
        </div>
        <div className="ag-bots d" data-testid="agents-bots">
          {used.length === 0 ? 'No bot is placed on this connection yet.' : (
            <>Used by {used.map((b, i) => (
              <span key={b.id}>{i > 0 ? ', ' : ''}<Link to={`/t/${slug}/bots/${b.slug}?tab=placement`}>{b.name}</Link></span>
            ))}</>
          )}
        </div>
        {result ? <div className={`ag-result ${result.ok ? 'ok' : 'bad'}`} role="status" data-vt-mask>{result.text}</div> : null}
        {error ? <Alert>{error}</Alert> : null}
        {editing ? <EditForm slug={slug} c={c} onDone={() => { setEditing(false); onChanged(); }} /> : null}
      </div>
      {canManage ? (
        <div className="ag-act">
          <button type="button" className="btn s" onClick={() => void test()} disabled={busy}>Test</button>
          {!managed ? <button type="button" className="btn s" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>Edit</button> : null}
          {!managed && !confirming ? <button type="button" className="btn s danger" onClick={() => setConfirming(true)}>Remove</button> : null}
          {confirming ? (
            <span className="ag-confirm" role="group" aria-label={`Remove ${c.name}`}>
              {used.length > 0 ? `${used.length} ${used.length === 1 ? 'bot uses' : 'bots use'} it. ` : ''}Remove?
              <button type="button" className="btn s danger" onClick={() => void remove()} disabled={busy}>Yes, remove</button>
              <button type="button" className="btn s" onClick={() => setConfirming(false)}>Keep</button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AgentsScreen() {
  const { slug, canEdit } = useBotPerms();
  useHeaderTopic('Agents');
  const conns = useQuery(`agents:${slug}`, () => fetchConnections(slug));
  const bots = useQuery(`agents-bots:${slug}`, () => fetchBots(slug));
  const [adding, setAdding] = useState(false);
  const [how, setHow] = useState<HermesConnectionAgent>('hermes');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const reload = () => conns.reload();

  return (
    <div className="agents-screen" data-landmark="agents">
      <div className="ag-head">
        <div>
          <h2 className="ag-title">Agents</h2>
          <p className="ag-lede">
            The agent that runs this team&apos;s bots. Connect a Hermes server, or the Claude Code or Codex command-line tool on your own machine.
            A bot picks one of these connections in its Placement settings.
          </p>
        </div>
        <div className="ag-head-links">
          <Link className="btn s" to={`/t/${slug}/projects`} data-testid="agents-projects-link">Projects</Link>
          {canEdit && !adding ? <button type="button" className="btn primary" onClick={() => setAdding(true)} data-testid="agents-add-open">Add connection</button> : null}
        </div>
      </div>
      {!canEdit ? <Notice tone="warn">Only a team lead or a workspace admin can change these. You can see what is set.</Notice> : null}
      {adding ? <AddForm slug={slug} origin={origin} onDone={() => { setAdding(false); reload(); }} /> : null}
      <QueryView q={conns}>
        {({ items }) => (
          <section className="box ag-list" aria-labelledby="ag-list-h" data-landmark="agents-list">
            <h2 className="box-h" id="ag-list-h">Connections</h2>
            {items.length === 0 ? <p className="d" data-testid="agents-empty">No connections yet. Add one to run bots on your own agent.</p> : null}
            {items.map((c) => (
              <ConnectionRow key={c.id} slug={slug} c={c} bots={bots.status === 'ok' ? bots.data.bots : []} canManage={canEdit} onChanged={reload} />
            ))}
          </section>
        )}
      </QueryView>
      <section className="box" aria-labelledby="ag-how-h" data-landmark="agents-how">
        <h2 className="box-h" id="ag-how-h">How to connect</h2>
        <div className="ag-tabs" role="tablist" aria-label="Agent">
          {AGENT_CHOICES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={how === c.id} className={`btn s ${how === c.id ? 'primary' : ''}`} onClick={() => setHow(c.id)}>{c.label}</button>
          ))}
        </div>
        <HowToConnect agent={how} origin={origin} listen="127.0.0.1:8650" />
      </section>
    </div>
  );
}
