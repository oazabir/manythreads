// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P36-09 (owner, 2026-11-24): a calmer composer. Every box shows three buttons, Attach, Voice message (where voice is allowed) and Send; the rest is in
// Attach's menu, which is drawn from one list (composerAttach.ts) and answers the keys of a menu. "Send later" there opens the times for the draft.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/channels/files', async (orig) => ({ ...(await orig<typeof import('../src/channels/files')>()), useFilesSupport: () => true }));
vi.mock('../src/channels/serverDraft', () => ({ readDraft: () => '', writeDraft: () => undefined, useServerDraft: () => () => undefined }));
vi.mock('../src/channels/useSlash', () => ({ useSlashWho: () => ({ bots: [] }), useSlashEnv: () => () => ({ channels: [] }) }));
vi.mock('../src/channels/customEmoji', () => ({ useCustomEmoji: () => ({ items: [] }) }));
vi.mock('../src/channels/mentionGroups', async (orig) => ({ ...(await orig<typeof import('../src/channels/mentionGroups')>()), useMentionGroups: () => [] }));
vi.mock('../src/channels/voice/support', async (orig) => ({ ...(await orig<typeof import('../src/channels/voice/support')>()), recorderSupported: () => true }));
vi.mock('../src/channels/draftPlaces', () => ({ placeDraft: () => undefined }));
vi.mock('../src/api/endpoints', async (orig) => ({ ...(await orig<typeof import('../src/api/endpoints')>()), sendTyping: () => Promise.resolve() }));

const { ATTACH_ENTRIES, attachItems } = await import('../src/channels/composerAttach');
const { AttachMenu } = await import('../src/channels/AttachMenu');
const { Composer } = await import('../src/channels/Composer');
const { setFormatBarShown } = await import('../src/channels/formatBar');
type AttachEnv = import('../src/channels/composerAttach').AttachEnv;

const env = (o: Partial<AttachEnv> = {}): AttachEnv => ({ files: true, capture: true, polls: true, sendLater: true, hasText: true, hasFiles: false, busy: false, formatShown: false, ...o });
const ids = (e: AttachEnv): string[] => attachItems(e).map((i) => i.entry.id);

describe('the Attach menu list', () => {
  it('offers, in order, a file, a screenshot, a screen recording, a poll, emoji, Send later and the formatting bar in a channel', () => {
    expect(ids(env())).toEqual(['file', 'screenshot', 'recording', 'poll', 'emoji', 'send-later', 'format']);
  });
  it('has one id and one test id per entry, so a new item is one more entry', () => {
    expect(new Set(ATTACH_ENTRIES.map((e) => e.id)).size).toBe(ATTACH_ENTRIES.length);
    expect(new Set(ATTACH_ENTRIES.map((e) => e.testId)).size).toBe(ATTACH_ENTRIES.length);
    // the old test ids live on as menu items
    expect(ATTACH_ENTRIES.map((e) => e.testId)).toEqual(expect.arrayContaining(['send-later', 'poll-tool', 'capture-image', 'capture-video', 'composer-format-toggle']));
  });
  it('drops what a box cannot do: Brain chat has no poll and no Send later, a guest or a browser without screen sharing no capture, a server without files no file', () => {
    expect(ids(env({ polls: false, sendLater: false }))).toEqual(['file', 'screenshot', 'recording', 'emoji', 'format']);
    expect(ids(env({ capture: false }))).toEqual(['file', 'poll', 'emoji', 'send-later', 'format']);
    expect(ids(env({ files: false }))).toEqual(['poll', 'emoji', 'send-later', 'format']);
  });
  it('keeps Send later in the menu but says why it cannot be used: an empty box, files, a schedule on its way', () => {
    const later = (e: AttachEnv) => attachItems(e).find((i) => i.entry.id === 'send-later');
    expect(later(env())?.blocked).toBeNull();
    expect(later(env({ hasText: false }))?.blocked).toBe('Write a message first');
    expect(later(env({ hasFiles: true }))?.hint).toBe('A scheduled message holds text only');
    expect(later(env({ busy: true }))?.blocked).not.toBeNull();
  });
  it('names the formatting item after what it will do', () => {
    const fmt = (e: AttachEnv) => attachItems(e).find((i) => i.entry.id === 'format')?.label;
    expect(fmt(env())).toBe('Show formatting');
    expect(fmt(env({ formatShown: true }))).toBe('Hide formatting');
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFormatBarShown(false);
});
const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no ${id}`);
  return el;
};
const key = (el: Element, k: string): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
};
const click = (el: Element): void => {
  act(() => {
    (el as HTMLElement).click();
  });
};

describe('AttachMenu', () => {
  const chosen: string[] = [];
  const mount = (e: AttachEnv = env()): void => {
    chosen.length = 0;
    const ref = { current: null as HTMLButtonElement | null };
    act(() => root.render(createElement(AttachMenu, { items: attachItems(e), onChoose: (it) => chosen.push(it.entry.id), buttonRef: ref })));
  };
  it('opens on the button with the focus on its first item; the arrows, Home and End move it; Esc closes it and gives the focus back', () => {
    mount();
    const button = must('composer-attach');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = must('composer-attach-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(items.map((i) => i.getAttribute('data-testid'))).toEqual(['attach-file', 'capture-image', 'capture-video', 'poll-tool', 'attach-emoji', 'send-later', 'composer-format-toggle']);
    expect(document.activeElement).toBe(items[0]);
    key(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key(document.activeElement as Element, 'ArrowUp');
    key(document.activeElement as Element, 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(document.activeElement as Element, 'Home');
    expect(document.activeElement).toBe(items[0]);
    key(document.activeElement as Element, 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(document.activeElement as Element, 'Escape');
    expect(q('composer-attach-menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
  it('runs the item chosen and closes; an item that cannot be used says why and stays open', () => {
    mount(env({ hasText: false }));
    click(must('composer-attach'));
    const later = must('send-later');
    expect(later.getAttribute('aria-disabled')).toBe('true');
    expect(later.textContent).toContain('Write a message first');
    click(later);
    expect(chosen).toEqual([]);
    expect(q('composer-attach-menu')).not.toBeNull();
    click(must('poll-tool'));
    expect(chosen).toEqual(['poll']);
    expect(q('composer-attach-menu')).toBeNull();
  });
  it('closes on Tab and on a second press of the button', () => {
    mount();
    click(must('composer-attach'));
    key(document.activeElement as Element, 'Tab');
    expect(q('composer-attach-menu')).toBeNull();
    click(must('composer-attach'));
    expect(q('composer-attach-menu')).not.toBeNull();
    click(must('composer-attach'));
    expect(q('composer-attach-menu')).toBeNull();
  });
});

describe('Composer: three buttons in every box', () => {
  const people = { list: [], bots: [], me: null } as never;
  const base = { draftKey: 'k', placeholder: 'Message', label: 'Message #dev', channelId: 'c1', people, channelNames: [], onSend: () => undefined };
  const kinds = {
    channel: { ...base, threadRootId: null, slash: { teamSlug: 't', origin: '#dev' }, sendLater: true },
    thread: { ...base, threadRootId: 'r1', slash: { teamSlug: 't', origin: 'a thread in #dev' }, sendLater: true },
    dm: { ...base, threadRootId: null, slash: { teamSlug: 't', origin: 'a direct message' }, sendLater: true },
    brain: { ...base, threadRootId: null, voice: false, commands: [] },
    bot: { ...base, threadRootId: null, voice: false },
  } as const;
  const draw = (props: (typeof kinds)[keyof typeof kinds]): void => {
    act(() => root.render(createElement(MemoryRouter, null, createElement(Composer, props))));
  };
  // what a person sees in the box: buttons not hidden by an attribute on them or on a wrapper
  const visibleButtons = (): string[] =>
    [...host.querySelectorAll<HTMLElement>('.cbox button')].filter((b) => !b.closest('[hidden]')).map((b) => b.getAttribute('data-testid') ?? b.getAttribute('aria-label') ?? '?');

  for (const [kind, props] of Object.entries(kinds)) {
    it(`${kind}: ${'voice' in props ? 'Attach and Send' : 'Attach, Voice message and Send'}, and no formatting bar until it is asked for`, () => {
      draw(props);
      expect(visibleButtons()).toEqual('voice' in props ? ['composer-attach', 'send'] : ['composer-attach', 'voice-mic', 'send']);
      expect(q('composer-tools')).toBeNull();
    });
  }

  it('Show formatting draws the bar (without the poll, which is in the menu) and Hide formatting takes it away', () => {
    draw(kinds.channel);
    click(must('composer-attach'));
    click(must('composer-format-toggle'));
    const bar = must('composer-tools');
    expect(bar.getAttribute('data-layout')).toBe('full');
    expect(bar.querySelector('[aria-label="Bold"]')).not.toBeNull();
    expect(bar.querySelector('[aria-label="Ask a poll"]')).toBeNull();
    click(must('composer-attach'));
    expect(must('composer-format-toggle').textContent).toContain('Hide formatting');
    click(must('composer-format-toggle'));
    expect(q('composer-tools')).toBeNull();
  });

  it('Send later in the menu opens the times for the draft; Esc closes them and the focus goes back to Attach', () => {
    draw(kinds.channel);
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      set?.call(box, 'see you tomorrow');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(must('composer-attach'));
    expect(must('send-later').getAttribute('aria-disabled')).toBeNull();
    click(must('send-later'));
    expect(q('composer-attach-menu')).toBeNull();
    const times = must('send-later-menu');
    expect(times.querySelector('[data-testid="send-later-custom"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
    key(document.activeElement as Element, 'Escape');
    expect(q('send-later-menu')).toBeNull();
    expect(document.activeElement).toBe(must('composer-attach'));
  });

  it('Send later is not offered in Brain chat', () => {
    draw(kinds.brain);
    click(must('composer-attach'));
    expect(q('send-later')).toBeNull();
    expect(q('poll-tool')).toBeNull();
  });
});
