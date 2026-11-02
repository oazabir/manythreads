import { TERMINAL_LIMITS, TerminalText, type TerminalServerFrame } from '@manythreads/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { endTerminal, fetchTerminalRecord, openTerminal, terminalSocketUrl, terminalStatus } from '../src/screens/workshop/terminal/api';
import { answerFor, mockShellTransport } from '../src/screens/workshop/terminal/mock-transport';
import { KEY_EOF, KEY_INTERRUPT, asLine, chunkInput, endWords, fitSize, limitsLine, phaseWords, pushHistory, sessionRow, sizeWords, spanWords, stepHistory } from '../src/screens/workshop/terminal/model';
import { socketTransport, type SocketLike } from '../src/screens/workshop/terminal/transport';
import { TerminalView } from '../src/screens/workshop/terminal/TerminalView';

// P7-09 (web): the small rules of the Terminal view, the transport between the page and the shell (a scripted one and the real one over a fake socket), the mock routes (admin only), and the
// first markup of the view.

const use = (as = 'omar') => setTransport(createMockTransport({ latencyMs: 0, as }));
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the rules of the view', () => {
  it('sends a line with its newline, and a paste in frames the server accepts', () => {
    expect(asLine('ls')).toBe('ls\n');
    expect(chunkInput('')).toEqual([]);
    const big = 'a'.repeat(TERMINAL_LIMITS.inputFrameMax * 2 + 10);
    const parts = chunkInput(big);
    expect(parts.map((p) => p.length)).toEqual([TERMINAL_LIMITS.inputFrameMax, TERMINAL_LIMITS.inputFrameMax, 10]);
    expect(parts.join('')).toBe(big);
    // a character of two code units is never cut in half
    const emoji = chunkInput('😀'.repeat(5), 5);
    expect(emoji.every((p) => [...p].every((c) => c === '😀'))).toBe(true);
    expect(emoji.join('')).toBe('😀'.repeat(5));
  });

  it('fits the shell’s screen to the box, within what the server takes', () => {
    expect(fitSize(840, 360)).toEqual({ cols: 100, rows: 20 });
    expect(fitSize(0, 0)).toEqual({ cols: TERMINAL_LIMITS.cols.default, rows: TERMINAL_LIMITS.rows.default });
    expect(fitSize(30, 20).cols).toBe(TERMINAL_LIMITS.cols.min);
    expect(fitSize(99_999, 99_999)).toEqual({ cols: TERMINAL_LIMITS.cols.max, rows: TERMINAL_LIMITS.rows.max });
    // a phone: 390 px wide minus the padding
    const phone = fitSize(340, 250);
    expect(phone.cols).toBeGreaterThanOrEqual(TERMINAL_LIMITS.cols.min);
    expect(phone.cols).toBeLessThan(50);
  });

  it('says times and limits in plain words', () => {
    expect(spanWords(45)).toBe('45 seconds');
    expect(spanWords(60)).toBe('1 minute');
    expect(spanWords(300)).toBe('5 minutes');
    expect(spanWords(1800)).toBe('30 minutes');
    expect(spanWords(3600)).toBe('1 hour');
    expect(limitsLine({ idleSeconds: 300, maxSeconds: 1800, outputBytesPerSecond: 1, outputBytesTotal: 1, inputBytesTotal: 1, transcriptChars: 1 })).toBe('It closes by itself after 5 minutes without typing, or 30 minutes in all.');
    expect(sizeWords(10)).toBe('10 bytes');
    expect(sizeWords(2048)).toBe('2.0 KB');
  });

  it('words why a terminal ended: the server’s sentence, else the standard one for the reason', () => {
    expect(endWords('idle')).toMatch(/nothing was typed/);
    expect(endWords('ended_by_admin')).toBe('Ended by an admin.');
    expect(endWords('closed', 'Custom words.')).toBe('Custom words.');
    expect(endWords(null)).toBe('Closed.');
    for (const phase of ['checking', 'unavailable', 'ready', 'starting', 'open', 'ended', 'failed'] as const) expect(phaseWords(phase).length).toBeGreaterThan(5);
    expect(phaseWords('unavailable', 'Switched off.')).toBe('Switched off.');
  });

  it('keeps what was typed for the arrow keys', () => {
    let h: string[] = [];
    h = pushHistory(h, 'ls');
    h = pushHistory(h, 'ls');
    h = pushHistory(h, '   ');
    h = pushHistory(h, 'pwd');
    expect(h).toEqual(['ls', 'pwd']);
    expect(stepHistory(h, 2, 'ArrowUp', 'half typed')).toEqual({ index: 1, text: 'pwd' });
    expect(stepHistory(h, 1, 'ArrowUp', '')).toEqual({ index: 0, text: 'ls' });
    expect(stepHistory(h, 0, 'ArrowUp', '')).toEqual({ index: 0, text: 'ls' });
    expect(stepHistory(h, 1, 'ArrowDown', 'half typed')).toEqual({ index: 2, text: 'half typed' });
    expect(pushHistory(Array.from({ length: 100 }, (_, i) => `c${String(i)}`), 'new')).toHaveLength(100);
  });

  it('describes an earlier terminal', () => {
    const row = sessionRow({
      id: '00000000-0000-7000-8000-00000000f001' as never,
      botSlug: 'brain',
      status: 'ended',
      admin: { id: '00000000-0000-7000-8000-0000000000aa' as never, name: 'Omar' },
      sandbox: { kind: 'rehearsal', runId: null },
      startedAt: '2026-11-02T09:30:00.000Z',
      endedAt: '2026-11-02T09:40:00.000Z',
      endReason: 'idle',
      createdAt: '2026-11-02T09:29:00.000Z',
      bytesIn: 10,
      bytesOut: 20,
      credentialsRevoked: 2,
      limits: { idleSeconds: 300, maxSeconds: 1800, outputBytesPerSecond: 1, outputBytesTotal: 1, inputBytesTotal: 1, transcriptChars: 1 },
    });
    expect(row.title).toBe('Omar · 2026-11-02 09:30 UTC');
    expect(row.meta).toMatch(/nothing was typed/);
  });
});

describe('the pretend shell', () => {
  const collect = (t: ReturnType<typeof mockShellTransport>) => {
    const frames: TerminalServerFrame[] = [];
    const closes: number[] = [];
    t.onFrame((f) => frames.push(f));
    t.onClose((i) => closes.push(i.code));
    return { frames, closes };
  };
  const printed = (frames: TerminalServerFrame[]): string => {
    const text = new TerminalText();
    for (const f of frames) if (f.t === 'out') text.feed(f.d);
    return `${text.lines.join('\n')}\n${text.current}`;
  };

  it('opens with a ready frame (credentials already revoked) and a prompt, answers commands, and ends on exit', async () => {
    const sent: never[] = [];
    const t = mockShellTransport({ sent });
    const { frames, closes } = collect(t);
    await tick();
    expect(frames[0]).toMatchObject({ t: 'ready', credentialsRevoked: 2 });
    t.send({ t: 'in', d: 'id\n' });
    t.send({ t: 'in', d: 'pwd\nls\n' });
    await tick(20);
    const screen = printed(frames);
    expect(screen).toContain('uid=65534(nobody)');
    expect(screen).toContain('/work');
    expect(screen).toContain('README.txt');
    t.send({ t: 'in', d: 'exit\n' });
    await tick(20);
    expect(frames.at(-1)).toMatchObject({ t: 'end', reason: 'closed' });
    expect(closes).toEqual([1000]);
    // nothing is sent after the end
    const count = frames.length;
    t.send({ t: 'in', d: 'id\n' });
    await tick(20);
    expect(frames).toHaveLength(count);
  });

  it('Ctrl+C gives a fresh prompt and Ctrl+D ends the shell; the network is not there', async () => {
    const t = mockShellTransport();
    const { frames, closes } = collect(t);
    await tick();
    t.send({ t: 'in', d: 'sleep 100' });
    t.send({ t: 'in', d: KEY_INTERRUPT });
    await tick(20);
    expect(printed(frames)).toContain('^C');
    t.send({ t: 'in', d: 'curl example.com\n' });
    await tick(20);
    expect(printed(frames)).toContain('network is unreachable');
    t.send({ t: 'in', d: KEY_EOF });
    await tick(20);
    expect(closes).toEqual([1000]);
    expect(answerFor('whoami')).toBe('nobody');
    expect(answerFor('nope')).toBe('bash: nope: command not found');
  });

  it('closing from the page closes once', async () => {
    const t = mockShellTransport();
    const { closes } = collect(t);
    t.close();
    t.close();
    expect(closes).toEqual([1000]);
  });
});

describe('the real transport, over a fake socket', () => {
  function fake() {
    const sent: string[] = [];
    const closedWith: Array<[number | undefined, string | undefined]> = [];
    const socket: SocketLike = {
      readyState: 0,
      send: (d) => sent.push(d),
      close: (c, r) => closedWith.push([c, r]),
      onmessage: null,
      onclose: null,
      onopen: null,
      onerror: null,
    };
    return { socket, sent, closedWith };
  }

  it('holds frames until the socket opens, then sends them in order as JSON', () => {
    const { socket, sent } = fake();
    const t = socketTransport(socket);
    t.send({ t: 'size', cols: 80, rows: 24 });
    t.send({ t: 'in', d: 'ls\n' });
    expect(sent).toEqual([]);
    socket.readyState = 1;
    socket.onopen?.({});
    expect(sent.map((s) => JSON.parse(s))).toEqual([{ t: 'size', cols: 80, rows: 24 }, { t: 'in', d: 'ls\n' }]);
    t.send({ t: 'in', d: 'pwd\n' });
    expect(sent).toHaveLength(3);
  });

  it('hands valid frames over, and closes on anything else', () => {
    const { socket, closedWith } = fake();
    const t = socketTransport(socket);
    const got: TerminalServerFrame[] = [];
    t.onFrame((f) => got.push(f));
    socket.onmessage?.({ data: JSON.stringify({ t: 'out', d: 'hello' }) });
    expect(got).toEqual([{ t: 'out', d: 'hello' }]);
    socket.onmessage?.({ data: 'not json' });
    socket.onmessage?.({ data: JSON.stringify({ t: 'out', d: 5 }) });
    socket.onmessage?.({ data: JSON.stringify({ t: 'bogus' }) });
    socket.onmessage?.({ data: new ArrayBuffer(4) });
    expect(got).toHaveLength(1);
    expect(closedWith.map((c) => c[0])).toEqual([1007, 1007, 1007, 1003]);
  });

  it('tells about the close once, with the server’s code', () => {
    const { socket } = fake();
    const t = socketTransport(socket);
    const closes: Array<{ code: number; reason: string }> = [];
    t.onClose((i) => closes.push(i));
    socket.onclose?.({ code: 1008, reason: 'session ended' });
    socket.onclose?.({ code: 1000, reason: 'again' });
    t.close();
    expect(closes).toEqual([{ code: 1008, reason: 'session ended' }]);
  });

  it('builds the socket address on the same site, with the right scheme', () => {
    expect(terminalSocketUrl('engineering', 'brain', '00000000-0000-7000-8000-00000000f001', { protocol: 'https:', host: 'manythreads.example' })).toBe(
      'wss://manythreads.example/api/teams/engineering/bots/brain/workshop/terminal/00000000-0000-7000-8000-00000000f001/socket',
    );
    expect(terminalSocketUrl('a', 'b', 'c', { protocol: 'http:', host: 'localhost:5173' }).startsWith('ws://localhost:5173/')).toBe(true);
  });
});

describe('the routes, offline', () => {
  beforeEach(() => use());

  it('an admin sees the status, opens one terminal, ends it and reads its record; a second at once is refused', async () => {
    const status = await terminalStatus('engineering', 'brain');
    expect(status).toMatchObject({ available: true, reason: null });
    expect(status.limits.idleSeconds).toBe(TERMINAL_LIMITS.idleSeconds);
    const { session } = await openTerminal('engineering', 'brain');
    expect(session).toMatchObject({ status: 'open', botSlug: 'brain', sandbox: { kind: 'rehearsal' }, credentialsRevoked: 2 });
    await expect(openTerminal('engineering', 'brain')).rejects.toThrow(/already have a terminal open/);
    const ended = await endTerminal('engineering', 'brain', session.id);
    expect(ended.session).toMatchObject({ status: 'ended', endReason: 'ended_by_admin' });
    const record = await fetchTerminalRecord('engineering', 'brain', session.id);
    expect(record.session.transcriptTruncated).toBe(false);
    expect((await terminalStatus('engineering', 'brain')).sessions.map((s) => s.id)).toContain(session.id);
    await openTerminal('engineering', 'brain');
  });

  it('a plain member is refused on every route, in words', async () => {
    use('nadia');
    await expect(terminalStatus('engineering', 'brain')).rejects.toThrow(/Only a workspace admin/);
    await expect(openTerminal('engineering', 'brain')).rejects.toThrow(/Only a workspace admin/);
    await expect(endTerminal('engineering', 'brain', '00000000-0000-7000-8000-00000000f001')).rejects.toThrow(/Only a workspace admin/);
    await expect(fetchTerminalRecord('engineering', 'brain', '00000000-0000-7000-8000-00000000f001')).rejects.toThrow(/Only a workspace admin/);
  });
});

describe('the markup', () => {
  it('starts by checking, says what the sandbox is in plain words, and has no command box before a terminal is open', () => {
    const html = renderToStaticMarkup(createElement(TerminalView, { slug: 'engineering', botSlug: 'brain', botName: 'Brain', onBack: () => undefined }));
    expect(html).toContain('data-phase="checking"');
    expect(html).toContain('Terminal · Brain');
    expect(html).toContain('throwaway test sandbox');
    expect(html).toContain('no network');
    expect(html).toContain('never a real one');
    expect(html).toContain('switched off before the window opens');
    expect(html).toContain('recorded');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('data-testid="terminal-input"');
    expect(html).not.toMatch(/<script/i);
  });
});
