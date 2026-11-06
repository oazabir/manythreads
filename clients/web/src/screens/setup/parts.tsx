import type { GradedRequirement, SetupInventory, SetupQuestion } from '@manythreads/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { proIcon } from '../../components/proicon';
import { Alert } from '../../components/ui';
import { BotWorkingIcon, TemplateDesignIcon, TemplateEngineeringIcon, TemplateMarketingIcon, TemplateResearchIcon, TemplateSupportIcon } from '../../shell/icons';
import { EXAMPLE_CARDS, GRADE_WORDS, GUARD_WORDS, RUNTIME_WORDS, TRIGGER_WORDS, answeredCount, briefFromExample, briefReady, feasibilitySummary, filterExamples, sortedByGrade, type Draft, type Example } from './model';

/*
 * The pieces of the "Add a bot" screen (mockup section `setup`): the brief, what the helper found, the grades, the questions. Every class is prefixed `su-`.
 */

const TEMPLATE_ICONS: Record<string, ReturnType<typeof proIcon>> = {
  engineering: TemplateEngineeringIcon,
  'customer-support': TemplateSupportIcon,
  marketing: TemplateMarketingIcon,
  'product-design': TemplateDesignIcon,
  research: TemplateResearchIcon,
};

/** One example as a card: the icon of the template it comes from, the bot's name and one line about it. */
function ExampleCard({ example, picked, describedBy, testId, onPick }: { example: Example; picked: boolean; describedBy?: string; testId: string; onPick: (e: Example) => void }) {
  const Icon = TEMPLATE_ICONS[example.templateId] ?? BotWorkingIcon;
  return (
    <button
      type="button"
      className="su-ex"
      aria-pressed={picked}
      aria-describedby={describedBy}
      title={`${example.name}, from the ${example.template} template: ${example.role}`}
      data-testid={testId}
      data-example={example.key}
      onClick={() => onPick(example)}
    >
      <span className="su-ex-icon"><Icon /></span>
      <span className="su-ex-text">
        <b className="su-ex-name">{example.name}</b>
        <span className="su-ex-role">{example.role}</span>
      </span>
    </button>
  );
}

/** Every example in a dialog, with a box that narrows the list as the person types. Picking one closes the dialog and fills the brief. */
function AllExamples({ examples, picked, onPick, onClose }: { examples: ReadonlyArray<Example>; picked: string | null; onPick: (e: Example) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const filterId = useId();
  const shown = filterExamples(examples, query);
  return (
    <Dialog title="All examples" onClose={onClose} wide testId="setup-examples-dialog" footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <label className="su-label" htmlFor={filterId}>Filter examples</label>
      <input id={filterId} type="search" className="su-input" value={query} placeholder="A name or a word, like “review”" autoComplete="off" data-testid="setup-examples-filter" onChange={(e) => setQuery(e.target.value)} />
      <p className="su-hint" role="status" aria-live="polite" data-testid="setup-examples-count">{shown.length === examples.length ? `${examples.length} examples` : `${shown.length} of ${examples.length} examples`}</p>
      {shown.length === 0 ? (
        <p className="su-hint">No example matches that. Clear the box to see them all.</p>
      ) : (
        <ul className="su-ex-list">
          {shown.map((e) => (
            <li key={e.key}>
              <ExampleCard example={e} picked={picked === e.key} testId="setup-example-all" onPick={onPick} />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function BriefForm({ slug, busy, error, onStart, examples = [] }: { slug: string; busy: boolean; error: string | null; onStart: (brief: string, name: string) => void; examples?: ReadonlyArray<Example> }) {
  const [brief, setBrief] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [pickCount, setPickCount] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const exampleId = useId();
  const briefId = useId();
  const nameId = useId();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (briefReady(brief) && !busy) onStart(brief.trim(), name.trim());
  };
  const pick = (e: Example): void => {
    setPicked(e.key);
    setBrief(briefFromExample(e));
    setAll(false);
    setPickCount((n) => n + 1);
  };
  // after a pick the person's next move is to change the text: put the cursor in the box (after the dialog, if one was open, has given focus back)
  useEffect(() => {
    if (pickCount === 0) return;
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [pickCount]);
  const cards = examples.slice(0, EXAMPLE_CARDS);
  return (
    <div className="su-brief-grid">
      <div className="su-main">
        <form className="su-card" onSubmit={submit} data-testid="setup-brief-form" data-landmark="setup-brief">
          <label className="su-label" htmlFor={briefId}>What should this bot do?</label>
          <p className="su-hint" id={`${briefId}-hint`}>A few sentences. It will work out the rest and ask you about anything it can't find.</p>
          <textarea
            id={briefId}
            ref={box}
            className="su-textarea"
            rows={7}
            maxLength={4000}
            value={brief}
            aria-describedby={`${briefId}-hint`}
            data-testid="setup-brief"
            onChange={(e) => {
              setBrief(e.target.value);
              setPicked(null);
            }}
          />
          <label className="su-label" htmlFor={nameId}>Name <span className="su-opt">(optional — it will suggest one)</span></label>
          <input id={nameId} className="su-input" value={name} maxLength={80} data-testid="setup-name" onChange={(e) => setName(e.target.value)} />
          {error ? <Alert>{error}</Alert> : null}
          <div className="su-actions">
            <button type="submit" className="btn primary" disabled={!briefReady(brief) || busy} data-testid="setup-start">{busy ? 'Starting…' : 'Let it explore'}</button>
            <Link className="btn" to={`/t/${slug}/files?path=bots`} data-testid="setup-by-hand">Configure by hand instead</Link>
          </div>
        </form>
        {cards.length > 0 ? (
          <section className="su-examples" aria-labelledby={`${exampleId}-h`} data-testid="setup-examples">
            <h3 className="su-h" id={`${exampleId}-h`}>Or start from an example</h3>
            <p className="su-hint" id={`${exampleId}-hint`}>Bots that come with the team templates, the ones closest to this team first. Pick one to fill in the box above, then change it to fit.</p>
            <ul className="su-ex-grid">
              {cards.map((e) => (
                <li key={e.key}>
                  <ExampleCard example={e} picked={picked === e.key} describedBy={`${exampleId}-hint`} testId="setup-example" onPick={pick} />
                </li>
              ))}
            </ul>
            {examples.length > cards.length ? (
              <button type="button" className="btn su-ex-all" aria-haspopup="dialog" data-testid="setup-examples-all" onClick={() => setAll(true)}>See all {examples.length}</button>
            ) : null}
          </section>
        ) : null}
        {all ? <AllExamples examples={examples} picked={picked} onPick={pick} onClose={() => setAll(false)} /> : null}
      </div>
      <aside className="su-side" aria-label="How it works">
        <section className="su-note">
          <h3 className="su-h su-h-quiet">What happens next</h3>
          <ol className="su-steps">
            <li>It lists what this team has: tools, notes to read, places a bot can run and ways to start one.</li>
            <li>It checks each thing you asked for: covered, needs approval, missing, not allowed, or unclear.</li>
            <li>It asks you one question for each gap, all at once.</li>
            <li>It drafts the bot (its description file and its settings). A person approves it.</li>
          </ol>
        </section>
        <section className="su-note">
          <h3 className="su-h su-h-quiet">What it cannot do</h3>
          <ul className="su-list">
            <li>Give itself a tool, a connection to another app or a set of notes.</li>
            <li>Loosen a safety setting or give more than you may give.</li>
            <li>Change anything before a person approves.</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

const names = (items: ReadonlyArray<string>, empty: string): string => (items.length === 0 ? empty : items.join(' · '));

/** What the helper found, as a short list. The same names the helper was shown; nothing more. */
export function InventoryPanel({ inv }: { inv: SetupInventory }) {
  const rows: Array<[string, string]> = [
    ['Bots', names(inv.bots.map((b) => b.name), 'none yet')],
    ['Notes to read (knowledge bases)', names(inv.knowledge.map((k) => k.name), 'none')],
    ['Skills (saved how-to instructions)', names(inv.skills.map((s) => s.slug), 'none')],
    ['Places a bot can run', names(inv.runners.map((r) => r.name), 'none this team may use')],
    ['Channels', names(inv.channels.map((c) => `#${c.name}`), 'none')],
    ['What can start a bot', names(inv.triggers.filter((t) => t.available).map((t) => TRIGGER_WORDS[t.type] ?? t.type), 'none')],
    ['AI models', names(inv.models.map((m) => m.alias), 'none connected')],
    ['Connections to other apps', inv.connections.length === 0 ? inv.connectionsNote : names(inv.connections.map((c) => c.name), 'none')],
    ['Commands, files and web browsing', names(inv.runtimeAllowed.map((r) => RUNTIME_WORDS[r] ?? r), 'not allowed for bots in this team')],
    ['Safety setting', GUARD_WORDS[inv.guardDefault] ?? inv.guardDefault],
  ];
  return (
    <section className="su-card" aria-labelledby="su-inv-h" data-testid="setup-inventory">
      <h3 className="su-h" id="su-inv-h">What {inv.team.name} has</h3>
      <dl className="su-inv">
        {rows.map(([k, v]) => (
          <div key={k} className="su-inv-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="su-hint">
        You are {inv.asker.role === 'admin' ? 'a workspace admin' : inv.asker.role === 'lead' ? "this team's lead" : 'a member'}:{' '}
        {inv.asker.canGrantDestructive ? 'you can switch on tools that change things (they still ask a person each time).' : 'you cannot switch on tools that change things.'}
      </p>
    </section>
  );
}

export function GradeChip({ grade }: { grade: GradedRequirement['grade'] }) {
  return <span className={`su-grade ${grade}`} data-testid="setup-grade" data-grade={grade}>{GRADE_WORDS[grade]}</span>;
}

/** Each thing the brief needs, with the grade the platform gave it and why. */
export function Feasibility({ requirements }: { requirements: ReadonlyArray<GradedRequirement> }) {
  if (requirements.length === 0) return null;
  return (
    <section className="su-card" aria-labelledby="su-feas-h" data-testid="setup-feasibility">
      <h3 className="su-h" id="su-feas-h">Can it be done? <span className="su-count">{feasibilitySummary(requirements)}</span></h3>
      <ul className="su-feas">
        {sortedByGrade(requirements).map((r) => (
          <li key={r.id} className="su-feas-row" data-requirement={r.id}>
            <GradeChip grade={r.grade} />
            <span className="su-feas-text">
              <b>{r.text}</b>
              <span className="su-feas-why">{r.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One batch of questions, numbered, each with a few tappable options and a box for the person's own words. All of them are answered together. */
export function Questions({
  questions,
  draft,
  busy,
  error,
  onChange,
  onSend,
}: {
  questions: ReadonlyArray<SetupQuestion>;
  draft: Draft;
  busy: boolean;
  error: string | null;
  onChange: (questionId: string, text: string) => void;
  onSend: () => void;
}) {
  const done = answeredCount(questions, draft);
  const ready = done === questions.length;
  return (
    <form
      className="su-card"
      aria-labelledby="su-q-h"
      data-testid="setup-questions"
      data-landmark="setup-questions"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSend();
      }}
    >
      <h3 className="su-h" id="su-q-h" tabIndex={-1}>Questions <span className="su-count">{done} of {questions.length} answered</span></h3>
      <ol className="su-qs">
        {questions.map((q, i) => {
          const value = draft[q.id] ?? '';
          return (
            <li key={q.id} className="su-q" data-question={q.id}>
              <fieldset className="su-fieldset">
                <legend className="su-legend">{i + 1}. {q.question}</legend>
                {q.options.length > 0 ? (
                  <div className="su-options" role="group" aria-label={`Quick answers for question ${i + 1}`}>
                    {q.options.map((o) => (
                      <button key={o} type="button" className="su-option" aria-pressed={value === o} data-testid="setup-option" onClick={() => onChange(q.id, o)}>{o}</button>
                    ))}
                  </div>
                ) : null}
                <label className="su-sr" htmlFor={`su-a-${q.id}`}>Your answer to question {i + 1}</label>
                <input
                  id={`su-a-${q.id}`}
                  className="su-input"
                  value={value}
                  maxLength={1000}
                  placeholder="Or write your own answer"
                  data-testid="setup-answer"
                  onChange={(e) => onChange(q.id, e.target.value)}
                />
              </fieldset>
            </li>
          );
        })}
      </ol>
      {error ? <Alert>{error}</Alert> : null}
      <div className="su-actions">
        <button type="submit" className="btn primary" disabled={!ready || busy} data-testid="setup-send">{busy ? 'Sending…' : 'Send answers'}</button>
        {!ready ? <span className="su-hint" aria-live="polite">Answer every question to go on.</span> : null}
      </div>
    </form>
  );
}
