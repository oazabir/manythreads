import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { Surface } from '../src/surfaces/Surface';
import { pressFailure } from '../src/surfaces/SurfaceMessage';
import { SurfaceActionsContext, type SurfaceActions } from '../src/surfaces/views';

// A button on a bot's screen (PLAN P9-04): drawn from its own props, pressable only when the page lets the viewer answer, and the only thing it can send is the
// name of a part and an event.

const SCREEN = ['root = Stack([title, go, stop])', 'title = Heading("Deploy staging?", 2)', 'go = Button("Deploy", "primary")', 'stop = Button("Cancel")', ''].join('\n');

const draw = (actions?: SurfaceActions, source = SCREEN): string => {
  const surface = createElement(Surface, { source, ended: true });
  return renderToStaticMarkup(actions ? createElement(SurfaceActionsContext.Provider, { value: actions }, surface) : surface);
};
const answerable: SurfaceActions = { send: () => Promise.resolve(), answered: new Set(), busy: false };

describe('a Button', () => {
  it('is drawn with its label and its part name, and primary only when asked', () => {
    const out = draw(answerable);
    expect(out).toContain('>Deploy<');
    expect(out).toContain('>Cancel<');
    expect(out).toContain('data-node="go"');
    expect(out).toContain('data-node="stop"');
    expect(out).toMatch(/class="btn s sf-button primary"[^>]*data-node="go"/);
    expect(out).toMatch(/class="btn s sf-button"[^>]*data-node="stop"/);
    expect(out).not.toContain('surface-rejection');
  });

  it('can be pressed when the viewer may answer', () => {
    expect(draw(answerable)).not.toContain('disabled');
  });

  it('cannot be pressed with no way to answer (a preview, a draft, a person who may not post)', () => {
    const out = draw();
    expect(out.split('disabled').length - 1).toBe(2);
    expect(draw({ ...answerable, send: null }).split('disabled').length - 1).toBe(2);
  });

  it('cannot be pressed again while an answer is on its way, and says which one was sent', () => {
    expect(draw({ ...answerable, busy: true }).split('disabled').length - 1).toBe(2);
    const out = draw({ ...answerable, answered: new Set(['go']) });
    expect(out).toContain('(sent)');
    expect(out.split('(sent)').length - 1).toBe(1);
    // the button that was pressed stays disabled for this version; the other can still be pressed
    expect(out.split('disabled').length - 1).toBe(1);
    expect(out).toContain('aria-pressed="true"');
  });

  it('draws the label as text, never as markup', () => {
    const out = draw(answerable, 'root = Button("<img src=x onerror=alert(1)>")\n');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('<img');
  });

  it('a label that is empty or too long is refused like any other part, and not drawn', () => {
    expect(draw(answerable, 'root = Button("")\n')).toContain('surface-rejection');
    expect(draw(answerable, `root = Button("${'x'.repeat(81)}")\n`)).toContain('surface-rejection');
    expect(draw(answerable, 'root = Button(7)\n')).toContain('surface-rejection');
  });
});

describe('what the person is told when an answer is refused', () => {
  const failure = (status: number, message = 'server words'): ApiError => new ApiError({ status, code: 'conflict', message });

  it('says a changed screen has changed, a full queue is full and a missing right is missing', () => {
    expect(pressFailure(failure(409))).toMatch(/just changed/);
    expect(pressFailure(failure(429))).toMatch(/waiting for the bot/);
    expect(pressFailure(failure(403))).toMatch(/cannot answer/);
  });
  it('shows the server\'s own sentence for anything else, and a plain one for a broken connection', () => {
    expect(pressFailure(failure(400, 'Button has no "click" event'))).toBe('Button has no "click" event');
    expect(pressFailure(new Error('boom'))).toBe('The answer could not be sent. Try again.');
  });
});
