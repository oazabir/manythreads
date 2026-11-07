import { useRef, useState, type ReactNode } from 'react';
import { useMenuKeys } from '../../shell/RowMenu';
import { DownIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';

/** One line of a small menu: the bot picker and the model menu. A line that cannot be chosen still explains itself. */
export type PopItem = { key: string; label: string; hint?: string; selected?: boolean; disabled?: boolean; reason?: string | null };

/**
 * A button that opens a short list to pick one from ("Brain ▾", "Smart ▾"). One tab stop; the arrows move inside the list, Esc and a press outside close it
 * and the focus goes back to the button.
 */
export function PopMenu({ label, ariaLabel, testId, items, onPick, up = false }: {
  label: ReactNode;
  ariaLabel: string;
  testId: string;
  items: readonly PopItem[];
  onPick: (key: string) => void;
  /** Open upwards (the model menu sits above the bottom of the screen). */
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (): void => {
    if (panel.current?.contains(document.activeElement)) button.current?.focus();
    setOpen(false);
  };
  useDismiss(open, close, box);
  const keys = useMenuKeys(open, panel, close);
  return (
    <div className="ch-pop" ref={box}>
      <button ref={button} type="button" className="ch-pop-btn" aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} data-testid={testId} onClick={() => setOpen((o) => !o)}>
        <span className="ch-pop-label">{label}</span>
        <DownIcon />
      </button>
      {open ? (
        <div className={`ch-pop-menu ${up ? 'up' : ''}`} role="menu" aria-label={ariaLabel} ref={panel} onKeyDown={keys} data-testid={`${testId}-menu`}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitemradio"
              aria-checked={it.selected === true}
              aria-disabled={it.disabled === true ? true : undefined}
              className={`ch-pop-item ${it.selected ? 'on' : ''} ${it.disabled ? 'off' : ''}`}
              data-testid={`${testId}-item`}
              data-key={it.key}
              title={it.disabled && it.reason ? it.reason : undefined}
              onClick={() => {
                if (it.disabled) return;
                close();
                onPick(it.key);
              }}
            >
              <span className="ch-pop-name">{it.label}</span>
              {it.disabled && it.reason ? <small className="ch-pop-hint">{it.reason}</small> : it.hint ? <small className="ch-pop-hint">{it.hint}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
