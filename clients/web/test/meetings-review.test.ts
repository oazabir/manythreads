// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEETING_REVIEW_PUSH, type MeetingReview } from '@manythreads/shared';
import { ApiError } from '../src/api/client';
import { AssistantStore, MARK_SHOWN_MS } from '../src/meetings/assistant';
import { confirmBody, confirmLabel, confirmedLine, draftOf, draftReady, handleReviewPush, keptCount, onReviewChanged } from '../src/meetings/review';

// Mark action item and the end-of-call review on the page (P17-06 step 2): the words of the Confirm button, what Confirm sends, the push that asks the page again, the
// call bar's mark (what it kept, a refusal, gone after a few seconds), and the review panel drawn, edited and confirmed against a scripted server.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM = '00000000-0000-7000-8000-000000000101';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const NADIA = '00000000-0000-7000-8000-00000000aa01';
const RAFI = '00000000-0000-7000-8000-00000000aa02';
const REVIEW = {
  meetingId: ROOM,
  status: 'open',
  items: [
    { id: A, source: 'notes', text: 'Send the draft', ownerId: NADIA, ownerName: 'Nadia', due: null, atMs: 0 },
    { id: B, source: 'mark', text: 'Rafi: Book the room', ownerId: null, ownerName: null, due: null, atMs: 5000 },
  ],
  notesIncluded: true,
  openedAt: '2026-11-25T10:30:00.000Z',
  confirmedAt: null,
  confirmedByName: null,
  canConfirm: true,
  people: [
    { actorId: NADIA, displayName: 'Nadia' },
    { actorId: RAFI, displayName: 'Rafi' },
  ],
} as unknown as MeetingReview;

const api = vi.hoisted(() => ({ fetchMeetingReview: vi.fn(), confirmMeetingReview: vi.fn() }));
vi.mock('../src/meetings/api', async (orig) => ({ ...(await orig<object>()), ...api }));

describe('the words and what Confirm sends', () => {
  it('counts the items kept on the button', () => {
    expect(confirmLabel(3)).toBe('Confirm before sending: 3 action items');
    expect(confirmLabel(1)).toBe('Confirm before sending: 1 action item');
    expect(confirmLabel(0)).toBe('Confirm: no action items');
    expect(confirmedLine({ confirmedByName: 'Rafi', items: REVIEW.items })).toBe('Confirmed by Rafi · 2 action items');
  });
  it('sends the kept items with their words and owner, and how many the person saw', () => {
    const draft = draftOf(REVIEW).map((d) => (d.id === A ? { ...d, removed: true } : { ...d, text: '  Book room 4  ', ownerId: RAFI }));
    expect(keptCount(draft)).toBe(1);
    expect(confirmBody(REVIEW, draft)).toEqual({ items: [{ id: B, text: 'Book room 4', ownerId: RAFI }], seen: 2 });
    expect(draftReady(draft)).toBe(true);
    expect(draftReady(draft.map((d) => ({ ...d, text: ' ', removed: false })))).toBe(false);
  });
  it('tells the page when its review changed, and ignores anything else', () => {
    const seen: string[] = [];
    const off = onReviewChanged((id) => seen.push(id));
    handleReviewPush({ type: MEETING_REVIEW_PUSH, payload: { meetingId: ROOM, status: 'open' } });
    handleReviewPush({ type: MEETING_REVIEW_PUSH, payload: { nonsense: true } });
    handleReviewPush({ type: 'meeting.ask', payload: { meetingId: ROOM } });
    off();
    handleReviewPush({ type: MEETING_REVIEW_PUSH, payload: { meetingId: ROOM, status: 'confirmed' } });
    expect(seen).toEqual([ROOM]);
  });
});

describe('Mark action item in the call bar', () => {
  const store = (mark: ConstructorParameters<typeof AssistantStore>[0]['mark']) => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const s = new AssistantStore({
      status: async () => ({ ask: { available: false, answerer: null, reason: 'x' }, catchUp: { available: false, minutesBefore: 0, reason: 'x' } }),
      ask: async () => {
        throw new Error('not asked');
      },
      catchUp: async () => {
        throw new Error('not asked');
      },
      mark,
      now: () => 0,
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
    });
    s.follow(ROOM);
    return { s, timers };
  };
  it('says what it kept, then goes quiet', async () => {
    const { s, timers } = store(async () => ({ mark: { id: A, meetingId: ROOM as never, markedBy: NADIA as never, atMs: 0, text: 'Nadia: I will send it.', createdAt: '2026-11-25T10:00:00.000Z' }, count: 2 }));
    await s.markActionItem();
    expect(s.snapshot().mark).toEqual({ kind: 'marked', text: 'Nadia: I will send it.', count: 2 });
    expect(timers.at(-1)?.ms).toBe(MARK_SHOWN_MS);
    timers.at(-1)!.fn();
    expect(s.snapshot().mark).toEqual({ kind: 'idle' });
  });
  it('says why not, in the server’s words', async () => {
    const { s } = store(async () => {
      throw new ApiError({ code: 'conflict', status: 409, message: 'Nothing was written down in the last 30 seconds. Say the action item, then mark it.' });
    });
    await s.markActionItem();
    expect(s.snapshot().mark).toEqual({ kind: 'failed', text: 'Nothing was written down in the last 30 seconds. Say the action item, then mark it.' });
  });
});

describe('the review panel', () => {
  let root: Root | null = null;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    api.fetchMeetingReview.mockReset();
    api.confirmMeetingReview.mockReset();
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
  });
  const draw = async (): Promise<void> => {
    const { ReviewPanel } = await import('../src/screens/meetings/ReviewPanel');
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(ReviewPanel, { meetingId: ROOM, ended: true }));
    });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
  };
  const $ = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

  it('shows nothing to a person with no review', async () => {
    api.fetchMeetingReview.mockResolvedValue({ review: null });
    await draw();
    expect($('meeting-review')).toHaveLength(0);
  });

  it('lets the person remove an item and confirm the rest, then shows what was confirmed', async () => {
    api.fetchMeetingReview.mockResolvedValue({ review: REVIEW });
    api.confirmMeetingReview.mockImplementation(async (_id: string, body: { items: Array<{ id: string; text: string; ownerId: string | null }> }) => ({
      review: { ...REVIEW, status: 'confirmed', canConfirm: false, confirmedByName: 'Rafi', confirmedAt: '2026-11-25T10:40:00.000Z', items: [{ ...REVIEW.items[1]!, ...body.items[0] }] },
    }));
    await draw();
    expect($('review-item')).toHaveLength(2);
    expect($('review-confirm')[0]!.textContent).toBe('Confirm before sending: 2 action items');
    await act(async () => $('review-remove')[0]!.click());
    expect($('review-confirm')[0]!.textContent).toBe('Confirm before sending: 1 action item');
    await act(async () => $('review-confirm')[0]!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(api.confirmMeetingReview).toHaveBeenCalledWith(ROOM, { items: [{ id: B, text: 'Rafi: Book the room', ownerId: null }], seen: 2 });
    expect($('review-confirmed')[0]!.textContent).toBe('Confirmed by Rafi · 1 action item');
  });

  it('shows the new review when someone else confirmed first', async () => {
    api.fetchMeetingReview.mockResolvedValueOnce({ review: REVIEW }).mockResolvedValue({ review: { ...REVIEW, status: 'confirmed', canConfirm: false, confirmedByName: 'Nadia' } });
    api.confirmMeetingReview.mockRejectedValue(new ApiError({ code: 'conflict', status: 409, message: 'Nadia confirmed these action items already.' }));
    await draw();
    await act(async () => $('review-confirm')[0]!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect($('review-notice')[0]!.textContent).toBe('Nadia confirmed these action items already.');
    expect($('review-confirmed')[0]!.textContent).toBe('Confirmed by Nadia · 2 action items');
  });
});
