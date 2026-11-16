import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Appearance as AppearanceSetting, LlmAliasTest, TemplateSummary } from '@manythreads/shared';
import { DEFAULT_MONTHLY_CAP_USD, LLM_PRESETS, PRESET_ALIASES, type LlmPreset } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import {
  applyTeamTemplate,
  createLlmProvider,
  fetchLlmLimits,
  fetchLlmProviders,
  fetchTemplates,
  setLlmAlias,
  setLlmLimit,
  setOnboardingMark,
  updateLlmProvider,
  updateWorkspace,
} from '../../api/endpoints';
import { useSession, useSessionState } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { AliasTestButton, AliasTestStatus } from '../../components/AliasTest';
import { ThemePicker } from '../../components/ThemePicker';
import { Alert } from '../../components/ui';
import { sayToast } from '../../kernel/toast';
import { applyAppearance } from '../../shell/appearance';
import { saveMyAppearance } from '../account/appearanceApi';
import { createBotRunner, setDefaultBotRunner, testBotRunner, updateBotRunner } from '../admin/runners/api';
import { createBotServer } from '../admin/runners/servers-api';
import { installCommand, serverNameProblem, suggestServerName } from '../admin/runners/servers';
import { fetchBotTest, startBotTest } from '../bots/api';
import { DEFAULT_WORKSPACE_NAME, isWorkingRunner, provenRunner, type OnboardingStep, type OnboardingSummary, type RunnerFact } from './steps';
import { announceOnboardingChange, type BoundAlias, type WizardFacts } from './useOnboarding';

/* The panels of the setup wizard's steps that set something up (Phase 27). A button does the work on the server or only re-reads a fact; none of them ticks a step. */

export const failure = (e: unknown): string => (isApiError(e) ? e.message : 'Something went wrong. Try again.');

export function useAction(): { busy: boolean; error: string | null; run: (fn: () => Promise<void>) => Promise<void>; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    clear: () => setError(null),
    async run(fn) {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(failure(e));
      } finally {
        setBusy(false);
      }
    },
  };
}

// ---- the look ---------------------------------------------------------------------------------------------------------------------------------------------

export function ThemeStep({ step }: { step: OnboardingStep }) {
  const session = useSession();
  const { setSession } = useSessionState();
  const act = useAction();
  const current: AppearanceSetting = session.person.appearance;
  async function pick(change: Partial<AppearanceSetting>) {
    const next: AppearanceSetting = { ...current, ...change };
    applyAppearance(next);
    setSession({ ...session, person: { ...session.person, appearance: next } });
    await act.run(async () => {
      try {
        const stored = await saveMyAppearance(change);
        applyAppearance(stored);
        setSession({ ...session, person: { ...session.person, appearance: stored } });
        announceOnboardingChange();
      } catch (e) {
        applyAppearance(current);
        setSession({ ...session, person: { ...session.person, appearance: current } });
        throw e;
      }
    });
  }
  return (
    <>
      <ThemePicker value={current} onChange={(change) => void pick(change)} testId="ob-theme" />
      <div className="ob-actions">
        {step.done ? null : (
          <button
            type="button"
            className="btn"
            disabled={act.busy}
            data-testid="ob-theme-keep"
            onClick={() => void act.run(async () => { await setOnboardingMark('theme', 'acknowledged'); announceOnboardingChange(); })}
          >
            Keep Classic
          </button>
        )}
      </div>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

// ---- the organization -------------------------------------------------------------------------------------------------------------------------------------

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();
const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

export function OrganizationStep({ facts }: { facts: WizardFacts }) {
  const act = useAction();
  const start = facts.workspace.name === DEFAULT_WORKSPACE_NAME ? '' : facts.workspace.name;
  const [name, setName] = useState(start);
  const [zone, setZone] = useState(facts.workspace.timeZone ?? browserZone());
  const zones = ZONES.includes(zone) || zone === '' ? ZONES : [zone, ...ZONES];
  function save(e: FormEvent) {
    e.preventDefault();
    void act.run(async () => {
      await updateWorkspace({ name: name.trim(), ...(zone ? { timeZone: zone } : {}) });
      sayToast('Saved');
      announceOnboardingChange();
    });
  }
  return (
    <form className="ob-form ob-form-org" onSubmit={save} data-testid="ob-org-form">
      <label>
        Organization name
        <input value={name} maxLength={80} placeholder="Your company" onChange={(e) => setName(e.target.value)} data-testid="ob-org-name" />
      </label>
      <label>
        Time zone
        {zones.length > 0 ? (
          <select value={zone} onChange={(e) => setZone(e.target.value)} data-testid="ob-org-zone">
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        ) : (
          <input value={zone} onChange={(e) => setZone(e.target.value)} data-testid="ob-org-zone" />
        )}
        <span className="ob-test-d">Reminders and schedules read in this zone.</span>
      </label>
      <button type="submit" className="btn primary" disabled={act.busy || name.trim() === ''} data-testid="ob-org-save">
        {act.busy ? 'Saving…' : 'Save'}
      </button>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </form>
  );
}

// ---- address and HTTPS ------------------------------------------------------------------------------------------------------------------------------------

export function HttpsStep({ step, secure, setAside }: { step: OnboardingStep; secure: boolean; setAside: React.ReactNode }) {
  const host = window.location.host;
  const sslip = /\.sslip\.io$/.test(window.location.hostname);
  return (
    <>
      <dl className="ob-facts" data-testid="ob-https-facts">
        <dt>Address people use</dt>
        <dd className="mono">{window.location.origin}</dd>
        <dt>Certificate</dt>
        <dd>
          {secure
            ? 'This page is served over HTTPS, so browsers trust it and the connection is private.'
            : 'This page is served without HTTPS. It works for a private trial on your own network; people and bots outside it should use HTTPS.'}
        </dd>
      </dl>
      {step.done ? null : (
        <p className="ob-hint">
          To use your own domain (for example <span className="mono">manythreads.example.com</span>), point its DNS record at this machine, then run{' '}
          <span className="mono">sudo manythreads set-domain manythreads.example.com</span> on it. It gets a Let's Encrypt certificate by itself and this page
          moves there without a reinstall.{sslip ? ` Right now the address ${host} is a free name that already carries the machine's address.` : ''}
        </p>
      )}
      <div className="ob-actions">
        <Link className="btn" to="/settings/workspace/https">Open Domain and HTTPS</Link>
        {setAside}
      </div>
    </>
  );
}

// ---- models -----------------------------------------------------------------------------------------------------------------------------------------------

/** Paste a key (or a plan's address and key), bind smart, fast and code to the vendor's models and test smart. Shared by the Models step and the runner offer. */
export function ModelSetup({ tests, aliases, hasProviders, compact = false }: { tests: LlmAliasTest[]; aliases: BoundAlias[]; hasProviders: boolean; compact?: boolean }) {
  const [presetId, setPresetId] = useState<string>(LLM_PRESETS[0]?.id ?? 'anthropic');
  const preset: LlmPreset = LLM_PRESETS.find((p) => p.id === presetId) ?? (LLM_PRESETS[0] as LlmPreset);
  const [key, setKey] = useState('');
  const [base, setBase] = useState('');
  const [modelName, setModelName] = useState('');
  const [cap, setCap] = useState(String(DEFAULT_MONTHLY_CAP_USD));
  const [open, setOpen] = useState(!hasProviders);
  const act = useAction();
  const limits = useQuery('ob-limits', fetchLlmLimits);
  const capSet = limits.status === 'ok' && limits.data.limits.some((l) => l.scope === 'workspace' && l.window === 'month');
  const byAlias = new Map(tests.map((t) => [t.alias as string, t]));
  const bound = aliases.filter((a) => (PRESET_ALIASES as readonly string[]).includes(a.alias));
  const apiBase = preset.editableBase ? base.trim() || preset.apiBase || '' : preset.apiBase || '';
  const needsKey = preset.type !== 'local';
  // a preset with no model of its own (any OpenAI-compatible address) takes the one the admin names, for all three aliases
  const modelFor = (alias: (typeof PRESET_ALIASES)[number]): string => preset.models[alias] || modelName.trim();
  const lacksName = PRESET_ALIASES.some((a) => modelFor(a) === '');

  function connect(e: FormEvent) {
    e.preventDefault();
    void act.run(async () => {
      // connecting the same vendor again (a new key after a failed test) changes its provider instead of making a second one
      const existing = (await fetchLlmProviders()).providers.find((p) => p.name === preset.label);
      const made = existing
        ? (await updateLlmProvider(existing.id, { ...(key.trim() ? { apiKey: key.trim() } : {}), ...(apiBase ? { apiBase } : {}), enabled: true })).provider
        : (
            await createLlmProvider({
              name: preset.label,
              kind: preset.kind,
              ...(key.trim() ? { apiKey: key.trim() } : {}),
              ...(apiBase ? { apiBase } : {}),
              ...(preset.type === 'local' ? { local: true } : {}),
            })
          ).provider;
      for (const alias of PRESET_ALIASES) {
        await setLlmAlias(alias, { providerId: made.id, model: modelFor(alias) });
      }
      const dollars = Number(cap);
      if (!capSet && Number.isFinite(dollars) && dollars > 0) {
        await setLlmLimit({ scope: 'workspace', window: 'month', limitUsd: dollars });
      }
      setKey('');
      setOpen(false);
      announceOnboardingChange();
    });
  }

  return (
    <>
      {bound.length > 0 ? (
        <div className="ob-rows" data-testid="ob-models-rows">
          {bound.map((a) => (
            <div key={a.alias} className="ob-alias" data-alias={a.alias}>
              <span className="mono">{a.alias}</span>
              <span className="ob-test-d">{a.model}</span>
              <span>
                <AliasTestButton alias={a.alias} onResult={announceOnboardingChange} />
              </span>
              <AliasTestStatus test={byAlias.get(a.alias)} />
            </div>
          ))}
        </div>
      ) : null}
      {open ? (
        <form className="ob-models" onSubmit={connect} data-testid="ob-models-form">
          <fieldset className="ob-presets">
            <legend className="ob-hint">Where do the models come from?</legend>
            {LLM_PRESETS.map((p) => (
              <label key={p.id} className={`ob-preset${p.id === presetId ? ' on' : ''}`} data-testid={`ob-preset-${p.id}`}>
                <input type="radio" className="sr-only" name="ob-preset" value={p.id} checked={p.id === presetId} onChange={() => setPresetId(p.id)} />
                <span className="ob-preset-name">{p.label}</span>
                <span className="ob-test-d">{p.type === 'plan' ? 'Coding plan' : p.type === 'local' ? 'Your own machine' : 'API key'}</span>
              </label>
            ))}
          </fieldset>
          <p className="ob-hint">{preset.hint}</p>
          <div className="ob-form ob-form-keys">
            {preset.editableBase || preset.type === 'plan' ? (
              <label>
                Address
                <input
                  value={base || preset.apiBase || ''}
                  onChange={(e) => setBase(e.target.value)}
                  placeholder="https://"
                  disabled={!preset.editableBase}
                  data-testid="ob-model-base"
                />
              </label>
            ) : null}
            {preset.models.smart === '' ? (
              <label>
                Model name
                <input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="the model's name at that address" data-testid="ob-model-name" />
              </label>
            ) : null}
            {needsKey ? (
              <label>
                {preset.keyLabel}
                <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} data-testid="ob-model-key" />
              </label>
            ) : null}
            {compact || capSet ? null : (
              <label>
                Monthly spending limit (US dollars)
                <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} data-testid="ob-model-cap" />
                <span className="ob-test-d">Calls stop at this amount each month. Change it any time in model settings.</span>
              </label>
            )}
            <button type="submit" className="btn primary" disabled={act.busy || lacksName || (needsKey && key.trim() === '') || (preset.editableBase && apiBase === '')} data-testid="ob-model-connect">
              {act.busy ? 'Connecting…' : 'Connect and bind'}
            </button>
          </div>
          <p className="ob-test-d">
            This binds <span className="mono">smart</span>, <span className="mono">fast</span> and <span className="mono">code</span> to{' '}
            {PRESET_ALIASES.map((a) => modelFor(a) || 'the model you name').filter((m, i, all) => all.indexOf(m) === i).join(', ')}. The key is stored encrypted and never shown again.
          </p>
        </form>
      ) : (
        <div className="ob-actions">
          <button type="button" className="btn" onClick={() => setOpen(true)} data-testid="ob-model-another">Connect another provider</button>
        </div>
      )}
      {act.error ? <Alert>{act.error}</Alert> : null}
      {compact ? null : (
        <div className="ob-actions">
          <Link className="btn quiet" to="/settings/workspace/llm">Open model settings</Link>
        </div>
      )}
    </>
  );
}

// ---- teams ------------------------------------------------------------------------------------------------------------------------------------------------

export function TeamsStep({ facts }: { facts: WizardFacts }) {
  const templates = useQuery('ob-templates', fetchTemplates);
  const list: TemplateSummary[] = templates.status === 'ok' ? templates.data.templates : [];
  const made = new Set(facts.madeTemplates);
  const [ticked, setTicked] = useState<Record<string, boolean> | null>(null);
  const act = useAction();
  const [progress, setProgress] = useState<string | null>(null);
  // every template is ticked at first; the admin unticks what they do not want
  const isTicked = (id: string): boolean => ticked?.[id] ?? true;
  const todo = list.filter((t) => isTicked(t.id) && !made.has(t.id));
  function make() {
    void act.run(async () => {
      for (const t of todo) {
        setProgress(`Creating ${t.name}…`);
        await applyTeamTemplate({ templateId: t.id });
        announceOnboardingChange();
      }
      setProgress(null);
    });
  }
  return (
    <>
      <p className="ob-hint">Each template is a ready team: channels, a board and the bots that fit its work. Untick the ones you do not need; you can make them later from Teams.</p>
      <ul className="ob-templates" data-testid="ob-templates">
        {list.map((t) => (
          <li key={t.id} className="ob-template" data-template={t.id}>
            <label>
              <input
                type="checkbox"
                checked={made.has(t.id) || isTicked(t.id)}
                disabled={made.has(t.id) || act.busy}
                onChange={(e) => setTicked({ ...(ticked ?? {}), [t.id]: e.target.checked })}
                data-testid={`ob-template-${t.id}`}
              />
              <span className="ob-template-name">{t.name}</span>
              {made.has(t.id) ? <span className="chip ok">made</span> : null}
            </label>
            <span className="ob-test-d">{t.description}</span>
          </li>
        ))}
      </ul>
      <div className="ob-actions">
        <button type="button" className="btn primary" disabled={act.busy || todo.length === 0} onClick={make} data-testid="ob-teams-make">
          {act.busy ? (progress ?? 'Creating…') : todo.length === 0 ? 'Nothing left to make' : `Make ${todo.length} ${todo.length === 1 ? 'team' : 'teams'}`}
        </button>
        <Link className="btn quiet" to="/teams">Manage teams</Link>
      </div>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

// ---- servers ----------------------------------------------------------------------------------------------------------------------------------------------

export function ServersStep({ step, setAside }: { step: OnboardingStep; setAside: React.ReactNode }) {
  const act = useAction();
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const problem = label.trim() === '' ? null : serverNameProblem(suggestServerName(label));
  // while the command is on screen, look for the machine to connect
  useEffect(() => {
    if (command === null || step.done) return undefined;
    const t = setInterval(announceOnboardingChange, 4000);
    return () => clearInterval(t);
  }, [command, step.done]);
  return (
    <>
      <p className="ob-hint">
        A server is a machine of your own (a spare computer, a cloud machine) where agents such as Claude Code or Codex can run for your teams. You paste one command on
        it and it connects here. You can skip this: pods inside this site can run bots without it.
      </p>
      {command === null ? (
        <form
          className="ob-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => {
              const made = await createBotServer({ name: suggestServerName(label), label: label.trim() });
              setCommand(installCommand(window.location.origin, made.code, made.install?.siteCert ?? null));
            });
          }}
        >
          <label>
            Name this machine
            <input value={label} maxLength={80} placeholder="Office server" onChange={(e) => setLabel(e.target.value)} data-testid="ob-server-name" />
          </label>
          <button type="submit" className="btn" disabled={act.busy || label.trim() === '' || problem !== null} data-testid="ob-server-make">
            Make the command
          </button>
          {problem ? <span className="ob-test-d">{problem}</span> : null}
        </form>
      ) : (
        <div data-testid="ob-server-command">
          <p className="ob-hint">Run this on the machine. The code in it works once, for 15 minutes.</p>
          <pre className="ob-pre mono" data-testid="ob-server-command-text">{command}</pre>
          <div className="ob-actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true), () => setCopied(false))}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="ob-test-d">{step.done ? 'The machine connected.' : 'Waiting for the machine to connect…'}</span>
          </div>
        </div>
      )}
      <div className="ob-actions">
        <Link className="btn quiet" to="/settings/workspace/runners">Open Runners</Link>
        {setAside}
      </div>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

// ---- runners ----------------------------------------------------------------------------------------------------------------------------------------------

const KIND_WORDS: Record<string, string> = {
  hermes_pod: 'Hermes pod',
  hermes_gateway: 'Hermes gateway',
  claude_cli: 'Claude Code pod',
  codex_cli: 'Codex pod',
  llm_gateway: 'Model alias',
  server_agent: 'Agent on a server',
};

const STATE_WORDS: Record<string, string> = {
  ready: 'ready',
  not_set_up: 'not set up',
  waiting_for_sign_in: 'needs a sign-in',
  needs_sign_in: 'needs a sign-in',
  starting: 'starting',
  waiting_for_node: 'waiting for a machine',
  moving: 'moving',
  paused: 'paused',
  off: 'off',
};

/** The kinds a workspace can make its default; the others (a model alias, a Claude or Codex login, a server's agent) are named by a bot's own placement. */
const DEFAULTABLE_KINDS: readonly string[] = ['hermes_gateway', 'hermes_pod'];

/** Ask the runner one real question: make it the default so a bot lands on it, ask Brain's rehearsal, wait for the answer, and record that it answered. */
async function proveRunner(runner: RunnerFact, team: { slug: string }, setStage: (s: string) => void): Promise<void> {
  setStage('Checking that it is reachable…');
  // a Hermes gateway is checked per profile and answers for the bot's own profile only, so for it the real question below is the check
  if (runner.kind !== 'hermes_gateway') {
    const reach = await testBotRunner(runner.id);
    if (!reach.ok) throw new Error(reach.error ?? 'The runner did not answer.');
  }
  if (!runner.isDefault) {
    setStage('Making it the place bots run…');
    await setDefaultBotRunner(runner.id);
  }
  setStage('Asking a bot a real question…');
  const started = await startBotTest(team.slug, 'brain', 'In one short sentence, say hello and name the model you are.');
  const deadline = Date.now() + 150_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const result = await fetchBotTest(team.slug, 'brain', started.messageId);
    if (result.status === 'answered') break;
    if (result.status === 'failed' || result.status === 'stopped') throw new Error('The bot did not answer. Open its conversation to see why.');
    if (Date.now() > deadline) throw new Error('No answer came in time. The runner may still be starting; try again in a minute.');
    setStage('Waiting for the answer…');
  }
  await setOnboardingMark('runners', 'checked', runner.id);
}

export function RunnersStep({
  step,
  summary,
  facts,
  tests,
  aliases,
  hasProviders,
  state,
}: {
  step: OnboardingStep;
  summary: OnboardingSummary;
  facts: WizardFacts;
  tests: LlmAliasTest[];
  aliases: BoundAlias[];
  hasProviders: boolean;
  state: import('@manythreads/shared').OnboardingState;
}) {
  const act = useAction();
  const [stage, setStage] = useState<string | null>(null);
  const [offer, setOffer] = useState(false);
  const proven = provenRunner(facts.runners, state);
  const team = summary.firstTeam;
  const modelsReady = tests.some((t) => t.alias === 'smart' && t.outcome === 'ok' && t.current);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const prove = (r: RunnerFact): void => {
    if (!team) return;
    void act.run(async () => {
      try {
        await proveRunner(r, team, setStage);
      } finally {
        setStage(null);
        announceOnboardingChange();
      }
    });
  };

  const deployPod = (): void =>
    void act.run(async () => {
      let runner: RunnerFact | undefined = facts.runners.find((r) => r.kind === 'hermes_pod');
      if (runner === undefined) {
        const made = (await createBotRunner({ name: 'hermes', label: 'Hermes pod', kind: 'hermes_pod' })).runner;
        runner = { id: made.id as string, name: made.name, kind: made.kind, enabled: made.enabled, status: made.status, isDefault: made.isDefault };
      }
      if (!runner.enabled) await updateBotRunner(runner.id, { enabled: true });
      announceOnboardingChange();
      try {
        await proveRunner(runner, team ?? { slug: '' }, setStage);
      } finally {
        setStage(null);
        announceOnboardingChange();
      }
    });

  return (
    <>
      {facts.runners.length > 0 ? (
        <ul className="ob-rows" data-testid="ob-runners">
          {facts.runners.map((r) => (
            <li key={r.id} className="ob-alias ob-runner" data-runner={r.name} data-ready={isWorkingRunner(r) ? 'true' : 'false'}>
              <span className="ob-runner-name">{r.name}</span>
              <span className="ob-test-d">{KIND_WORDS[r.kind] ?? r.kind}{r.isDefault ? ', where bots run by default' : ''}</span>
              <span>
                {DEFAULTABLE_KINDS.includes(r.kind) ? (
                  <button type="button" className="btn sm" disabled={act.busy || !isWorkingRunner(r) || !team} onClick={() => prove(r)} data-testid={`ob-runner-prove-${r.name}`}>
                    Ask a real question
                  </button>
                ) : (
                  <span className="ob-test-d">Bots are placed on it one by one, so it cannot be tried here.</span>
                )}
              </span>
              <span className="ob-test">
                <span className={`chip ${isWorkingRunner(r) ? 'ok' : 'warn'}`}>{STATE_WORDS[r.status] ?? r.status}</span>
                {proven?.id === r.id ? <span className="chip ok" data-testid="ob-runner-proven">answered</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {stage ? <p className="ob-hint" role="status" data-testid="ob-runner-stage">{stage}</p> : null}
      {step.done ? null : (
        <>
          {facts.runners.length === 0 || offer ? (
            <div className="ob-offer" data-testid="ob-runner-offer">
              <h3 className="ob-offer-title">Deploy a Hermes pod for your teams</h3>
              <p className="ob-hint">
                A Hermes pod is a small program in this site's own cluster that runs your bots with the models you connected. It needs no subscription, only a model
                key. {modelsReady ? 'Your models answered, so it is ready to go.' : 'First connect a model below and test it.'}
              </p>
              {modelsReady ? null : <ModelSetup tests={tests} aliases={aliases} hasProviders={hasProviders} compact />}
              <div className="ob-actions">
                <button type="button" className="btn primary" disabled={act.busy || !modelsReady || !team} onClick={deployPod} data-testid="ob-runner-deploy">
                  {act.busy ? 'Working…' : 'Deploy it and ask a real question'}
                </button>
                {!team ? <span className="ob-test-d">Make a team first.</span> : null}
              </div>
            </div>
          ) : (
            <div className="ob-actions">
              <button type="button" className="btn quiet" onClick={() => setOffer(true)} data-testid="ob-runner-offer-open">Deploy a Hermes pod instead</button>
            </div>
          )}
          <div className="ob-actions">
            <Link className="btn" to="/settings/workspace/runners">Open Runners</Link>
            <button type="button" className="btn" onClick={announceOnboardingChange}>Check again</button>
          </div>
          {facts.runners.length === 0 ? <p className="ob-hint">You can also connect a server (the step before) or sign a Claude Code or Codex pod in from Runners.</p> : null}
        </>
      )}
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

// ---- where bots run ---------------------------------------------------------------------------------------------------------------------------------------

export function BotsStep({ step, summary, facts }: { step: OnboardingStep; summary: OnboardingSummary; facts: WizardFacts }) {
  const act = useAction();
  const team = summary.firstTeam;
  const working = facts.runners.filter((r) => isWorkingRunner(r) && DEFAULTABLE_KINDS.includes(r.kind));
  const def = facts.runners.find((r) => r.isDefault && r.enabled);
  const [pick, setPick] = useState<string>('');
  const chosen = pick || working[0]?.id || '';
  return (
    <>
      {def ? (
        <p className="ob-hint" data-testid="ob-bots-default">Bots run on <strong>{def.name}</strong> unless a bot's own file names another place.</p>
      ) : working.length > 0 ? (
        <div className="ob-form">
          <label>
            Run bots on
            <select value={chosen} onChange={(e) => setPick(e.target.value)} data-testid="ob-bots-runner">
              {working.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={act.busy || chosen === ''}
            onClick={() => void act.run(async () => { await setDefaultBotRunner(chosen); announceOnboardingChange(); })}
            data-testid="ob-bots-set"
          >
            Use it
          </button>
        </div>
      ) : (
        <p className="ob-hint">No runner is ready yet. Finish the step before.</p>
      )}
      <div className="ob-actions">
        {step.to ? <Link className="btn" to={step.to}>Open {team?.name ?? 'the team'}'s bots</Link> : null}
        <button type="button" className="btn" onClick={announceOnboardingChange}>Check again</button>
      </div>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

