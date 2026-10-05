import { useId, useState, type ReactNode } from 'react';
import { Toggle } from '../../components/ui';

/*
 * The editing primitives of the bot page (PLAN P5-05). Every control here writes one part of the parsed frontmatter through the
 * draft, which validates the whole document on each change — a tab cannot produce a definition the loader would refuse. When the
 * person may not change `bots/` (a member who is not a lead), the same controls render read-only, so the page still describes the bot.
 */

export function TextField({ label, value, onChange, hint, readOnly, placeholder, testId }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  readOnly?: boolean;
  placeholder?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="b-fld">
      <label htmlFor={id}>{label}</label>
      <input id={id} data-testid={testId} value={value} readOnly={readOnly} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint ? <div className="b-hint">{hint}</div> : null}
    </div>
  );
}

export function NumberField({ label, value, onChange, readOnly, hint, min, testId }: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  readOnly?: boolean;
  hint?: ReactNode;
  min?: number;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="b-fld">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        data-testid={testId}
        type="number"
        min={min ?? 0}
        readOnly={readOnly}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
      {hint ? <div className="b-hint">{hint}</div> : null}
    </div>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange, readOnly, hint, testId }: {
  label: string;
  value: T | undefined;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  readOnly?: boolean;
  hint?: ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="b-fld">
      <label htmlFor={id}>{label}</label>
      <select id={id} data-testid={testId} value={value ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value as T)}>
        <option value="" disabled>Choose…</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint ? <div className="b-hint">{hint}</div> : null}
    </div>
  );
}

/**
 * A list of short strings (aliases, capabilities, skills, gate topics): each is a chip that can be taken away, plus a box that adds
 * one. `normalise` cleans what was typed (a channel written `dev` becomes `#dev`), and a value the shape refuses is not added at all.
 */
export function ChipsField({ label, values, onChange, readOnly, placeholder, hint, valid, testId }: {
  label: string;
  values: readonly string[];
  onChange: (next: string[]) => void;
  readOnly?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  /** Whether one typed entry is acceptable (the schema's own rule); a refused entry is simply not added. */
  valid?: (entry: string) => boolean;
  testId?: string;
}) {
  const [entry, setEntry] = useState('');
  const add = (): void => {
    const value = entry.trim();
    if (value === '' || values.includes(value) || (valid && !valid(value))) return;
    onChange([...values, value]);
    setEntry('');
  };
  return (
    <div className="b-chips" data-testid={testId}>
      <div className="b-chips-lab">{label}</div>
      <div className="b-chips-list">
        {values.length === 0 ? <span className="b-chips-none">none</span> : null}
        {values.map((v) => (
          <span className="b-chip on" key={v}>
            {v}
            {readOnly ? null : <button type="button" className="b-chip-x" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>}
          </span>
        ))}
      </div>
      {readOnly ? null : (
        <div className="b-chips-add">
          <input
            aria-label={`Add ${label.toLowerCase()}`}
            placeholder={placeholder ?? 'Add…'}
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn s" onClick={add} disabled={entry.trim() === ''}>Add</button>
        </div>
      )}
      {hint ? <div className="b-hint">{hint}</div> : null}
    </div>
  );
}

/** A line with a switch: the prototype's `.row` + `.tog` shape. */
export function SwitchRow({ label, hint, checked, onChange, readOnly }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; readOnly?: boolean }) {
  return (
    <div className="b-rowline">
      <div className="b-lab">
        {label}
        {hint ? <div className="d">{hint}</div> : null}
      </div>
      <div className="b-val">
        <Toggle checked={checked} onChange={onChange} label={typeof label === 'string' ? label : 'Toggle'} disabled={readOnly} />
      </div>
    </div>
  );
}