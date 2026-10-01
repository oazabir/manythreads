import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { PASSWORD_MIN_LENGTH as PASSWORD_MIN } from '@manythreads/shared';

export function Brand({ name = 'manythreads', mark = 'm' }: { name?: string; mark?: string }) {
  return (
    <div className="brand">
      <span className="mark" aria-hidden="true">{mark}</span>
      <b>{name}</b>
    </div>
  );
}

/** Error text for a failed action. role="alert" so it is announced and testable. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert" role="alert">
      <span className="bang" aria-hidden="true">!</span>
      <span>{children}</span>
    </div>
  );
}

export function Notice({ children, tone = 'ok' }: { children: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`notice ${tone}`} role="status">
      {children}
    </div>
  );
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  label: string;
  hint?: ReactNode;
  suffix?: ReactNode;
};

/** A labelled input; the label is always a real <label for>. */
export function Field({ label, hint, suffix, className, ...input }: FieldProps) {
  const id = useId();
  return (
    <div className={`fld ${className ?? ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="fld-row">
        <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
        {suffix ? <span className="fld-suffix">{suffix}</span> : null}
      </div>
      {hint ? (
        <div id={`${id}-hint`} className="fld-hint">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/** Live rule hint for a new password: "12+ characters", ok once met, alert when started but short. */
export function passwordRule(value: string): { ok: boolean; started: boolean; text: string } {
  const n = value.length;
  const ok = n >= PASSWORD_MIN;
  return { ok, started: n > 0, text: ok ? `${n} characters` : `At least ${PASSWORD_MIN} characters (${n}/${PASSWORD_MIN})` };
}

export function PasswordField({ label = 'Password', value, onChange, autoComplete = 'new-password' }: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
}) {
  const rule = passwordRule(value);
  const tone = rule.ok ? 'ok' : rule.started ? 'bad' : '';
  return (
    <Field
      label={label}
      type="password"
      autoComplete={autoComplete}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={`${PASSWORD_MIN}+ characters`}
      suffix={rule.ok ? <span className="rule-ok">ok</span> : null}
      hint={
        <span className={`rule ${tone}`} aria-live="polite">
          {rule.text}
        </span>
      }
    />
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`tog ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} />
  );
}

export function Avatar({ name, kind = 'person' }: { name: string; kind?: 'person' | 'agent' | 'automation' }) {
  const words = name.split(/\s+/).filter(Boolean);
  // two words: first and last initial ("Omar Al Zabir" -> OZ); one word: first two letters ("Brain" -> BR)
  const initials = (words.length > 1 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0] ?? '').slice(0, 2)).toUpperCase();
  return (
    <span className={`av ${kind === 'agent' ? 'a' : kind === 'automation' ? 'r' : ''}`} aria-hidden="true">
      {initials}
    </span>
  );
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
/** Times are dynamic text: masked for visual comparison. */
export function Time({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <time dateTime={iso} data-vt-mask>
      {Number.isNaN(d.getTime()) ? iso : `${DATE_FMT.format(d)} UTC`}
    </time>
  );
}
