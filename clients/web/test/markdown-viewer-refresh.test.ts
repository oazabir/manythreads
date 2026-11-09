// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownViewer from '../src/viewers/markdown/MarkdownViewer';
import { useContent } from '../src/screens/files/useContent';
import type { FileContent } from '../src/screens/files/backend';
import type { FileRow } from '../src/screens/files/model';
import type { TeamFiles } from '../src/screens/files/store';
import type { ViewerProps } from '../src/kernel/viewers';

// The Markdown viewer behind the History panel kept the text from before a restore (found by journey N4): it made its editor once and had no effect for a
// changed `text`, and the host did not read the file again when a restore brought back the very blob it first read, because live editing had changed the file
// without the host knowing.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = '# Runbook\n\nThe first text.\n';
const B = '# Runbook\n\nThe restored text.\n';

const props = (text: string, extra: Partial<ViewerProps> = {}): ViewerProps => ({
  path: 'pages/runbook.md',
  mime: 'text/markdown',
  text,
  readOnly: false,
  onSave: () => Promise.resolve(),
  context: { teamSlug: 'engineering', teamName: 'Engineering', authorName: 'Nadia' },
  ...extra,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = async (p: ViewerProps): Promise<void> => {
  await act(async () => {
    root.render(createElement(MarkdownViewer, p));
  });
};
const prose = (): string => host.querySelector('.md-prose')?.textContent ?? '';
const saveButton = (): HTMLButtonElement => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save') as HTMLButtonElement;

describe('the Markdown viewer and a changed text', () => {
  it('shows the new text when the file changed from outside', async () => {
    await show(props(A));
    expect(prose()).toContain('The first text.');
    await show(props(B));
    expect(prose()).toContain('The restored text.');
    expect(prose()).not.toContain('The first text.');
    // what was brought in is the file's text, not an edit: nothing to save
    expect(saveButton().disabled).toBe(true);
  });

  it('shows it in the raw text as well', async () => {
    await show(props(A));
    const raw = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Raw') as HTMLButtonElement;
    await act(async () => raw.click());
    expect((host.querySelector('textarea.md-raw') as HTMLTextAreaElement).value).toBe(A);
    await show(props(B));
    expect((host.querySelector('textarea.md-raw') as HTMLTextAreaElement).value).toBe(B);
  });

  it('keeps an unsaved edit when other text arrives, and leaves the Save to the file\'s own conflict check', async () => {
    await show(props(A));
    const raw = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Raw') as HTMLButtonElement;
    await act(async () => raw.click());
    const area = host.querySelector('textarea.md-raw') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(area, `${A}My own line.\n`);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(saveButton().disabled).toBe(false);
    await show(props(B));
    expect((host.querySelector('textarea.md-raw') as HTMLTextAreaElement).value).toBe(`${A}My own line.\n`);
    expect(saveButton().disabled).toBe(false);
  });

  it('does nothing when the same text arrives again', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    await show(props(A, { onSave }));
    await show(props(A, { onSave }));
    expect(prose()).toContain('The first text.');
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('useContent after the viewer changed the file itself', () => {
  const row = (blobSha: string): FileRow => ({ path: 'pages/runbook.md', name: 'runbook.md', kind: 'file', store: 'git', blobSha }) as FileRow;
  const filesOf = (opened: string[]): TeamFiles => {
    let n = 0;
    const open = (): FileContent => {
      const id = `content-${String(++n)}`;
      opened.push(id);
      // the object reads blob "s0" whatever happens (a live session commits behind its back)
      return { source: { url: '', text: () => Promise.resolve(id), bytes: () => Promise.resolve(new Uint8Array()) }, save: null, sha: () => 's0' };
    };
    return { backend: { open } } as unknown as TeamFiles;
  };
  type Hook = ReturnType<typeof useContent>;
  const mount = async (files: TeamFiles, r: FileRow): Promise<{ get: () => Hook; rerender: (next: FileRow) => Promise<void> }> => {
    let last: Hook | undefined;
    const Probe = ({ r: current }: { r: FileRow }) => {
      last = useContent(files, current);
      return null;
    };
    await act(async () => root.render(createElement(Probe, { r })));
    return { get: () => last!, rerender: (next) => act(async () => root.render(createElement(Probe, { r: next }))) };
  };

  it('reads the file again when the row is read again, even if the blob is the one it first read (the restore brought it back)', async () => {
    const opened: string[] = [];
    const hook = await mount(filesOf(opened), row('s0'));
    expect(opened).toHaveLength(1);
    const first = hook.get().content;
    // live editing: the file now holds another blob that the host never saw
    act(() => hook.get().viewerChangedFile());
    // nothing was read again yet (no new row)
    expect(opened).toHaveLength(1);
    // the restore: the row is read again and carries the first blob
    await hook.rerender(row('s0'));
    expect(opened).toHaveLength(2);
    expect(hook.get().content).not.toBe(first);
  });

  it('without the viewer\'s notice, a row with the blob it knows keeps the content (a save of its own does not reload the editor)', async () => {
    const opened: string[] = [];
    const hook = await mount(filesOf(opened), row('s0'));
    await hook.rerender(row('s0'));
    expect(opened).toHaveLength(1);
  });
});
