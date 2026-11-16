// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ThreadFileItem, ThreadTodo, TodoItem } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentKey, earlierLabel, forgetRailOpen, listStage, planOutputs, readRailOpen, timelineOf, typeLabel, writeRailOpen } from '../src/taskview/railRules';

// P29-20: the thread's side rail. The rules (stage, timeline folding, which files are previews), then the rail drawn: the current step, the folded earlier steps, "No to-do list in this
// thread", the Outputs with two picture previews and a compact list, and what is remembered per person.

const files = vi.fn();
vi.mock('../src/taskview/api', () => ({ fetchThreadFiles: (...a: unknown[]) => files(...a) }));
const { ThreadRail } = await import('../src/taskview/ThreadRail');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-16T10:00:00.000Z';
const step = (n: number, status: TodoItem['status'], text = `Step ${n}`): TodoItem => ({ id: `i${n}`, text, status }) as unknown as TodoItem;
const todo = (items: TodoItem[]): ThreadTodo => ({ rootId: ID(1), title: 'Ship the fix', version: 1, updatedAt: AT, botActorId: ID(8), items }) as unknown as ThreadTodo;
const file = (n: number, name: string, mime: string, size = 2048): ThreadFileItem =>
  ({ file: { id: ID(100 + n), name, mime, size }, messageId: ID(200 + n), at: AT, authorId: ID(9), authorName: 'Rafi', authorKind: 'person' }) as unknown as ThreadFileItem;

describe('the stage of the list', () => {
  it('is not started, in progress, waiting or all done', () => {
    expect(listStage([])).toMatchObject({ stage: 'none', count: null });
    expect(listStage([step(1, 'waiting'), step(2, 'waiting')])).toMatchObject({ stage: 'not-started', label: 'Not started', count: '0 of 2 done', pct: 0 });
    expect(listStage([step(1, 'done'), step(2, 'working'), step(3, 'waiting')])).toMatchObject({ stage: 'working', label: 'In progress', count: '1 of 3 done', pct: 33 });
    expect(listStage([step(1, 'done'), step(2, 'waiting')])).toMatchObject({ stage: 'working' });
    expect(listStage([step(1, 'done'), step(2, 'blocked')])).toMatchObject({ stage: 'blocked', label: 'Waiting' });
    expect(listStage([step(1, 'done'), step(2, 'done')])).toMatchObject({ stage: 'done', label: 'All done', pct: 100 });
  });
});

describe('the timeline', () => {
  it('folds the finished steps before the first open one into "N earlier steps"', () => {
    const t = timelineOf([step(1, 'done'), step(2, 'done'), step(3, 'done'), step(4, 'working'), step(5, 'waiting')]);
    expect(t.earlier.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
    expect(t.steps.map((i) => i.id)).toEqual(['i4', 'i5']);
    expect(t.current?.id).toBe('i4');
    expect(earlierLabel(3)).toBe('3 earlier steps');
    expect(earlierLabel(1)).toBe('1 earlier step');
  });

  it('keeps a single finished step as itself, and a finished list whole', () => {
    expect(timelineOf([step(1, 'done'), step(2, 'working')]).earlier).toEqual([]);
    const all = timelineOf([step(1, 'done'), step(2, 'done')]);
    expect(all.earlier).toEqual([]);
    expect(all.steps).toHaveLength(2);
    expect(all.current).toBeNull();
  });

  it('points at a blocked step when nothing is being worked on', () => {
    expect(timelineOf([step(1, 'done'), step(2, 'blocked'), step(3, 'waiting')]).current?.id).toBe('i2');
  });
});

describe('the Outputs plan', () => {
  const list = [file(1, 'after.png', 'image/png'), file(2, 'report.pdf', 'application/pdf'), file(3, 'before.png', 'image/png'), file(4, 'older.jpg', 'image/jpeg'), file(5, 'notes.md', 'text/markdown')];

  it('previews the two newest pictures and lists everything else, older pictures included', () => {
    const p = planOutputs(list, 5, false);
    expect(p.previews.map((i) => i.file.name)).toEqual(['after.png', 'before.png']);
    expect(p.list.map((i) => i.file.name)).toEqual(['report.pdf', 'older.jpg', 'notes.md']);
    expect(p.more).toBe(0);
  });

  it('cuts the list at the cap and says how many more there are', () => {
    const many = Array.from({ length: 30 }, (_, n) => file(n, `f${n}.pdf`, 'application/pdf'));
    const p = planOutputs(many, 45, false);
    expect(p.list).toHaveLength(20);
    expect(p.more).toBe(25);
    expect(planOutputs(many, 30, true).more).toBe(0);
  });

  it('shows no preview for an SVG or a file that is not a picture', () => {
    expect(planOutputs([file(1, 'logo.svg', 'image/svg+xml'), file(2, 'a.zip', 'application/zip')], 2, false).previews).toEqual([]);
  });

  it('names a type in words', () => {
    expect(typeLabel({ name: 'a.pdf', mime: 'application/pdf' })).toBe('PDF');
    expect(typeLabel({ name: 'a.png', mime: 'image/png' })).toBe('Image');
    expect(typeLabel({ name: 'a.md', mime: 'text/markdown' })).toBe('Markdown');
    expect(typeLabel({ name: 'a.bin', mime: 'application/octet-stream' })).toBe('File');
  });

  it('keys the read on the messages that carry files', () => {
    const a = { id: 'm1', attachments: [{}] };
    expect(attachmentKey([a, { id: 'm2', attachments: [] }])).toBe('m1:1');
    expect(attachmentKey([a, { id: 'm3', attachments: [{}, {}] }])).not.toBe(attachmentKey([a]));
    expect(attachmentKey([{ id: 'm1', attachments: [{}], deletedAt: AT }])).toBe('');
  });
});

describe('what the rail remembers', () => {
  beforeEach(() => forgetRailOpen());
  afterEach(() => {
    forgetRailOpen();
    localStorage.clear();
  });

  it('is nothing until the person chooses, then open or closed', () => {
    expect(readRailOpen()).toBeNull();
    writeRailOpen(true);
    expect(readRailOpen()).toBe(true);
    forgetRailOpen();
    expect(readRailOpen()).toBe(true); // from the browser's storage
    writeRailOpen(false);
    forgetRailOpen();
    expect(readRailOpen()).toBe(false);
  });

  it('still answers when the storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readRailOpen()).toBeNull();
    writeRailOpen(true);
    expect(readRailOpen()).toBe(true);
    get.mockRestore();
    set.mockRestore();
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  files.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const q = (sel: string) => host.querySelector(sel);
const qa = (sel: string) => [...host.querySelectorAll(sel)];
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};
const draw = async (over: Record<string, unknown> = {}): Promise<void> => {
  await act(async () => {
    root.render(createElement(ThreadRail, { rootId: ID(1), id: 'rail', open: true, onClose: vi.fn(), todo: null, run: null, approvals: [], fileKey: '', ownerName: () => undefined, ...over }));
  });
  await settle();
};

describe('the rail', () => {
  it('is a labelled complementary landmark, and draws nothing while closed', async () => {
    files.mockResolvedValue({ items: [], total: 0 });
    await draw();
    const aside = q('aside');
    expect(aside?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(host.querySelector(`#${aside?.getAttribute('aria-labelledby')}`)?.textContent).toBe('Thread overview');
    await draw({ open: false });
    expect(q('aside')).toBeNull();
  });

  it('says there is no to-do list, and no files, when there are none', async () => {
    files.mockResolvedValue({ items: [], total: 0 });
    await draw();
    expect(q('[data-testid="rail-no-todo"]')?.textContent).toBe('No to-do list in this thread');
    expect(q('[data-testid="rail-no-files"]')).not.toBeNull();
  });

  it('draws the list as a timeline: the earlier steps folded, the current step marked with its stage and the run line, the rest after it', async () => {
    files.mockResolvedValue({ items: [], total: 0 });
    const run = { runId: ID(50), botName: 'Engineer', state: 'working', now: { kind: 'execute', title: 'pnpm lint', paths: [], helper: null, count: 1 } };
    await draw({ todo: todo([step(1, 'done'), step(2, 'done'), step(3, 'working', 'Run the linter'), step(4, 'waiting')]), run });
    expect(q('[data-testid="rail-count"]')?.textContent).toBe('2 of 4 done');
    expect(q('.trChip')?.textContent).toBe('In progress');
    expect(q('[data-testid="rail-earlier"]')?.textContent).toBe('2 earlier steps');
    expect(q('[data-testid="rail-earlier-list"]')).toBeNull();
    const steps = qa('[data-testid="rail-step"]');
    expect(steps.map((s) => s.getAttribute('data-status'))).toEqual(['working', 'waiting']);
    const current = steps[0]!;
    expect(current.getAttribute('data-current')).toBe('true');
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.querySelector('[data-testid="rail-stage"]')?.textContent).toContain('Working on it');
    expect(current.querySelector('[data-testid="rail-substep"]')?.textContent).toMatch(/linter|lint|Running/i);
    await act(async () => (q('[data-testid="rail-earlier"]') as HTMLButtonElement).click());
    expect(q('[data-testid="rail-earlier-list"]')?.querySelectorAll('[data-testid="rail-step"]')).toHaveLength(2);
    expect(q('[data-testid="rail-earlier"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('marks a blocked step and links it to the approval when one is pending', async () => {
    files.mockResolvedValue({ items: [], total: 0 });
    await draw({ todo: todo([step(1, 'done'), step(2, 'blocked', 'Deploy')]), approvals: [{ id: ID(70), status: 'pending' }] });
    expect(q('.trChip')?.textContent).toBe('Waiting');
    expect(q('[data-testid="rail-approval-link"]')?.textContent).toBe('Waiting for an approval');
    await draw({ todo: todo([step(1, 'done'), step(2, 'blocked', 'Deploy')]), approvals: [] });
    expect(q('[data-testid="rail-approval-link"]')).toBeNull();
    expect(q('[data-testid="rail-blocked"]')?.textContent).toBe('Blocked');
  });

  it('shows the two newest pictures as lazy previews with the file name as the alt text, and the other files as a compact list', async () => {
    files.mockResolvedValue({
      total: 4,
      items: [file(1, 'after.png', 'image/png'), file(2, 'report.pdf', 'application/pdf', 3 * 1024 * 1024), file(3, 'before.png', 'image/png'), file(4, 'third.png', 'image/png')],
    });
    await draw();
    const imgs = qa('[data-testid="rail-preview"] img');
    expect(imgs.map((i) => i.getAttribute('alt'))).toEqual(['after.png', 'before.png']);
    expect(imgs.every((i) => i.getAttribute('loading') === 'lazy')).toBe(true);
    const rows = qa('[data-testid="rail-file"]');
    expect(rows.map((r) => r.querySelector('.trFileName')?.textContent)).toEqual(['report.pdf', 'third.png']);
    expect(rows[0]?.textContent).toContain('PDF · 3.0 MB');
    expect(rows[0]?.tagName).toBe('A'); // a file that is not a picture downloads, as it does in the thread
    expect(files).toHaveBeenCalledTimes(1);
  });

  it('opens a preview in the viewer', async () => {
    files.mockResolvedValue({ total: 1, items: [file(1, 'after.png', 'image/png')] });
    await draw();
    await act(async () => (q('[data-testid="rail-preview"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="image-lightbox"] img')?.getAttribute('alt')).toBe('after.png');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('[data-testid="image-lightbox"]')).toBeNull();
  });

  it('reads the files again when a message with a file appears, and keeps the old list on screen meanwhile', async () => {
    files.mockResolvedValueOnce({ total: 1, items: [file(1, 'after.png', 'image/png')] });
    await draw({ fileKey: 'm1:1' });
    expect(qa('[data-testid="rail-preview"]')).toHaveLength(1);
    files.mockResolvedValueOnce({ total: 2, items: [file(2, 'second.png', 'image/png'), file(1, 'after.png', 'image/png')] });
    await draw({ fileKey: 'm1:1,m2:1' });
    expect(files).toHaveBeenCalledTimes(2);
    expect(qa('[data-testid="rail-preview"]')).toHaveLength(2);
  });

  it('offers "Show all files" when the list is cut', async () => {
    files.mockResolvedValue({ total: 60, items: Array.from({ length: 22 }, (_, n) => file(n, `f${n}.pdf`, 'application/pdf')) });
    await draw();
    expect(qa('[data-testid="rail-file"]')).toHaveLength(20);
    expect(q('[data-testid="rail-show-all"]')?.textContent).toBe('Show all files (60)');
  });

  it('closes with its button and with Escape', async () => {
    files.mockResolvedValue({ items: [], total: 0 });
    const onClose = vi.fn();
    await draw({ onClose });
    await act(async () => (q('[data-testid="rail-close"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    (q('[data-testid="rail-close"]') as HTMLButtonElement).focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
