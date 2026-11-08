import { describe, expect, it } from 'vitest';
import type { KnowledgeConnectorProvider } from '@manythreads/shared';
import { createDocumentsConnector } from '../src/documents-provider.ts';
import type { DocAdapter } from '../src/documents/adapter.ts';
import { DocError } from '../src/documents/http.ts';
import { ConnectionProblem, type OAuthDeps } from '../src/oauth/store.ts';

// The facade of the documents door (P16-08, WP-D1): finding the person's grant, the permission check, the pass-through of cursors, and the turning of every failure into the
// door's answers with words of ours. The readers are stubs here (they are tested against the stand-ins in the other documents-* files), and the database is a stub that
// answers the one grant query, so this file needs no database.

const CALLER = { workspaceId: '00000000-0000-0000-0000-000000000001', personId: '00000000-0000-0000-0000-000000000002' };
const TX = {} as never;

function rig(grant: { scopes: string[]; state?: string; status?: string } | null) {
  const asked: unknown[][] = [];
  const deps = {
    db: {
      system: async (fn: (tx: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) =>
        fn({
          query: async (_sql, params) => {
            asked.push(params);
            return { rows: grant ? [{ id: 'conn-1', status: grant.status ?? 'enabled', has_credentials: true, expired: false, scopes: grant.scopes, state: grant.state ?? 'ok' }] : [] };
          },
        }),
    },
    secrets: {},
    now: () => new Date('2026-11-08T00:00:00Z'),
    env: { NODE_ENV: 'test' },
  } as unknown as OAuthDeps;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stub = (over: Partial<DocAdapter> = {}): DocAdapter => ({
    listRoots: async (...args) => (calls.push({ method: 'listRoots', args }), [{ id: 'r', name: 'R', kind: 'folder', parent: null }]),
    listChanges: async (...args) => (calls.push({ method: 'listChanges', args }), { items: [], next: null, cursor: 'c2' }),
    fetch: async (...args) => (calls.push({ method: 'fetch', args }), { bytes: new Uint8Array([1]), kind: 'text' as const }),
    access: async (...args) => (calls.push({ method: 'access', args }), { anyone: false, domains: [], users: [], groups: true }),
    ...over,
  });
  const connector = (provider: KnowledgeConnectorProvider, over: Partial<DocAdapter> = {}) => createDocumentsConnector(deps, { adapters: { [provider]: stub(over) } });
  return { asked, calls, connector };
}

const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';

describe('the documents door', () => {
  it('is registered under the id "connections" and answers not_connected when the person has no usable grant', async () => {
    const r = rig(null);
    const door = r.connector('google_drive');
    expect(door.id).toBe('connections');
    const answer = await door.listRoots(TX, { ...CALLER, provider: 'google_drive' });
    expect(answer).toMatchObject({ ok: false, code: 'not_connected' });
    expect(r.calls).toEqual([]);
    // a grant that needs signing in again is no grant
    const stale = await rig({ scopes: [DRIVE], state: 'needs_reconnect' }).connector('google_drive').listRoots(TX, { ...CALLER, provider: 'google_drive' });
    expect(stale).toMatchObject({ ok: false, code: 'not_connected' });
  });

  it('looks for the person\'s own connection of the right kind: Microsoft for OneDrive and SharePoint, Google for Drive, the provider\'s own for the rest', async () => {
    const r = rig({ scopes: ['Files.Read', 'Sites.Read.All'] });
    await r.connector('onedrive').listRoots(TX, { ...CALLER, provider: 'onedrive' });
    await r.connector('sharepoint').listRoots(TX, { ...CALLER, provider: 'sharepoint' });
    await rig({ scopes: [] }).connector('notion').listRoots(TX, { ...CALLER, provider: 'notion' });
    expect(r.asked.map((p) => p[2])).toEqual(['microsoft', 'microsoft']);
    expect(r.asked[0]!.slice(0, 2)).toEqual([CALLER.workspaceId, CALLER.personId]);
  });

  it('answers scope_missing when the person did not agree to reading documents (Notion and Box have no scope to compare)', async () => {
    const without = rig({ scopes: ['openid'] });
    expect(await without.connector('google_drive').listRoots(TX, { ...CALLER, provider: 'google_drive' })).toMatchObject({ ok: false, code: 'scope_missing' });
    expect(await rig({ scopes: ['Files.Read'] }).connector('sharepoint').listRoots(TX, { ...CALLER, provider: 'sharepoint' })).toMatchObject({ ok: false, code: 'scope_missing' });
    expect(without.calls).toEqual([]);
    expect(await rig({ scopes: [] }).connector('notion').listRoots(TX, { ...CALLER, provider: 'notion' })).toMatchObject({ ok: true });
    expect(await rig({ scopes: [] }).connector('box').listRoots(TX, { ...CALLER, provider: 'box' })).toMatchObject({ ok: true });
  });

  it('passes the root and the cursor on, and a page token (the `next` of an earlier answer) wins over the stored cursor', async () => {
    const r = rig({ scopes: [DRIVE] });
    const door = r.connector('google_drive');
    expect(await door.listChanges(TX, { ...CALLER, provider: 'google_drive', root: 'folder-1', cursor: 'stored' })).toEqual({ ok: true, value: { items: [], next: null, cursor: 'c2' } });
    await door.listChanges(TX, { ...CALLER, provider: 'google_drive', root: 'folder-1', cursor: 'stored', pageToken: 'mid-pass' });
    await door.listChanges(TX, { ...CALLER, provider: 'google_drive', root: 'folder-1', cursor: null });
    expect(r.calls.map((c) => (c.args[1] as { cursor: string | null }).cursor)).toEqual(['stored', 'mid-pass', null]);
    expect((r.calls[0]!.args[1] as { root: string }).root).toBe('folder-1');
  });

  it('turns a reader\'s error into the door\'s code with the reader\'s own sentence', async () => {
    const door = rig({ scopes: [DRIVE] }).connector('google_drive', {
      fetch: async () => {
        throw new DocError('not_found', 'Google Drive has nothing there.');
      },
      access: async () => {
        throw new DocError('provider_down', 'Google Drive is not available right now.');
      },
    });
    expect(await door.fetch(TX, { ...CALLER, provider: 'google_drive', remoteId: 'x' })).toEqual({ ok: false, code: 'not_found', message: 'Google Drive has nothing there.' });
    expect(await door.access(TX, { ...CALLER, provider: 'google_drive', remoteId: 'x' })).toMatchObject({ ok: false, code: 'provider_down' });
  });

  it('turns a dead sign-in into not_connected, and a surprise into a sentence of ours that carries none of what was thrown', async () => {
    const dead = rig({ scopes: [DRIVE] }).connector('google_drive', {
      listRoots: async () => {
        throw new ConnectionProblem('needs_reconnect', 'Your Google connection stopped working.');
      },
    });
    expect(await dead.listRoots(TX, { ...CALLER, provider: 'google_drive' })).toMatchObject({ ok: false, code: 'not_connected' });
    const down = rig({ scopes: [DRIVE] }).connector('google_drive', {
      listRoots: async () => {
        throw new TypeError('Bearer ya29.SECRET-TOKEN could not be read at https://internal.example/x');
      },
    });
    const answer = await down.listRoots(TX, { ...CALLER, provider: 'google_drive' });
    expect(answer).toMatchObject({ ok: false, code: 'provider_down' });
    expect(JSON.stringify(answer)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(answer)).not.toContain('internal.example');
  });

  it('refuses an absurdly long root, id or cursor without asking the reader', async () => {
    const r = rig({ scopes: [DRIVE] });
    const door = r.connector('google_drive');
    const long = 'a'.repeat(70_000);
    expect(await door.listChanges(TX, { ...CALLER, provider: 'google_drive', root: long, cursor: null })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await door.listChanges(TX, { ...CALLER, provider: 'google_drive', root: 'r', cursor: long })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await door.fetch(TX, { ...CALLER, provider: 'google_drive', remoteId: long })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await door.access(TX, { ...CALLER, provider: 'google_drive', remoteId: long })).toMatchObject({ ok: false, code: 'not_found' });
    expect(r.calls).toEqual([]);
  });

  it('refuses a provider it has no reader for', async () => {
    const door = createDocumentsConnector(rig({ scopes: [DRIVE] }) && ({} as never));
    expect(await door.listRoots(TX, { ...CALLER, provider: 'nope' as never })).toMatchObject({ ok: false, code: 'not_connected' });
  });
});
