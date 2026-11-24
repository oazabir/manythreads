// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P36-09 (owner, 2026-11-24): a calmer composer. Every box shows three buttons, Attach, Voice message (where voice is allowed) and Send; the rest is in
// Attach's menu, which is drawn from one list (composerAttach.ts) and answers the keys of a menu. "Send later" there opens the times for the draft.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flags = vi.hoisted(() => ({ files: true }));
vi.mock('../src/channels/files', async (orig) => ({ ...(await orig<typeof import('../src/channels/files')>()), useFilesSupport: () => flags.files }));
vi.mock('../src/channels/serverDraft', () => ({ readDraft: () => '', writeDraft: () => undefined, useServerDraft: () => () => undefined }));
vi.mock('../src/channels/useSlash', () => ({ useSlashWho: () => ({ bots: [] }), useSlashEnv: () => () => ({ channels: [] }) }));
vi.mock('../src/channels/customEmoji', () => ({ useCustomEmoji: () => ({ items: [] }) }));
vi.mock('../src/channels/mentionGroups', async (orig) => ({ ...(await orig<typeof import('../src/channels/mentionGroups')>()), useMentionGroups: () => [] }));
vi.mock('../src/channels/voice/support', async (orig) => ({ ...(await orig<typeof import('../src/channels/voice/support')>()), recorderSupported: () => true }));
vi.mock('../src/channels/draftPlaces', () => ({ placeDraft: () => undefined }));
vi.mock('../src/api/endpoints', async (orig) => ({ ...(await orig<typeof import('../src/api/endpoints')>()), sendTyping: () => Promise.resolve() }));

const { ATTACH_ENTRIES, attachButtonWords, attachItems } = await import('../src/channels/composerAttach');
const { useCapture } = await import('../src/channels/capture/useCapture');
const { AttachMenu } = await import('../src/channels/AttachMenu');
const { Composer } = await import('../src/channels/Composer');
const { formatBarShown, setFormatBarShown } = await import('../src/channels/formatBar');
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
  it('names the button after what the menu holds: Attach when something can be attached, More when it cannot (no file storage, no poll)', () => {
    expect(attachButtonWords(attachItems(env()))).toEqual({ label: 'Attach', title: 'Attach a file, a screenshot, a screen recording and a poll, and more' });
    expect(attachButtonWords(attachItems(env({ files: false })))).toEqual({ label: 'Attach', title: 'Attach a poll, and more' });
    expect(attachButtonWords(attachItems(env({ files: false, polls: false })))).toEqual({ label: 'More', title: 'More: emoji, Send later and formatting' });
    expect(attachButtonWords(attachItems(env({ files: false, polls: false, sendLater: false })))).toEqual({ label: 'More', title: 'More: emoji and formatting' });
  });
  it('marks Send later as expanded, pointing at the times, while they are open', () => {
    const later = (e: AttachEnv) => attachItems(e).find((i) => i.entry.id === 'send-later');
    expect(later(env({ laterMenuId: 'times' }))).toMatchObject({ expanded: false });
    expect(later(env({ laterMenuId: 'times' }))?.controls).toBeUndefined();
    expect(later(env({ laterOpen: true, laterMenuId: 'times' }))).toMatchObject({ expanded: true, controls: 'times' });
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
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as unknown as typeof window.requestAnimationFrame;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFormatBarShown(false);
  flags.files = true;
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
  it('gives the focus back to the button after an item that opens a picker of its own, so a cancelled file or screen picker leaves it there', () => {
    mount();
    click(must('composer-attach'));
    click(must('attach-file'));
    expect(chosen).toEqual(['file']);
    expect(document.activeElement).toBe(must('composer-attach'));
    click(must('composer-attach'));
    click(must('capture-image'));
    expect(document.activeElement).toBe(must('composer-attach'));
  });
  it('is "More" with a plus when nothing can be attached here', () => {
    mount(env({ files: false, polls: false }));
    const button = must('composer-attach');
    expect(button.getAttribute('aria-label')).toBe('More');
    expect(button.getAttribute('data-kind')).toBe('more');
    expect(button.getAttribute('title')).toBe('More: emoji, Send later and formatting');
    click(button);
    expect(must('composer-attach-menu').getAttribute('aria-label')).toBe('More');
    expect(q('attach-file')).toBeNull();
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
  const draw = (props: import('../src/channels/Composer').ComposerProps): void => {
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

  it('while the times are open, Attach says it is expanded and controls them; they close and stay closed when the box stops offering Send later', () => {
    draw(kinds.channel);
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, 'later please');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(must('composer-attach'));
    click(must('send-later'));
    const times = must('send-later-menu');
    const attach = must('composer-attach');
    expect(attach.getAttribute('aria-expanded')).toBe('true');
    expect(attach.getAttribute('aria-controls')).toBe(times.id);
    draw({ ...kinds.channel, sendLater: false });
    expect(q('send-later-menu')).toBeNull();
    draw(kinds.channel);
    expect(q('send-later-menu')).toBeNull();
    expect(must('composer-attach').getAttribute('aria-expanded')).toBe('false');
  });

  it('a box on a server without file storage offers no file: its button is "More"', () => {
    flags.files = false;
    draw(kinds.brain);
    expect(must('composer-attach').getAttribute('aria-label')).toBe('More');
    click(must('composer-attach'));
    expect(q('attach-file')).toBeNull();
  });

  it('follows the formatting choice made in another tab', () => {
    draw(kinds.channel);
    expect(q('composer-tools')).toBeNull();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'manythreads.composer.formatBar', newValue: 'shown' }));
    });
    expect(formatBarShown()).toBe(true);
    expect(q('composer-tools')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'manythreads.composer.formatBar', newValue: null }));
    });
    expect(q('composer-tools')).toBeNull();
  });

  it('Send later is not offered in Brain chat', () => {
    draw(kinds.brain);
    click(must('composer-attach'));
    expect(q('send-later')).toBeNull();
    expect(q('poll-tool')).toBeNull();
  });
});

describe('the screen-sharing note', () => {
  it('is a plain note with its own close button: Esc is left to the box and the panels behind it', async () => {
    const getDisplayMedia = vi.fn(() => Promise.reject(Object.assign(new Error('busy'), { name: 'NotReadableError' })));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
    function Harness() {
      const cap = useCapture(() => undefined);
      return createElement('div', null, createElement('button', { type: 'button', 'data-testid': 'go', onClick: () => cap.start('image') }), cap.view);
    }
    act(() => root.render(createElement(Harness)));
    click(must('go'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(must('capture-problem').getAttribute('role')).toBe('alert');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(false);
    expect(q('capture-problem')).not.toBeNull();
    click(must('capture-problem-close'));
    expect(q('capture-problem')).toBeNull();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });
});
