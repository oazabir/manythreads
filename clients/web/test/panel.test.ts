import { describe, expect, it } from 'vitest';
import { createPanelController } from '../src/kernel/panel/controller';
import { createPanelRegistry } from '../src/kernel/panel/registry';
import {
  MAX_STACK,
  formatEntry,
  parseEntry,
  readPanel,
  writePanel,
  type PanelEntry,
  type PanelHistory,
  type PanelLocation,
} from '../src/kernel/panel/stack';

/** A browser history in memory: a list of locations and a cursor, like the real one. Back moves the cursor. */
function memoryHistory(start: PanelLocation = { search: '', state: null }): PanelHistory & { entries: PanelLocation[]; index: number; url(): string } {
  const h = {
    entries: [start],
    index: 0,
    read: () => h.entries[h.index]!,
    push(next: PanelLocation) {
      h.entries = [...h.entries.slice(0, h.index + 1), next];
      h.index += 1;
    },
    replace(next: PanelLocation) {
      h.entries[h.index] = next;
    },
    back() {
      h.index = Math.max(0, h.index - 1);
    },
    url: () => h.entries[h.index]!.search,
  };
  return h;
}

const thread = (id: string): PanelEntry => ({ type: 'thread', id });
const file = (id: string): PanelEntry => ({ type: 'file', id });
const member = (id: string): PanelEntry => ({ type: 'member', id });

describe('panel entries in the URL', () => {
  it('formats and parses type:id, keeping colons in the id', () => {
    expect(formatEntry(thread('abc'))).toBe('thread:abc');
    expect(parseEntry('thread:abc')).toEqual(thread('abc'));
    expect(parseEntry('file:docs/a:b.md')).toEqual(file('docs/a:b.md'));
  });
  it('rejects anything that is not type:id', () => {
    for (const bad of [null, undefined, '', 'thread', ':abc', 'Thread:abc', 'thread:', '9x:abc', `thread:${'x'.repeat(301)}`]) {
      expect(parseEntry(bad), String(bad)).toBeNull();
    }
  });
});

describe('reading and writing the panel in a location', () => {
  it('a link with only ?panel= restores that entry as the whole stack', () => {
    expect(readPanel({ search: '?panel=thread:abc', state: null })).toEqual({ stack: [thread('abc')], viaPush: false });
  });
  it('no panel parameter is a closed panel, even if stale state is left over', () => {
    expect(readPanel({ search: '', state: { panel: { stack: ['thread:a'], viaPush: true } } }).stack).toEqual([]);
  });
  it('state that disagrees with the URL is ignored in favour of the URL', () => {
    const loc = { search: '?panel=thread:b', state: { panel: { stack: ['thread:a'], viaPush: true } } };
    expect(readPanel(loc)).toEqual({ stack: [thread('b')], viaPush: false });
  });
  it('writes the top entry to the URL, keeps other parameters and other state, and clears on close', () => {
    const opened = writePanel({ search: '?x=1', state: { keep: true } }, [thread('a'), file('f')], true);
    expect(opened.search).toBe('?x=1&panel=file%3Af');
    expect(opened.state).toEqual({ keep: true, panel: { stack: ['thread:a', 'file:f'], viaPush: true } });
    expect(readPanel(opened).stack).toEqual([thread('a'), file('f')]);
    const closed = writePanel(opened, [], false);
    expect(closed).toEqual({ search: '?x=1', state: { keep: true } });
    expect(writePanel({ search: '?panel=thread:a', state: null }, [], false)).toEqual({ search: '', state: null });
  });
  it('keeps at most MAX_STACK entries, newest last', () => {
    const many = Array.from({ length: MAX_STACK + 5 }, (_, i) => thread(String(i)));
    const loc = writePanel({ search: '', state: null }, many, true);
    const { stack } = readPanel(loc);
    expect(stack).toHaveLength(MAX_STACK);
    expect(stack.at(-1)).toEqual(thread(String(MAX_STACK + 4)));
  });
});

describe('panel push, back, close', () => {
  it('push opens the entry and puts it in the URL', () => {
    const h = memoryHistory();
    const panel = createPanelController(h);
    expect(panel.top()).toBeNull();
    panel.push(thread('a'));
    expect(panel.top()).toEqual(thread('a'));
    expect(h.url()).toBe('?panel=thread%3Aa');
    expect(panel.canGoBack()).toBe(false);
  });

  it('three pushes then Back twice shows the first entry, with the URL following (PLAN criterion 2)', () => {
    const h = memoryHistory();
    const panel = createPanelController(h);
    panel.push(thread('first'));
    panel.push(file('second'));
    panel.push(member('third'));
    expect(panel.stack()).toEqual([thread('first'), file('second'), member('third')]);
    expect(h.url()).toBe('?panel=member%3Athird');

    panel.back();
    expect(panel.top()).toEqual(file('second'));
    expect(h.url()).toBe('?panel=file%3Asecond');
    panel.back();
    expect(panel.top()).toEqual(thread('first'));
    expect(panel.stack()).toEqual([thread('first')]);
    expect(h.url()).toBe('?panel=thread%3Afirst');
    expect(panel.canGoBack()).toBe(false);
  });

  it('pushing the entry already on top changes nothing', () => {
    const h = memoryHistory();
    const panel = createPanelController(h);
    panel.push(thread('a'));
    const before = h.entries.length;
    panel.push(thread('a'));
    expect(h.entries).toHaveLength(before);
  });

  it('Back on the only entry closes the panel', () => {
    const h = memoryHistory();
    const panel = createPanelController(h);
    panel.push(thread('a'));
    panel.back();
    expect(panel.stack()).toEqual([]);
    expect(h.url()).toBe('');
  });

  it('close removes the whole stack from the URL; the browser Back reopens it as it was', () => {
    const h = memoryHistory({ search: '?other=1', state: null });
    const panel = createPanelController(h);
    panel.push(thread('a'));
    panel.push(file('b'));
    panel.close();
    expect(panel.stack()).toEqual([]);
    expect(h.url()).toBe('?other=1');
    h.back(); // the browser's Back button
    expect(panel.stack()).toEqual([thread('a'), file('b')]);
  });

  it('close on a closed panel does nothing', () => {
    const h = memoryHistory();
    createPanelController(h).close();
    expect(h.entries).toHaveLength(1);
  });

  it('the browser Back button walks the same stack as panel.back()', () => {
    const h = memoryHistory();
    const panel = createPanelController(h);
    panel.push(thread('a'));
    panel.push(file('b'));
    h.back();
    expect(panel.stack()).toEqual([thread('a')]);
  });

  it('a deep link has one entry; pushing from it and going back lands on it', () => {
    const h = memoryHistory({ search: '?panel=thread:deep', state: null });
    const panel = createPanelController(h);
    expect(panel.stack()).toEqual([thread('deep')]);
    panel.push(file('x'));
    expect(panel.canGoBack()).toBe(true);
    panel.back();
    expect(panel.stack()).toEqual([thread('deep')]);
    expect(h.url()).toBe('?panel=thread:deep');
  });

  it('after a reload the stack comes back from the history entry (state survives, controller does not)', () => {
    const h = memoryHistory();
    createPanelController(h).push(thread('a'));
    createPanelController(h).push(file('b')); // a new controller, as after a reload
    const reloaded = createPanelController(h);
    expect(reloaded.stack()).toEqual([thread('a'), file('b')]);
    reloaded.back();
    expect(reloaded.top()).toEqual(thread('a'));
  });

  it('Back on a stack that did not come from pushes rewrites the entry instead of leaving the page', () => {
    // the entry before this one belongs to another page: Back must not use the browser
    const h = memoryHistory();
    h.push({ search: '?panel=file:b', state: { panel: { stack: ['thread:a', 'file:b'], viaPush: false } } });
    const panel = createPanelController(h);
    panel.back();
    expect(h.index).toBe(1);
    expect(panel.stack()).toEqual([thread('a')]);
  });
});

describe('panel type registry', () => {
  const Component = () => null;
  it('registers types and looks them up; a later registration replaces the earlier', () => {
    const r = createPanelRegistry();
    r.register({ type: 'thread', label: 'Thread', Component });
    r.register({ type: 'file', label: 'File', Component });
    expect(r.types()).toEqual(['thread', 'file']);
    expect(r.get('thread')?.label).toBe('Thread');
    r.register({ type: 'thread', label: 'Thread v2', Component });
    expect(r.get('thread')?.label).toBe('Thread v2');
    expect(r.get('nope')).toBeUndefined();
  });
});
