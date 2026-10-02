import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: scrim, focus kept inside, Esc and a press on the scrim close it. Esc is taken in the capture phase and marked handled so the
 * right panel behind it stays open until the next press. Focus starts on `[data-autofocus]`, else the first field, else the first button.
 */
export function Dialog({ title, onClose, children, footer, testId, wide, sheet }: { title: string; onClose: () => void; children?: ReactNode; footer?: ReactNode; testId?: string; wide?: boolean; sheet?: boolean }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = box.current;
    const first = root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('input, textarea, select') ?? root?.querySelector<HTMLElement>('button');
    first?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      const head = items[0];
      const tail = items.at(-1);
      if (!head || !tail) return;
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="dlg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`dlg ${wide ? 'wide' : ''} ${sheet ? 'sheet' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
        <h2 className="dlg-title" id={titleId}>{title}</h2>
        <div className="dlg-body">{children}</div>
        {footer ? <div className="dlg-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
