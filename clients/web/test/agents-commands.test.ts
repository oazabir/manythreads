import { describe, expect, it } from 'vitest';
import type { BotSummary } from '@manythreads/shared';
import { createMockTransport } from '../src/api/mock';
import { setTransport } from '../src/api/client';
import { createConnection, deleteConnection, fetchConnections, testConnection } from '../src/screens/agents/api';
import { botsOnConnection, bridgeCommand, bridgeSwitchWarning, hermesProfileYaml, mcpAddress, statusLine, validateEdit, validateNew } from '../src/screens/agents/commands';

const bot = (slug: string, gateway?: { connection: string; profile?: string }) => ({ id: slug, slug, name: slug, placement: gateway ? { gateway } : null }) as unknown as BotSummary;

describe('Agents page text and checks', () => {
  it('builds the Hermes profile block from the public origin', () => {
    const y = hermesProfileYaml('https://manythreads.kahf.to/');
    expect(y).toContain('url: "https://manythreads.kahf.to/mcp"');
    expect(y).toContain('Authorization: "Bearer ${MANYTHREADS_MCP_TOKEN}"');
    expect(y.startsWith('mcp_servers:')).toBe(true);
    expect(mcpAddress('http://localhost:5173')).toBe('http://localhost:5173/mcp');
  });
  it('builds the bridge command', () => {
    expect(bridgeCommand('127.0.0.1:8650')).toBe('tsx tools/agent-bridge/src/main.ts --config bridge.json --listen 127.0.0.1:8650');
  });
  it('validates the add form with the server schema', () => {
    const ok = validateNew({ name: ' bridge ', agent: 'claude-code', baseUrl: 'http://10.0.0.5:8650', apiKey: 'secret-key-1' });
    expect(ok.ok && ok.body).toMatchObject({ name: 'bridge', agent: 'claude-code' });
    const bad = validateNew({ name: 'managed', agent: 'hermes', baseUrl: 'ftp://x', apiKey: 'short' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['apiKey', 'baseUrl', 'name']);
    expect(validateNew({ name: 'a', agent: 'hermes', baseUrl: 'https://u:p@h.example', apiKey: 'secret-key-1' }).ok).toBe(false);
  });
  it('sends only what changed on edit', () => {
    const cur = { baseUrl: 'https://h.example', agent: 'hermes' as const };
    expect(validateEdit(cur, { baseUrl: 'https://h.example', agent: 'hermes', apiKey: '' })).toMatchObject({ ok: true, changed: false });
    const r = validateEdit(cur, { baseUrl: 'https://h.example', agent: 'codex', apiKey: '' });
    expect(r.ok && r.body).toEqual({ agent: 'codex' });
    expect(validateEdit(cur, { baseUrl: 'https://h.example', agent: 'hermes', apiKey: 'abc' }).ok).toBe(false);
  });
  it('asks for a confirm only when Hermes becomes a command-line agent', () => {
    expect(bridgeSwitchWarning('hermes', 'claude-code', 'https://b.example')).toMatch(/one-run MCP token.*agent bridge/);
    expect(bridgeSwitchWarning('hermes', 'codex', '')).toMatch(/agent bridge/);
    expect(bridgeSwitchWarning('claude-code', 'codex', 'https://b.example')).toBeNull();
    expect(bridgeSwitchWarning('codex', 'hermes', 'https://b.example')).toBeNull();
    expect(bridgeSwitchWarning('hermes', 'hermes', 'https://b.example')).toBeNull();
  });
  it('lists the bots placed on a connection and nothing else', () => {
    const bots = [bot('a', { connection: 'ours', profile: 'a' }), bot('b', { connection: 'managed' }), bot('c')];
    expect(botsOnConnection(bots, 'ours').map((b) => b.slug)).toEqual(['a']);
    expect(botsOnConnection(bots, 'none')).toEqual([]);
  });
  it('words the status', () => {
    expect(statusLine({ status: 'unknown', lastCheckedAt: null, lastError: null })).toBe('Not checked yet');
    expect(statusLine({ status: 'error', lastCheckedAt: 'x', lastError: 'y' })).toBe('Not working');
  });
});

describe('mock connections', () => {
  it('lists the team pod, adds, tests and removes a connection', async () => {
    setTransport(createMockTransport({ latencyMs: 0 }));
    await import('../src/api/endpoints').then((m) => m.fetchSession());
    expect((await fetchConnections('engineering')).items.map((c) => c.name)).toEqual(['managed']);
    const { connection } = await createConnection('engineering', { name: 'bridge', baseUrl: 'http://localhost:8650', apiKey: 'secret-key-1', agent: 'codex' });
    expect(connection.agent).toBe('codex');
    expect((await testConnection('engineering', connection.id)).ok).toBe(true);
    await deleteConnection('engineering', connection.id);
    expect((await fetchConnections('engineering')).items).toHaveLength(1);
  });
});
