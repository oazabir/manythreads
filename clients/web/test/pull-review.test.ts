// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PullRequestChecksResponse, PullRequestDiffResponse, Task } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';

// P35-02: the card's Review. It shows the files (renamed and binary named, a large file kept as its name), the checks and the tested commit, and the three
// decisions; Merge is refused on the card when the request moved after the test or a check failed, and a lead's decision always names the tested head.

const api = {
  fetchPullRequestDiff: vi.fn(),
  fetchPullRequestChecks: vi.fn(),
  approvePullRequest: vi.fn(),
  requestPullRequestChanges: vi.fn(),
  mergePullRequest: vi.fn(),
  fetchThreadPullRequests: vi.fn(),
};
vi.mock('../src/screens/boards/api', () => ({
  fetchPullRequestDiff: (...a: unknown[]) => api.fetchPullRequestDiff(...a),
  fetchPullRequestChecks: (...a: unknown[]) => api.fetchPullRequestChecks(...a),
  approvePullRequest: (...a: unknown[]) => api.approvePullRequest(...a),
  requestPullRequestChanges: (...a: unknown[]) => api.requestPullRequestChanges(...a),
  mergePullRequest: (...a: unknown[]) => api.mergePullRequest(...a),
  fetchThreadPullRequests: (...a: unknown[]) => api.fetchThreadPullRequests(...a),
}));
const { PullReview } = await import('../src/screens/boards/PullReview');
const { ReviewLine } = await import('../src/taskview/ReviewLine');
const { MemoryRouter } = await import('react-router');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEAD = 'a'.repeat(40);
const task = (over: Partial<Task> = {}): Task =>
  ({
    id: '00000000-0000-7000-8000-0000000b0001',
    workspaceId: '00000000-0000-7000-8000-0000000b0002',
    teamId: '00000000-0000-7000-8000-0000000b0003',
    title: 'Fix',
    description: '',
    state: 'waiting_on_person',
    kind: 'code',
    priority: 'normal',
    ownerId: null,
    branch: 'card-00000000',
    baseSha: null,
    testedSha: HEAD,
    environmentId: null,
    boardId: null,
    threadRootId: null,
    pullRequest: { project: 'widgets', number: 24, url: 'https://github.com/acme/widgets/pull/24', state: 'open', mergeSha: null },
    testSiteUrl: 'https://test.example.test/',
    blockerReason: 'Pull request #24 waits for a person to merge it',
    reworkCount: 0,
    handoffCount: 3,
    createdBy: '00000000-0000-7000-8000-0000000b0004',
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    completedAt: null,
    ...over,
  }) as Task;

const diff = (over: Partial<PullRequestDiffResponse> = {}): PullRequestDiffResponse => ({
  number: 24,
  url: 'https://github.com/acme/widgets/pull/24',
  headSha: HEAD,
  atRecordedHead: true,
  page: 1,
  nextPage: null,
  files: [
    { path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, truncated: false, patch: '@@ -1 +1 @@\n-<b>old</b>\n+new' },
    { path: 'src/now.ts', previousPath: 'src/was.ts', status: 'renamed', additions: 0, deletions: 0, binary: false, truncated: false, patch: null },
    { path: 'logo.png', previousPath: null, status: 'added', additions: 0, deletions: 0, binary: true, truncated: false, patch: null },
  ],
  ...over,
});
const checks = (over: Partial<PullRequestChecksResponse> = {}): PullRequestChecksResponse => ({
  headSha: HEAD,
  atRecordedHead: true,
  summary: 'passing',
  checks: [{ name: 'test', state: 'passing', link: 'https://github.com/acme/widgets/runs/1' }],
  unreadable: null,
  ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = async (t: Task, onChanged = vi.fn()) => {
  await act(async () => {
    root.render(createElement(PullReview, { slug: 'engineering', task: t, onChanged }));
  });
  return onChanged;
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => {
    q(id)!.click();
  });
};

describe('the Review of a card', () => {
  it('shows the files, the checks, the tested commit and the test site, and draws patch text as text', async () => {
    api.fetchPullRequestDiff.mockResolvedValue(diff());
    api.fetchPullRequestChecks.mockResolvedValue(checks());
    await show(task());
    expect(api.fetchPullRequestDiff).toHaveBeenCalledWith('engineering', task().id, 1);
    expect(q('pull-review-size')!.textContent).toContain('3 files');
    const files = q('pull-review-files')!.textContent!;
    expect(files).toContain('src/was.ts → src/now.ts');
    expect(files).toContain('binary');
    expect(q('pull-review-checks')!.dataset['summary']).toBe('passing');
    expect(q('pull-review-test-site')!.getAttribute('href')).toBe('https://test.example.test/');
    // the provider's text is never markup
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('<b>old</b>');
  });

  it('is not shown for a card whose pull request is not open', async () => {
    await show(task({ pullRequest: { project: 'widgets', number: 24, url: 'https://github.com/acme/widgets/pull/24', state: 'merged', mergeSha: 'e'.repeat(40) }, state: 'done' }));
    expect(q('pull-review')).toBeNull();
    expect(api.fetchPullRequestDiff).not.toHaveBeenCalled();
  });

  it('approves at the tested head and says what the provider did', async () => {
    api.fetchPullRequestDiff.mockResolvedValue(diff());
    api.fetchPullRequestChecks.mockResolvedValue(checks());
    api.approvePullRequest.mockResolvedValue({ asComment: true, merged: false, mergeSha: null, handedTo: null });
    const changed = await show(task());
    await click('pull-review-approve');
    expect(api.approvePullRequest).toHaveBeenCalledWith('engineering', task().id, { headSha: HEAD });
    expect(q('pull-review-said')!.textContent).toContain('as a comment');
    expect(changed).toHaveBeenCalled();
  });

  it('sends a change request to the Coder with the comment, and shows a refusal as the server words it', async () => {
    api.fetchPullRequestDiff.mockResolvedValue(diff());
    api.fetchPullRequestChecks.mockResolvedValue(checks());
    api.requestPullRequestChanges.mockRejectedValueOnce(new ApiError({ code: 'forbidden', status: 403, message: 'only a lead of this team can approve, ask for changes or merge' }));
    await show(task());
    await click('pull-review-request-changes');
    const box = q('pull-review-comment') as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'Name the binary files.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('pull-review-send-changes');
    expect(api.requestPullRequestChanges).toHaveBeenCalledWith('engineering', task().id, { headSha: HEAD, comment: 'Name the binary files.' });
    expect(host.textContent).toContain('only a lead of this team');
  });

  it('refuses Merge on the card when the request moved after the test or a check failed; otherwise asks once more, then merges', async () => {
    api.fetchPullRequestDiff.mockResolvedValue(diff({ atRecordedHead: false, headSha: 'f'.repeat(40) }));
    api.fetchPullRequestChecks.mockResolvedValue(checks());
    await show(task());
    expect(q('pull-review-moved')).not.toBeNull();
    expect((q('pull-review-merge') as HTMLButtonElement).disabled).toBe(true);
    expect((q('pull-review-approve') as HTMLButtonElement).disabled).toBe(true);

    act(() => root.unmount());
    root = createRoot(host);
    api.fetchPullRequestDiff.mockResolvedValue(diff());
    api.fetchPullRequestChecks.mockResolvedValue(checks({ summary: 'failing', checks: [{ name: 'test', state: 'failing', link: null }] }));
    await show(task());
    expect((q('pull-review-merge') as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain('A check failed');

    act(() => root.unmount());
    root = createRoot(host);
    api.fetchPullRequestChecks.mockResolvedValue(checks());
    api.mergePullRequest.mockResolvedValue({ asComment: false, merged: true, mergeSha: 'e'.repeat(40), handedTo: null });
    await show(task());
    await click('pull-review-merge');
    expect(api.mergePullRequest).not.toHaveBeenCalled();
    await click('pull-review-merge-now');
    expect(api.mergePullRequest).toHaveBeenCalledWith('engineering', task().id, { headSha: HEAD });
    expect(q('pull-review-said')!.textContent).toContain('The card is done');
  });
});

describe('the thread’s Review line', () => {
  it('says which pull request waits for review and links to its card on the board; nothing when there is none', async () => {
    api.fetchThreadPullRequests.mockResolvedValue({ items: [{ taskId: task().id, boardId: '00000000-0000-7000-8000-0000000c0021', teamSlug: 'engineering', title: 'Fix', number: 24, testedSha: HEAD }] });
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(ReviewLine, { rootId: '00000000-0000-7000-8000-0000000d0001', revision: '' })));
    });
    expect(q('thread-review-line')!.textContent).toContain('Pull request #24 waits for review');
    expect(q('thread-review-open')!.getAttribute('href')).toBe(`/t/engineering/boards?board=00000000-0000-7000-8000-0000000c0021&card=${task().id}`);
    api.fetchThreadPullRequests.mockResolvedValue({ items: [] });
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(ReviewLine, { rootId: '00000000-0000-7000-8000-0000000d0001', revision: 'r2' })));
    });
    expect(q('thread-review-line')).toBeNull();
  });
});
