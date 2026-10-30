import { useState } from 'react';
import { Link } from 'react-router';
import { DEFAULT_CONVERSATION_PROMPTS, MAX_CONVERSATION_PROMPTS, type BotFrontmatter, type BotRun, type BotSummary } from '@manythreads/shared';
import { Time } from '../../components/ui';
import { ChipsField, NumberField, SelectField, SwitchRow, TextField } from './fields';
import { EvalRunPanel } from './evals';
import { Block, Mono, NotSet, Row } from './parts';
import type { DefinitionDraft } from './store';

/*
 * The fourteen tabs of one bot page (SPEC §7.2, PLAN P5-05, `[proto §05]`). Every tab is a view of the same file — BOT.md — and
 * most of them edit one section of it through the draft, which keeps what was typed and validates the whole document on every change:
 * Save stays off while the loader would refuse the definition. Audit reads the runs the server holds.
 *
 * Two rules hold everywhere:
 *  - `bots/`, `TEAM.md`, `skills/` and `routines/` are never bot-writable, so the Capabilities tab says so and never offers a
 *    capability that would contradict it.
 *  - A member who is not a team lead sees every tab read-only: Save is not offered and the same change is a pull request, exactly as
 *    the Files screen offers for a guarded path.
 */

type TabProps = {
  bot: BotSummary;
  draft: DefinitionDraft;
  slug: string;
  canEdit: boolean;
  runs: BotRun[];
};

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CHANNEL_RE = /^#[a-z0-9][a-z0-9._-]*$/;
const CAP_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*|\.[a-z][a-z0-9_]*\*)+$/;
const PRINCIPAL_RE = /^(role|person):[^\s:]+$/;
const capabilityOk = (v: string): boolean => CAP_RE.test(v) || v === 'person:*';

const fm = (draft: DefinitionDraft): BotFrontmatter => draft.frontmatter!;

/** The patch helper every tab uses: `set` merges a partial section, leaving the rest of the definition alone. */
const sectionOf = <K extends keyof BotFrontmatter>(draft: DefinitionDraft) => (key: K, value: BotFrontmatter[K]): void =>
  draft.patch((d) => ({ ...d, [key]: value }));

// ---- Identity -----------------------------------------------------------------------------------------------------------
export function IdentityTab({ draft, canEdit }: TabProps) {
  const f = fm(draft);
  const set = sectionOf(draft);
  return (
    <Block title="Identity" count="name, role, kind, runtime, visibility">
      <TextField label="Name" value={f.name} readOnly={!canEdit} testId="bot-name" error={draft.issueAt('name')?.message} onChange={(name) => set('name', name)} hint="Shown on the roster and wherever the bot is mentioned." />
      <TextField label="Role" value={f.role} readOnly={!canEdit} testId="bot-role" error={draft.issueAt('role')?.message} onChange={(role) => set('role', role)} hint="One line: what this bot is for. The platform never reads meaning into it." />
      <SelectField
        label="Kind"
        value={f.kind}
        readOnly={!canEdit}
        testId="bot-kind"
        options={[{ value: 'agent', label: 'agent — runs with a model' }, { value: 'automation', label: 'automation — a rules run, no model' }]}
        onChange={(kind) => draft.patch((d) => ({ ...d, kind, ...(kind === 'automation' ? { runtime: 'rules' as const } : {}) }))}
        hint={f.kind === 'automation' ? 'An automation runs the rules runtime and never calls a model.' : undefined}
      />
      <SelectField
        label="Runtime"
        value={f.runtime}
        readOnly={!canEdit}
        testId="bot-runtime"
        options={[{ value: 'hermes', label: 'hermes' }, { value: 'rules', label: 'rules' }]}
        onChange={(runtime) => set('runtime', runtime)}
      />
      <SelectField
        label="Visibility"
        value={f.visibility ?? 'team'}
        readOnly={!canEdit}
        testId="bot-visibility"
        options={[{ value: 'team', label: 'team — this team only (default)' }, { value: 'workspace', label: 'workspace — a workspace admin shares it across teams' }]}
        onChange={(visibility) => set('visibility', visibility)}
      />
    </Block>
  );
}

// ---- Behaviour ----------------------------------------------------------------------------------------------------------
export function BehaviourTab({ draft, canEdit }: TabProps) {
  const edited = draft.body !== draft.originalBody;
  return (
    <Block title="Behaviour" count={edited ? 'edited' : 'unchanged'} action={<span className="b-hint">The body of BOT.md is the prompt itself.</span>}>
      <textarea
        className="b-body"
        data-testid="bot-body"
        aria-label="Behaviour — the body of BOT.md"
        spellCheck={false}
        readOnly={!canEdit}
        value={draft.body}
        onChange={(e) => draft.setBody(e.target.value)}
      />
      <p className="b-hint">
        {canEdit
          ? 'This text is what the bot is. Everything the platform enforces regardless of it — budgets, approvals, who it may tag — is applied by the platform, not by the prompt.'
          : 'You can read this definition but not change it. Changes to bots/ go through a proposal.'}
      </p>
    </Block>
  );
}

// ---- Triggers -----------------------------------------------------------------------------------------------------------
const TRIGGER_TYPES = ['conversation', 'mention', 'routine', 'task_assigned', 'inbox', 'channel_message', 'webhook'] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];
type Triggers = NonNullable<BotFrontmatter['triggers']>;

export function TriggersTab({ draft, canEdit }: TabProps) {
  const triggers: Triggers = fm(draft).triggers ?? [];
  const set = (next: Triggers): void => draft.patch((d) => ({ ...d, triggers: next.length > 0 ? next : undefined }));
  const replace = (i: number, value: Triggers[number]): void => set(triggers.map((x, j) => (j === i ? value : x)));
  const prompts = fm(draft).conversation?.prompts ?? [];
  const setPrompts = (next: string[]): void =>
    draft.patch((d) => ({ ...d, conversation: next.length > 0 ? { ...d.conversation, prompts: next } : undefined }));
  return (
    <>
    <Block title="Triggers" count={`${triggers.length} ${triggers.length === 1 ? 'trigger' : 'triggers'}`}>
      {triggers.length === 0 ? (
        <NotSet>No triggers: this bot never runs, and nobody can talk to it. Add a conversation trigger to let people ask it things.</NotSet>
      ) : !triggers.some((t) => t.type === 'conversation') ? (
        <NotSet>No conversation trigger: nobody can talk to this bot. Add one to let people ask it things.</NotSet>
      ) : null}
      {triggers.map((t, i) => (
        <div className="b-trg" key={`${t.type}-${String(i)}`} data-testid="trigger-row" data-trigger={t.type}>
          <span className="b-trg-type">{t.type}</span>
          <div className="b-trg-what">
            {t.type === 'mention' || t.type === 'channel_message' ? (
              <ChipsField
                label="Channels"
                values={t.source?.channels ?? []}
                readOnly={!canEdit}
                placeholder="#dev"
                valid={(v) => CHANNEL_RE.test(v)}
                onChange={(channels) => replace(i, { type: t.type, ...(channels.length > 0 ? { source: { channels } } : {}) } as Triggers[number])}
                hint={<span>Written as <Mono>#dev</Mono>; the trigger fires in the channels named here.</span>}
              />
            ) : null}
            {t.type === 'routine' ? (
              <div className="b-trg-fields">
                <TextField label="Routine" value={t.routine ?? ''} readOnly={!canEdit} onChange={(routine) => replace(i, { ...t, routine: routine === '' ? undefined : routine })} hint={<span>The slug under <Mono>routines/</Mono>.</span>} />
                <TextField label="Cron" value={t.cron ?? ''} readOnly={!canEdit} onChange={(cron) => replace(i, { ...t, cron: cron === '' ? undefined : cron })} hint="For example 0 9 * * 1 — Mondays 09:00." />
              </div>
            ) : null}
            {t.type === 'inbox' ? (
              <div className="b-trg-fields">
                <TextField label="Connection" value={t.connection ?? ''} readOnly={!canEdit} onChange={(connection) => replace(i, { ...t, connection: connection === '' ? undefined : connection })} hint="A connection of this team." />
                <TextField label="Folder" value={t.folder ?? ''} readOnly={!canEdit} onChange={(folder) => replace(i, { ...t, folder: folder === '' ? undefined : folder })} />
                <TextField label="Filter" value={t.filter ?? ''} readOnly={!canEdit} onChange={(filter) => replace(i, { ...t, filter: filter === '' ? undefined : filter })} />
              </div>
            ) : null}
            {t.type === 'webhook' ? (
              <div className="b-trg-fields">
                <TextField label="Connection" value={t.connection ?? ''} readOnly={!canEdit} onChange={(connection) => replace(i, { ...t, connection: connection === '' ? undefined : connection })} />
                <TextField label="Event" value={t.event ?? ''} readOnly={!canEdit} onChange={(event) => replace(i, { ...t, event: event === '' ? undefined : event })} hint="For example release.published." />
              </div>
            ) : null}
            {t.type === 'conversation' ? <div className="b-hint">Lets people talk to this bot in a conversation; without it, nobody can.</div> : null}
            {t.type === 'task_assigned' ? <div className="b-hint">Runs when a task on the board is assigned to this bot.</div> : null}
          </div>
          {canEdit ? <button type="button" className="btn s" aria-label={`Remove the ${t.type} trigger`} onClick={() => set(triggers.filter((_x, j) => j !== i))}>Remove</button> : null}
        </div>
      ))}
      {canEdit ? (
        <div className="b-add-row">
          <AddTrigger existing={triggers.map((t) => t.type)} onAdd={(type) => set([...triggers, { type } as Triggers[number]])} />
        </div>
      ) : null}
    </Block>
    <Block title="Conversation" count="example questions on the empty state">
      <ChipsField
        label="Prompts"
        values={prompts}
        onChange={setPrompts}
        readOnly={!canEdit}
        placeholder="What is blocking the release?"
        valid={(v) => v.length <= 200 && prompts.length < MAX_CONVERSATION_PROMPTS}
        testId="conversation-prompts"
        hint={
          prompts.length === 0
            ? `None written: people see “${DEFAULT_CONVERSATION_PROMPTS.join('”, “')}”. Up to ${String(MAX_CONVERSATION_PROMPTS)}; each is sent as written when chosen.`
            : `Shown as chips above the message box while a person has no conversation yet. Up to ${String(MAX_CONVERSATION_PROMPTS)}.`
        }
      />
    </Block>
    </>
  );
}

function AddTrigger({ onAdd, existing }: { onAdd: (type: TriggerType) => void; existing: readonly string[] }) {
  const [type, setType] = useState<TriggerType>('conversation');
  return (
    <>
      <select aria-label="Trigger type to add" value={type} onChange={(e) => setType(e.target.value as TriggerType)}>
        {TRIGGER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <button type="button" className="btn s" data-testid="add-trigger" disabled={existing.includes(type)} onClick={() => onAdd(type)}>Add trigger</button>
    </>
  );
}

// ---- Capabilities -------------------------------------------------------------------------------------------------------
export function CapabilitiesTab({ draft, canEdit }: TabProps) {
  const caps = fm(draft).capabilities ?? {};
  const native = caps.native ?? [];
  const runtime = caps.runtime ?? [];
  const connections = caps.connections ?? [];
  const setNative = (next: string[]): void => draft.patch((d) => ({ ...d, capabilities: { ...d.capabilities, native: next.length > 0 ? next : undefined } }));
  const setRuntime = (next: string[]): void => draft.patch((d) => ({ ...d, capabilities: { ...d.capabilities, runtime: next.length > 0 ? next : undefined } }));
  const setConnectionTools = (i: number, tools: string[]): void =>
    draft.patch((d) => ({ ...d, capabilities: { ...d.capabilities, connections: connections.map((c, j) => (j === i ? { ...c, tools } : c)) } }));
  return (
    <>
      <Block title="Native" count="platform tools via the MCP gateway">
        <ChipsField
          label="Granted"
          values={native}
          onChange={setNative}
          readOnly={!canEdit}
          placeholder="messages.post"
          valid={capabilityOk}
          testId="caps-native"
          hint={<span>One allowlist: native tools, runtime tools and connection tools together. <Mono>person:*</Mono> means the asking person&apos;s own connections.</span>}
        />
      </Block>
      <Block title="Runtime" count="inside the bot's own sandbox">
        <ChipsField label="Granted" values={runtime} onChange={setRuntime} readOnly={!canEdit} placeholder="shell" valid={(v) => SLUG_RE.test(v)} testId="caps-runtime" />
      </Block>
      <Block title="Connections" count="granted from this team's connections">
        {connections.length === 0 ? <NotSet>No connection tools are granted to this bot.</NotSet> : null}
        {connections.map((c, i) => (
          <Row key={`${c.name}-${String(i)}`} label={c.name} hint={c.name === 'person:*' ? "the asking person's own connections" : undefined}>
            <ChipsField label="Tools" values={c.tools} readOnly={!canEdit} valid={capabilityOk} onChange={(tools) => setConnectionTools(i, tools)} />
            {canEdit ? (
              <button type="button" className="btn s" onClick={() => draft.patch((d) => ({ ...d, capabilities: { ...d.capabilities, connections: connections.filter((_x, j) => j !== i) } }))}>
                Remove connection
              </button>
            ) : null}
          </Row>
        ))}
      </Block>
      <Block title="Never bot-writable">
        <p className="b-notset">
          <Mono>bots/</Mono>, <Mono>TEAM.md</Mono>, <Mono>skills/</Mono> and <Mono>routines/</Mono> are not in any allowlist and cannot be: a change to them
          arrives only as an approved proposal, whatever this file says. The broker refuses the write and records the denial.
        </p>
      </Block>
    </>
  );
}

// ---- Knowledge ----------------------------------------------------------------------------------------------------------
export function KnowledgeTab({ draft, canEdit }: TabProps) {
  const bases = fm(draft).knowledge ?? [];
  const set = (next: NonNullable<BotFrontmatter['knowledge']>): void => draft.patch((d) => ({ ...d, knowledge: next.length > 0 ? next : undefined }));
  const [base, setBase] = useState('');
  const canAdd = SLUG_RE.test(base.trim()) && !bases.some((b) => b.base === base.trim());
  return (
    <Block title="Knowledge" count={`${bases.length} ${bases.length === 1 ? 'base' : 'bases'}`}>
      {bases.length === 0 ? <NotSet>No knowledge bases: this bot answers from the team repo, messages and memory only.</NotSet> : null}
      {bases.map((k, i) => (
        <div className="b-rowline" key={`${k.base}-${String(i)}`} data-testid="knowledge-row">
          <div className="b-lab"><Mono>knowledge/{k.base}</Mono></div>
          <div className="b-val">
            <SwitchRow
              label="Answer only from this base"
              hint="A question with no supporting passage gets no answer."
              checked={k.answer_only_from === true}
              readOnly={!canEdit}
              onChange={(on) => set(bases.map((x, j) => (j === i ? (on ? { ...x, answer_only_from: true } : { base: x.base }) : x)))}
            />
            {canEdit ? <button type="button" className="btn s" onClick={() => set(bases.filter((_x, j) => j !== i))}>Remove base</button> : null}
          </div>
        </div>
      ))}
      {canEdit ? (
        <div className="b-add-row">
          <input aria-label="Knowledge base slug" placeholder="architecture-docs" value={base} onChange={(e) => setBase(e.target.value)} />
          <button type="button" className="btn s" disabled={!canAdd} onClick={() => { set([...bases, { base: base.trim() }]); setBase(''); }}>Add base</button>
        </div>
      ) : null}
    </Block>
  );
}

// ---- Memory -------------------------------------------------------------------------------------------------------------
export function MemoryTab({ draft, canEdit, bot, slug }: TabProps) {
  const m = fm(draft).memory ?? {};
  const grant = m.grants?.[0];
  const bank = `team:${slug}`;
  const setMemory = (patch: Partial<NonNullable<BotFrontmatter['memory']>>): void => draft.patch((d) => ({ ...d, memory: { ...d.memory, ...patch } }));
  return (
    <>
      <Block title="Private file" count="this bot only, in the team repo">
        <TextField label="File" value={m.file ?? ''} readOnly={!canEdit} placeholder="memory.md" onChange={(file) => setMemory({ file: file === '' ? undefined : file })} hint={<Mono>bots/{bot.slug}/memory.md</Mono>} />
        <NumberField label="Max lines" value={m.maxLines} readOnly={!canEdit} min={1} onChange={(maxLines) => setMemory({ maxLines })} hint="When the file crosses this, the Workshop proposes a compaction." />
        <TextField label="People notes" value={m.people ?? ''} readOnly={!canEdit} placeholder="people/<id>.md" onChange={(people) => setMemory({ people: people === '' ? undefined : people })} />
      </Block>
      <Block title="Team bank" count="one Hindsight bank per team, derived by the platform">
        <Row label={<Mono>{bank}</Mono>} hint="The bank is derived from the bot's team. A bot cannot name one, and a forged bank is ignored.">
          <SelectField
            label="Access"
            value={grant?.access}
            readOnly={!canEdit}
            testId="memory-access"
            options={[{ value: 'read', label: 'read' }, { value: 'readwrite', label: 'readwrite' }]}
            onChange={(access) => setMemory({ grants: [{ bank, access }] })}
          />
          {canEdit && grant ? <button type="button" className="btn s" onClick={() => setMemory({ grants: undefined })}>Remove grant</button> : null}
        </Row>
        <p className="b-notset">
          A run that read a <Mono>person:*</Mono> source retains no wider than that source: to <Mono>people/&lt;asker&gt;.md</Mono>, never the team bank.
          Private channels and DMs are never retained.
        </p>
      </Block>
    </>
  );
}

// ---- Model --------------------------------------------------------------------------------------------------------------
export function ModelTab({ draft, canEdit }: TabProps) {
  const m = fm(draft).model;
  const sub = m && 'subscription' in m ? m.subscription : undefined;
  const aliases = m?.aliases ?? [];
  const locked = !canEdit || sub !== undefined;
  const patchModelConfig = (patch: Partial<NonNullable<BotFrontmatter['model']>>): void => draft.patch((d) => ({ ...d, model: { ...d.model, ...patch } as BotFrontmatter['model'] }));
  return (
    <>
      <Block title="Gateway aliases" count="never a hard-coded model name">
        <ChipsField
          label="Aliases"
          values={aliases}
          readOnly={locked}
          placeholder="code"
          valid={(v) => SLUG_RE.test(v)}
          testId="model-aliases"
          onChange={(next) => patchModelConfig({ aliases: next.length > 0 ? next : undefined, subscription: undefined })}
          hint="Resolved at Workspace → LLM. A literal model name is refused by the schema."
        />
        <ChipsField label="Fallbacks" values={m?.fallbacks ?? []} readOnly={locked} valid={(v) => SLUG_RE.test(v)} onChange={(next) => patchModelConfig({ fallbacks: next.length > 0 ? next : undefined })} />
        <SelectField
          label="Effort"
          value={m?.effort}
          readOnly={locked}
          testId="model-effort"
          options={[{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }]}
          onChange={(effort) => patchModelConfig({ effort })}
        />
      </Block>
      <Block title="Budgets and rate limit" count="checked before the call">
        <NumberField label="Daily budget (USD)" value={m?.budgets?.dailyUsd} readOnly={locked} onChange={(dailyUsd) => patchModelConfig({ budgets: { ...m?.budgets, dailyUsd } })} />
        <NumberField label="Monthly budget (USD)" value={m?.budgets?.monthlyUsd} readOnly={locked} onChange={(monthlyUsd) => patchModelConfig({ budgets: { ...m?.budgets, monthlyUsd } })} />
        <NumberField label="Max tokens per run" value={m?.budgets?.maxTokensPerRun} readOnly={locked} onChange={(maxTokensPerRun) => patchModelConfig({ budgets: { ...m?.budgets, maxTokensPerRun } })} />
        <NumberField label="Requests per minute" value={m?.rateLimit?.requestsPerMinute} readOnly={locked} onChange={(rpm) => patchModelConfig({ rateLimit: rpm === undefined ? undefined : { requestsPerMinute: rpm } })} />
      </Block>
      <Block title="Subscription" count="bypasses the gateway guard">
        <SwitchRow
          label="Bind a person's subscription"
          hint="Off by default. A subscription runtime is bound to one person and never to anything the platform triggers."
          checked={sub !== undefined}
          readOnly={!canEdit}
          onChange={(on) => draft.patch((d) => ({ ...d, model: on ? { subscription: 'claude-code' } : { aliases: aliases.length > 0 ? aliases : ['fast'] } }))}
        />
        {sub !== undefined ? <p className="b-warnline">Subscription · bypasses the gateway guard</p> : null}
      </Block>
    </>
  );
}

// ---- Guard --------------------------------------------------------------------------------------------------------------
export function GuardTab({ draft, canEdit }: TabProps) {
  const g = fm(draft).guard ?? {};
  const setGuard = (patch: Partial<NonNullable<BotFrontmatter['guard']>>): void => draft.patch((d) => ({ ...d, guard: { ...d.guard, ...patch } }));
  return (
    <>
      <Block title="Preset">
        <SelectField
          label="Guard preset"
          value={g.preset}
          readOnly={!canEdit}
          testId="guard-preset"
          options={[
            { value: 'standard', label: 'standard' },
            { value: 'strict-egress', label: 'strict-egress' },
            { value: 'air-gapped', label: 'air-gapped' },
            { value: 'customer-facing', label: 'customer-facing' },
          ]}
          onChange={(preset) => setGuard({ preset })}
          hint="Bound at Workspace → LLM; its rules run at pre_egress and before the model call."
        />
      </Block>
      <Block title="Gate list" count="hand to a person before any model call">
        <ChipsField
          label="Topics and patterns"
          values={g.gate ?? []}
          readOnly={!canEdit}
          testId="guard-gate"
          placeholder="credential rotation"
          onChange={(gate) => setGuard({ gate: gate.length > 0 ? gate : undefined })}
          hint="Stage 1 matches these exactly or as patterns; stage 2 is a small classifier on the local alias that sees only the message."
        />
      </Block>
      <Block title="Bot rules">
        <ChipsField
          label="Rules"
          values={g.rules ?? []}
          readOnly={!canEdit}
          onChange={(rules) => setGuard({ rules: rules.length > 0 ? rules : undefined })}
          hint={<span>Free text the runtimes apply on top of the preset. <Mono>dlp:require_approval</Mono> holds a call that trips the guard in the Approvals inbox instead of redacting it.</span>}
        />
      </Block>
    </>
  );
}

// ---- Approvals ----------------------------------------------------------------------------------------------------------
export function ApprovalsTab({ draft, canEdit }: TabProps) {
  const a = fm(draft).approvals ?? {};
  const setApprovals = (patch: Partial<NonNullable<BotFrontmatter['approvals']>>): void => draft.patch((d) => ({ ...d, approvals: { ...d.approvals, ...patch } }));
  return (
    <>
      <Block title="What waits for a person">
        <p className="b-notset">
          One mechanism, four sources: a grant flagged <Mono>needsApproval</Mono> (here), an Environment with <Mono>protected: true</Mono>,{' '}
          <Mono>dispatch: strict</Mono> in TEAM.md, and the DLP <Mono>require_approval</Mono> outcome. Everything pending appears in one Approvals inbox.
        </p>
      </Block>
      <Block title="Tools flagged needs-approval" count="a person confirms each call">
        <ChipsField
          label="Tools"
          values={a.needsApproval ?? []}
          readOnly={!canEdit}
          testId="approvals-placeholder"
          placeholder="email.send"
          valid={capabilityOk}
          onChange={(needsApproval) => setApprovals({ needsApproval: needsApproval.length > 0 ? needsApproval : undefined })}
        />
      </Block>
      <Block title="Who approves">
        <ChipsField
          label="Approvers"
          values={a.approvers ?? []}
          readOnly={!canEdit}
          testId="approvals-approvers"
          placeholder="role:on-call"
          valid={(v) => PRINCIPAL_RE.test(v)}
          onChange={(approvers) => setApprovals({ approvers: approvers.length > 0 ? approvers : undefined })}
          hint={<span>A role tag from TEAM.md (<Mono>role:on-call</Mono>) or one person (<Mono>person:&lt;id&gt;</Mono>). The requester can never approve their own call.</span>}
        />
      </Block>
    </>
  );
}

// ---- Handover -----------------------------------------------------------------------------------------------------------
export function HandoverTab({ draft, canEdit, bot }: TabProps) {
  const h = fm(draft).handover ?? {};
  const setHandover = (patch: Partial<NonNullable<BotFrontmatter['handover']>>): void => draft.patch((d) => ({ ...d, handover: { ...d.handover, ...patch } }));
  return (
    <>
      <Block title="May tag" count="compiled into the bot's tasks.handoff grant">
        <ChipsField
          label="Bots"
          values={h.mayTag ?? []}
          readOnly={!canEdit}
          testId="handover-maytag"
          placeholder="reviewer"
          valid={(v) => SLUG_RE.test(v)}
          onChange={(mayTag) => setHandover({ mayTag: mayTag.length > 0 ? mayTag : undefined })}
          hint="The loader compiles handover.mayTag into the allowlist: the broker refuses a tag that is not here."
        />
        {bot.mayTag.length > 0 ? <div className="b-hint">Compiled now: {bot.mayTag.join(', ')}</div> : null}
      </Block>
      <Block title="To a person">
        <ChipsField
          label="Targets"
          values={h.toPerson ?? []}
          readOnly={!canEdit}
          placeholder="role:on-call"
          valid={(v) => PRINCIPAL_RE.test(v)}
          onChange={(toPerson) => setHandover({ toPerson: toPerson.length > 0 ? toPerson : undefined })}
        />
      </Block>
      <Block title="Escalation">
        <ChipsField
          label="Escalate to"
          values={h.escalation?.to ?? []}
          readOnly={!canEdit}
          placeholder="role:on-call"
          valid={(v) => PRINCIPAL_RE.test(v)}
          onChange={(to) => setHandover({ escalation: to.length > 0 ? { to, ...(h.escalation?.afterMinutes === undefined ? {} : { afterMinutes: h.escalation.afterMinutes }) } : undefined })}
        />
        <NumberField
          label="After (minutes)"
          value={h.escalation?.afterMinutes}
          readOnly={!canEdit || h.escalation === undefined}
          min={1}
          onChange={(afterMinutes) => setHandover({ escalation: h.escalation ? { to: h.escalation.to, afterMinutes } : undefined })}
        />
      </Block>
    </>
  );
}

// ---- Placement & limits -------------------------------------------------------------------------------------------------
export function PlacementTab({ draft, canEdit }: TabProps) {
  const p = fm(draft).placement ?? {};
  const l = fm(draft).limits ?? {};
  const setPlacement = (patch: Partial<NonNullable<BotFrontmatter['placement']>>): void => draft.patch((d) => ({ ...d, placement: { ...d.placement, ...patch } }));
  const setLimits = (patch: Partial<NonNullable<BotFrontmatter['limits']>>): void => draft.patch((d) => ({ ...d, limits: { ...d.limits, ...patch } }));
  return (
    <>
      <Block title="Placement" count="where the runtime starts">
        <TextField label="Node" value={p.node ?? ''} readOnly={!canEdit} placeholder="build-01" onChange={(node) => setPlacement({ node: node === '' ? undefined : node, runner: undefined })} hint="An in-cluster node (nodeSelector)." />
        <TextField label="Runner" value={p.runner ?? ''} readOnly={!canEdit} placeholder="test-server-01" onChange={(runner) => setPlacement({ runner: runner === '' ? undefined : runner, node: undefined })} hint="A server outside the cluster, dialling in with its own capabilities." />
        <ChipsField
          label="Requires"
          values={p.requires ?? []}
          readOnly={!canEdit}
          placeholder="chrome"
          valid={(v) => SLUG_RE.test(v)}
          onChange={(requires) => setPlacement({ requires: requires.length > 0 ? requires : undefined })}
          hint="A bot that asks for a capability the server lacks is refused at placement, not at runtime."
        />
        <TextField label="Isolation" value={p.isolation ?? ''} readOnly={!canEdit} placeholder="shared" onChange={(isolation) => setPlacement({ isolation: isolation === '' ? undefined : isolation })} />
      </Block>
      <Block title="Limits" count="the platform enforces these whatever the prompt says">
        <NumberField label="Session (minutes)" value={l.sessionMinutes} readOnly={!canEdit} min={1} onChange={(sessionMinutes) => setLimits({ sessionMinutes })} />
        <NumberField label="Timeout (seconds)" value={l.timeoutSeconds} readOnly={!canEdit} min={1} onChange={(timeoutSeconds) => setLimits({ timeoutSeconds })} />
        <NumberField label="Hops" value={l.hops} readOnly={!canEdit} min={0} onChange={(hops) => setLimits({ hops })} hint="How many times a piece of work may change hands." />
      </Block>
    </>
  );
}

// ---- Contract -----------------------------------------------------------------------------------------------------------
type OutputType = 'string' | 'number' | 'boolean' | 'url' | 'datetime';

export function ContractTab({ draft, canEdit }: TabProps) {
  const outputs = fm(draft).contract?.outputs ?? {};
  const entries = Object.entries(outputs) as [string, OutputType][];
  const [name, setName] = useState('');
  const setOutputs = (next: Record<string, OutputType>): void => draft.patch((d) => ({ ...d, contract: Object.keys(next).length > 0 ? { outputs: next } : undefined }));
  const canAdd = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim()) && !(name.trim() in outputs);
  return (
    <Block title="Contract" count="typed outputs when this bot is a task step">
      {entries.length === 0 ? <NotSet>No outputs declared: this bot is not used as a task step with a contract.</NotSet> : null}
      {entries.map(([key, type]) => (
        <div className="b-rowline" key={key} data-testid="output-row">
          <div className="b-lab"><Mono>{key}</Mono></div>
          <div className="b-val">
            <SelectField
              label="Type"
              value={type}
              readOnly={!canEdit}
              options={[{ value: 'string', label: 'string' }, { value: 'number', label: 'number' }, { value: 'boolean', label: 'boolean' }, { value: 'url', label: 'url' }, { value: 'datetime', label: 'datetime' }]}
              onChange={(t) => setOutputs({ ...outputs, [key]: t })}
            />
            {canEdit ? <button type="button" className="btn s" onClick={() => setOutputs(Object.fromEntries(entries.filter(([n]) => n !== key)))}>Remove output</button> : null}
          </div>
        </div>
      ))}
      {canEdit ? (
        <div className="b-add-row">
          <input aria-label="Output name" placeholder="sha" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn s" disabled={!canAdd} onClick={() => { setOutputs({ ...outputs, [name.trim()]: 'string' }); setName(''); }}>Add output</button>
        </div>
      ) : null}
    </Block>
  );
}

// ---- Evals --------------------------------------------------------------------------------------------------------------
export function EvalsTab({ draft, canEdit, slug, bot }: TabProps) {
  const e = fm(draft).evals;
  const [set, setSet] = useState('');
  const canAdd = SLUG_RE.test(set.trim());
  return (
    <Block title="Evals" count="run on demand, on every applied change and nightly">
      {!e ? <NotSet>No scenario set: this bot's prompt is not replayed against recorded cases yet.</NotSet> : null}
      {e ? (
        <>
          <Row label="Scenario set" hint="Recorded scenarios run against this BOT.md whenever a change to it is applied, every night, and when a lead asks."><Mono>{e.set}</Mono></Row>
          <div className="b-rowline">
            <div className="b-lab">Minimum score<div className="d">Below this, the run is flagged on this page.</div></div>
            <div className="b-val">
              <input
                type="number"
                data-testid="eval-minscore"
                aria-label="Minimum score"
                min={0}
                max={1}
                step={0.05}
                readOnly={!canEdit}
                value={String(e.minScore)}
                onChange={(ev) => {
                  const n = Number(ev.target.value);
                  if (Number.isFinite(n) && n >= 0 && n <= 1) draft.patch((d) => ({ ...d, evals: d.evals ? { ...d.evals, minScore: n } : d.evals }));
                }}
              />
            </div>
          </div>
          {canEdit ? <button type="button" className="btn s" onClick={() => draft.patch((d) => ({ ...d, evals: undefined }))}>Remove the eval set</button> : null}
          <EvalRunPanel slug={slug} botSlug={bot.slug} />
        </>
      ) : null}
      {canEdit && !e ? (
        <div className="b-add-row">
          <input aria-label="Eval set slug" placeholder="coder-20" value={set} onChange={(ev) => setSet(ev.target.value)} />
          <button type="button" className="btn s" disabled={!canAdd} onClick={() => { draft.patch((d) => ({ ...d, evals: { set: set.trim(), minScore: 0.9 } })); setSet(''); }}>Add a scenario set</button>
        </div>
      ) : null}
    </Block>
  );
}

// ---- Audit --------------------------------------------------------------------------------------------------------------
export function AuditTab({ bot, runs, slug }: TabProps) {
  return (
    <>
      <Block title="Runs" count={`${runs.length} newest`}>
        {runs.length === 0 ? (
          <NotSet>No runs yet. A run is recorded here the moment this bot is mentioned or is triggered. What someone asks it in a conversation is private to them, so those runs are listed only to the person who asked.</NotSet>
        ) : (
          runs.map((r) => (
            <div className="b-runrow" key={r.id} data-testid="run-row">
              <div>
                <div className="b-run-trigger">{r.trigger}</div>
                <div className="d">
                  {r.status === 'running' ? 'running now' : 'ended '}
                  {r.endedAt ? <Time iso={r.endedAt} /> : null}
                </div>
              </div>
              <span className={`b-state ${r.status === 'failed' ? 'bad' : r.status === 'done' ? 'ok' : ''}`}>{r.status}</span>
            </div>
          ))
        )}
      </Block>
      <Block title="Definition">
        <Row label="File" hint="Every change to the definition is a commit in the team repo, with its own history and diff.">
          <Link className="btn s" to={`/t/${slug}/files?open=bots/${bot.slug}/BOT.md`} data-testid="bot-open-file">Open bots/{bot.slug}/BOT.md in Files</Link>
        </Row>
        <Row label="Loaded from"><Mono>{bot.definitionSha.slice(0, 12)}</Mono></Row>
        <Row label="Last loaded"><Time iso={bot.updatedAt} /></Row>
      </Block>
    </>
  );
}

/** The tab panel for one id; Audit and Behaviour need the page's data, the rest only the draft. */
export function TabPanel({ id, ...props }: TabProps & { id: string }) {
  switch (id) {
    case 'identity':
      return <IdentityTab {...props} />;
    case 'behaviour':
      return <BehaviourTab {...props} />;
    case 'triggers':
      return <TriggersTab {...props} />;
    case 'capabilities':
      return <CapabilitiesTab {...props} />;
    case 'knowledge':
      return <KnowledgeTab {...props} />;
    case 'memory':
      return <MemoryTab {...props} />;
    case 'model':
      return <ModelTab {...props} />;
    case 'guard':
      return <GuardTab {...props} />;
    case 'approvals':
      return <ApprovalsTab {...props} />;
    case 'handover':
      return <HandoverTab {...props} />;
    case 'placement':
      return <PlacementTab {...props} />;
    case 'contract':
      return <ContractTab {...props} />;
    case 'evals':
      return <EvalsTab {...props} />;
    case 'audit':
      return <AuditTab {...props} />;
    default:
      return null;
  }
}