import { useState } from 'react';
import { Link } from 'react-router';
import type { BotSummary, HermesConnection, HermesConnectionAgent } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { Alert, Notice, Time } from '../../components/ui';
import { useHeaderTopic } from '../../shell/topic';
import { fetchBots } from '../bots/api';
import { useBotPerms } from '../bots/store';
import { fetchConnections, testConnection } from './api';
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
} from './commands';

/*
 * Agents: which agent runs this team's bots. A connection is a way to reach one agent over HTTP (a Hermes gateway, or the agent bridge
 * that starts the Claude Code or Codex command-line tool). A workspace admin sets them up under Runners (PLAN P19-02); here a lead or member reads the list
 * and can run a check. Adding, changing and removing is not offered: the server answers 403 for it.
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
        <li>Give a workspace admin the bridge&apos;s address and the key you gave it. An admin adds it under Runners.</li>
      </ol>
      <p className="fld-hint">
        Each run gets the bot&apos;s BOT.md as an added system prompt and a token that works for that one run, for <span className="mono">{mcpAddress(origin)}</span>.
        The tools the agent may use (files, shell, web) come from the bot&apos;s <span className="mono">capabilities.runtime</span> setting.
        If you sign the CLI in with a personal subscription, check that subscription&apos;s terms allow running team bots on it.
      </p>
    </div>
  );
}

function ConnectionRow({ slug, c, bots, canManage, onChanged }: { slug: string; c: HermesConnection; bots: BotSummary[]; canManage: boolean; onChanged: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const used = botsOnConnection(bots, c.name);

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
  return (
    <div className="ag-row" data-testid="agents-row" data-connection={c.name} data-status={c.status}>
      <div className="ag-main">
        <div className="ag-name"><span className="mono">{c.name}</span> <span className="kind ag">{agentLabel(c.agent)}</span> <span className="ag-kind">{kindLabel(c.kind)}</span></div>
        <div className="ag-addr mono" data-vt-mask>{c.baseUrl ?? (c.kind === 'managed' ? 'Inside this cluster' : 'Set by an admin')}</div>
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
      </div>
      {canManage ? (
        <div className="ag-act">
          <button type="button" className="btn s" onClick={() => void test()} disabled={busy}>Test</button>
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
            A bot picks one of these connections in its Placement settings. A workspace admin sets them up under Runners.
          </p>
        </div>
        <div className="ag-head-links">
          <Link className="btn s" to={`/t/${slug}/projects`} data-testid="agents-projects-link">Projects</Link>
        </div>
      </div>
      <Notice tone="warn">An admin sets this up. Ask a workspace admin to add or change a connection under Runners. You can see what is set and run a check.</Notice>
      <QueryView q={conns}>
        {({ items }) => (
          <section className="box ag-list" aria-labelledby="ag-list-h" data-landmark="agents-list">
            <h2 className="box-h" id="ag-list-h">Connections</h2>
            {items.length === 0 ? <p className="d" data-testid="agents-empty">No connections yet. An admin sets this up under Runners.</p> : null}
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
