import { describe, expect, it } from 'vitest';
import { stripItem as agentItem } from '../src/screens/agents/commands';
import { stripItem as projectItem } from '../src/screens/projects/commands';

/* What the status strip says for a connection and for a project (P21-18): a tone for the dot, always a word, and the address only for an admin. */

type Conn = Parameters<typeof agentItem>[0];
type Proj = Parameters<typeof projectItem>[0];
const conn = (over: Partial<Conn> = {}): Conn => ({
  id: 'c1' as Conn['id'],
  name: 'pod-one',
  agent: 'hermes',
  baseUrl: 'http://10.42.0.1:8642',
  status: 'ok',
  lastCheckedAt: '2026-11-05T10:00:00.000Z',
  lastError: null,
  ...over,
});

describe('agent strip item', () => {
  it('a working connection is green with the word Working and the time of the check', () => {
    expect(agentItem(conn(), true)).toMatchObject({ host: 'pod-one', tone: 'ok', word: 'Working', when: { label: 'last checked', iso: '2026-11-05T10:00:00.000Z' } });
  });

  it('a failing one is red and says Not working', () => {
    expect(agentItem(conn({ status: 'error', lastError: 'refused' }), true)).toMatchObject({ tone: 'bad', word: 'Not working' });
  });

  it('one never checked is quiet, says so, and has no time', () => {
    expect(agentItem(conn({ status: 'unknown', lastCheckedAt: null }), true)).toMatchObject({ tone: 'idle', word: 'Not checked yet', when: null });
  });

  it('the internal address goes to an admin only', () => {
    expect(agentItem(conn(), true).detail).toBe('http://10.42.0.1:8642');
    expect(agentItem(conn(), false).detail).toBeNull();
  });
});

const NOW = Date.parse('2026-11-06T00:00:00.000Z');
const project = (over: Partial<Proj> = {}): Proj => ({
  id: 'p1' as Proj['id'],
  name: 'manythreads',
  repoUrl: 'https://github.com/kahf/manythreads',
  pushUsername: 'octocat',
  pushCredentialSetAt: '2026-10-01T00:00:00.000Z',
  pushCredentialExpiresAt: '2027-03-01T00:00:00.000Z',
  pushCredentialStatus: 'ok',
  ...over,
});

describe('project strip item', () => {
  it('a project with a good token can send pull requests', () => {
    expect(projectItem(project(), NOW)).toMatchObject({ tone: 'ok', word: 'Can send pull requests', when: { label: 'token saved' } });
  });

  it('a project with no token says so and has no time', () => {
    expect(projectItem(project({ pushCredentialSetAt: null, pushUsername: null, pushCredentialExpiresAt: null, pushCredentialStatus: null }), NOW)).toMatchObject({ tone: 'idle', word: 'No token yet', when: null });
  });

  it('a token that expires within two weeks is amber and a refused one is red', () => {
    expect(projectItem(project({ pushCredentialExpiresAt: '2026-11-10T00:00:00.000Z' }), NOW)).toMatchObject({ tone: 'warn', word: 'Token expires soon' });
    expect(projectItem(project({ pushCredentialStatus: 'needs_replacing' }), NOW)).toMatchObject({ tone: 'bad', word: 'Token needs replacing' });
    expect(projectItem(project({ pushCredentialExpiresAt: '2026-11-01T00:00:00.000Z' }), NOW)).toMatchObject({ tone: 'bad', word: 'Token expired' });
  });
});
