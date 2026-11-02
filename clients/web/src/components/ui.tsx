import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { PASSWORD_MIN_LENGTH as PASSWORD_MIN, avatarSrc } from '@manythreads/shared';

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
    <div className="alert" role="alert" data-landmark="alert">
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
  /** A problem sentence under the field: the input is marked invalid and points at it, so a screen reader reads it with the field. */
  error?: string | undefined;
};

/** A labelled input; the label is always a real <label for>. */
export function Field({ label, hint, suffix, className, error, ...input }: FieldProps) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`fld ${className ?? ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="fld-row">
        <input id={id} aria-describedby={described} aria-invalid={error ? true : undefined} {...input} />
        {suffix ? <span className="fld-suffix">{suffix}</span> : null}
      </div>
      {hint ? (
        <div id={`${id}-hint`} className="fld-hint">
          {hint}
        </div>
      ) : null}
      {error ? (
        <div id={`${id}-err`} className="fld-err" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** Live rule hint for a new password: "8+ characters", ok once met, alert when started but short. */
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

/** `busy` marks a switch whose change is being saved: it keeps keyboard focus (a disabled button loses it) and ignores clicks until the save ends. */
/** `locked` is for a switch that cannot be changed right now but must stay in the Tab order so its reason (named by `describedBy`) can be heard: it is `aria-disabled` and ignores clicks. */
export function Toggle({ checked, onChange, label, disabled, busy, locked, describedBy }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; busy?: boolean; locked?: boolean; describedBy?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      aria-disabled={locked || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      className={`tog ${checked ? 'on' : ''}`}
      onClick={() => {
        if (!busy && !locked) onChange(!checked);
      }}
    />
  );
}

/** The initials drawn when a person or bot has no picture: two words, first and last initial ("Omar Al Zabir" -> OZ); one word, its first two letters ("Brain" -> BR). */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0] ?? '').slice(0, 2)).toUpperCase();
}

/**
 * A person's or bot's picture (PLAN P14-23): the built-in picture or uploaded photo they chose (`avatar`: `preset:<id>` or `photo:<hash>`), else their
 * initials on a coloured disc. A picture that cannot be loaded falls back to the initials, so a broken frame is never drawn. `personId` is needed for a photo.
 */
export function Avatar({ name, kind = 'person', avatar, personId }: { name: string; kind?: 'person' | 'agent' | 'automation'; avatar?: string | null | undefined; personId?: string | null | undefined }) {
  const src = avatarSrc(avatar, personId);
  const [broken, setBroken] = useState<string | null>(null);
  const shape = kind === 'agent' ? 'a' : kind === 'automation' ? 'r' : '';
  if (src && broken !== src) {
    return (
      <span className={`av pic ${shape}`} aria-hidden="true" data-avatar={avatar}>
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(src)} />
      </span>
    );
  }
  return (
    <span className={`av ${shape}`} aria-hidden="true">
      {initialsOf(name)}
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
