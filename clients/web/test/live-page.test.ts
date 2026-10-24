import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { LiveDocument, applyTextChange, lineColumn, liveUrl, peerColor, peersOf, type LiveSocket } from '../src/viewers/markdown/live';

describe('applyTextChange', () => {
  it('sends one insert/delete, not a rewrite, and leaves the untouched prefix and suffix alone', () => {
    const doc = new Y.Doc();
    const text = doc.getText('body');
    text.insert(0, 'hello world');
    const updates: number[] = [];
    doc.on('update', () => updates.push(1));
    applyTextChange(text, 'hello brave world');
    expect(text.toString()).toBe('hello brave world');
    // one update for the insert
    expect(updates).toHaveLength(1);
    // A typed character at the end is one character, not one replacement of the whole line.
    const before = text.toString();
    applyTextChange(text, `${before}!`);
    expect(text.toString()).toBe(`${before}!`);
    expect(updates).toHaveLength(2);
  });

  it('is convergent when two documents apply different edits and exchange them', () => {
    const one = new Y.Doc();
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    applyTextChange(one.getText('body'), 'Nadia started it.');
    applyTextChange(two.getText('body'), 'Rafi joined.\n');
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    expect(one.getText('body').toString()).toBe(two.getText('body').toString());
    expect(one.getText('body').toString()).toContain('Nadia started it.');
    expect(one.getText('body').toString()).toContain('Rafi joined.');
  });
});

describe('peersOf', () => {
  it('lists other actors once each, with their cursor and a stable colour', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState({ actorId: 'me', user: { name: 'Nadia' }, cursor: { anchor: 1, head: 1 } });
    // A second awareness on the same doc stands in for another client's state: the protocol carries states by client id.
    const other = new Awareness(new Y.Doc());
    other.setLocalState({ actorId: 'rafi', user: { name: 'Rafi' }, cursor: { anchor: 7, head: 9 } });
    const state = [...other.getStates().values()][0]!;
    awareness.states.set(99, state);
    const peers = peersOf(awareness, 'me');
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ actorId: 'rafi', name: 'Rafi', cursor: { anchor: 7, head: 9 }, color: peerColor('rafi') });
    awareness.destroy();
    other.destroy();
  });

  it('ignores a state with no actor (the server’s own) and a cursor that is only a head', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.states.set(1, { server: true });
    awareness.states.set(2, { actorId: 'tariq', user: { name: 'Tariq' } });
    const [peer] = peersOf(awareness, 'me');
    expect(peer).toMatchObject({ actorId: 'tariq', cursor: null });
    awareness.destroy();
  });
});

describe('lineColumn', () => {
  it('counts lines and columns from an offset and clamps out-of-range values', () => {
    const text = 'first\nsecond\nthird';
    expect(lineColumn(text, 0)).toEqual({ line: 0, column: 0 });
    expect(lineColumn(text, 6)).toEqual({ line: 1, column: 0 });
    expect(lineColumn(text, 9)).toEqual({ line: 1, column: 3 });
    expect(lineColumn(text, 1_000)).toEqual({ line: 2, column: 5 });
  });
});

describe('liveUrl', () => {
  it('uses wss on https and encodes the team and the path', () => {
    expect(liveUrl({ protocol: 'https:', host: 'manythreads.example' }, 'engineering', 'pages/reports/week 37.md')).toBe(
      'wss://manythreads.example/api/teams/engineering/pages/live?path=pages%2Freports%2Fweek%2037.md',
    );
    expect(liveUrl({ protocol: 'http:', host: 'localhost:5173' }, 'marketing', 'pages/a.md')).toContain('ws://localhost:5173/');
  });
});

/** An in-memory peer that speaks the server's side of the protocol, so the client's own handshake is exercised. */
class FakeSocket implements LiveSocket {
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private readonly doc: Y.Doc) {}

  send(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type !== 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
    if (encoding.length(encoder) > 1) this.onmessage?.({ data: encoding.toUint8Array(encoder) });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes });
  }

  notice(notice: unknown): void {
    this.onmessage?.({ data: JSON.stringify(notice) });
  }

  /** The server sends a document update to this client (a frame type 0 + update). */
  pushUpdate(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    this.receive(encoding.toUint8Array(encoder));
  }
}

describe('LiveDocument over a socket pair', () => {
  it('loads the page, sends its edits, applies the peer’s edit and reports the session commit', () => {
    const serverDoc = new Y.Doc();
    serverDoc.getText('body').insert(0, 'start\n');
    const socket = new FakeSocket(serverDoc);
    const commits: Array<{ sha: string; editors: number }> = [];
    const statuses: string[] = [];
    const live = new LiveDocument({
      actorId: 'nadia',
      name: 'Nadia',
      url: 'ws://test/pages/live',
      socketFactory: () => socket,
      onCommit: (notice) => commits.push(notice),
      onStatus: (status) => statuses.push(status),
    });
    live.connect();
    socket.open();
    expect(live.text.toString()).toBe('start\n');
    expect(statuses).toContain('synced');

    live.edit('start\nNadia\n');
    expect(serverDoc.getText('body').toString()).toBe('start\nNadia\n');
    expect(live.peers()).toEqual([]);

    // The other editor's change reaches this document, and the click of a commit is reported.
    serverDoc.getText('body').insert(0, 'Rafi\n');
    socket.pushUpdate(Y.encodeStateAsUpdate(serverDoc, Y.encodeStateVector(live.doc)));
    expect(live.text.toString()).toContain('Rafi');
    socket.notice({ type: 'committed', sha: 'a'.repeat(40), editors: 2 });
    expect(commits).toEqual([{ sha: 'a'.repeat(40), editors: 2 }]);

    live.close();
    expect(live.doc.isDestroyed).toBe(true);
  });
});
