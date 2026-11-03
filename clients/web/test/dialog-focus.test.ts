import { describe, expect, it } from 'vitest';
import { initialFocusTarget } from '../src/components/Dialog';

// Where a dialog puts focus when it opens. A tall dialog on a phone must open showing its top: focus on the Close button in the footer scrolled it to the bottom.

type El = { name: string };
const root = (present: Record<string, El>): Pick<ParentNode, 'querySelector'> =>
  ({ querySelector: (sel: string) => present[sel] ?? null }) as unknown as Pick<ParentNode, 'querySelector'>;
const heading: El = { name: 'heading' };
const field: El = { name: 'field' };
const button: El = { name: 'button' };
const marked: El = { name: 'marked' };
const dialog = root({ '.dlg-title': heading, '[data-autofocus]': marked, 'input, textarea, select': field, button });

describe('initialFocusTarget', () => {
  it('starts at the heading when the dialog asks to start at the top, even when it has a field and buttons', () => {
    expect(initialFocusTarget(dialog, true)).toBe(heading);
  });
  it('keeps the usual order otherwise: marked element, first field, first button', () => {
    expect(initialFocusTarget(dialog, false)).toBe(marked);
    expect(initialFocusTarget(root({ 'input, textarea, select': field, button }), false)).toBe(field);
    expect(initialFocusTarget(root({ button }), false)).toBe(button);
  });
  it('is nothing for a dialog that is not there yet', () => {
    expect(initialFocusTarget(null, true)).toBeNull();
    expect(initialFocusTarget(root({}), false)).toBeNull();
  });
});
