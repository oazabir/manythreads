import { connectorEntry } from '@manythreads/shared';
import { startFakeTrackers, type FakeTrackerId, type FakeTrackers } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inputProblem } from '../src/index.ts';
import { ProviderError, type ApiInit, type ProviderApi } from '../src/oauth/api.ts';
import { endpointsFor } from '../src/oauth/providers.ts';
import { PERSON_TOOL_DEFS, personToolDef } from '../src/person-tools.ts';
import { adfToText, textToAdf } from '../src/tracker-kit.ts';
import { TRACKER_TOOLS } from '../src/tracker-tools.ts';

// P16-06: the work-tracker tools (Jira, Linear, GitHub Issues, Asana) against the fake trackers of test-utils (a local HTTP server; no real network, no database). The
// sign-in is done the way the plugin does it (consent, code, token); the tools then run through a ProviderApi that sends the real requests. The same tools run through the
// gateway, with the approval card, in tracker.test.ts.

const REDIRECT = 'http://site.invalid/cb';
let fake: FakeTrackers;

async function tokenFor(tracker: FakeTrackerId): Promise<string> {
  const upper = tracker.toUpperCase();
  const authorize = endpointsFor(tracker, fake.env()).authorizeUrl;
  const consent = await fetch(`${authorize}?${new URLSearchParams({ client_id: fake.clientId, redirect_uri: REDIRECT, response_type: 'code', state: 's', ...(tracker === 'jira' ? { scope: 'offline_access read:jira-work write:jira-work' } : {}) })}`, { redirect: 'manual' });
  const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
  const tokenUrl = endpointsFor(tracker, { [`MANYTHREADS_OAUTH_${upper}_FAKE_BASE`]: fake.url }).tokenUrl;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: fake.clientId, client_secret: fake.clientSecret }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/** A ProviderApi that sends what a tool asks to the fake tracker, like api.ts does (a status that is not 2xx is a ProviderError with our words). */
async function apiFor(tracker: FakeTrackerId): Promise<ProviderApi> {
  const token = await tokenFor(tracker);
  const base = endpointsFor(tracker, { [`MANYTHREADS_OAUTH_${tracker.toUpperCase()}_FAKE_BASE`]: fake.url }).apiBase;
  const send = async (path: string, init: ApiInit = {}): Promise<Response> => {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw new ProviderError(res.status, `the tracker answered ${String(res.status)}`);
    return res;
  };
  return {
    now: () => new Date('2026-11-03T08:00:00Z'),
    async json(path, init) {
      const res = await send(path, init);
      return res.status === 204 ? {} : res.json();
    },
    async text(path, init) {
      return { text: await (await send(path, init)).text(), truncated: false };
    },
  };
}

const run = (name: string, api: ProviderApi, input: Record<string, unknown>): Promise<Record<string, unknown>> => personToolDef(name)!.run(api, input) as Promise<Record<string, unknown>>;
const defs = (provider: string) => PERSON_TOOL_DEFS.filter((t) => t.provider === provider);

beforeAll(async () => {
  fake = await startFakeTrackers({ accounts: ['person@kahf.example'] });
});
afterAll(async () => {
  await fake?.stop();
});

describe('the catalog and the tools agree', () => {
  for (const id of ['jira', 'linear', 'githubissues', 'asana'] as const) {
    it(`${id}: every tool the catalog offers is built, under its service, with the access the catalog says; nothing else is built; nothing destructive`, () => {
      const entry = connectorEntry(id)!;
      expect(entry.status).toBe('available');
      const offered = entry.tools.filter((t) => t.available && !t.destructive);
      for (const t of offered) {
        const d = personToolDef(t.name);
        expect(d, t.name).toBeDefined();
        expect(d!.provider, t.name).toBe(id);
        expect(d!.kind, t.name).toBe(t.access);
        expect(d!.service, t.name).toBe(t.service);
        expect(entry.services.find((s) => s.id === t.service)?.available, t.name).toBe(true);
      }
      expect(new Set(defs(id).map((d) => d.name))).toEqual(new Set(offered.map((t) => t.name)));
      for (const t of entry.tools.filter((x) => x.destructive)) expect(personToolDef(t.name), t.name).toBeUndefined();
    });
  }

  it('every tool that writes has a card and every tool that reads has none; each tracker offers search, read, create, comment and change status', () => {
    for (const t of TRACKER_TOOLS) expect(t.card !== undefined, t.name).toBe(t.kind === 'write');
    for (const id of ['jira', 'linear', 'githubissues', 'asana'] as const) {
      expect(defs(id).filter((d) => d.kind === 'read')).toHaveLength(2);
      expect(defs(id).filter((d) => d.kind === 'write')).toHaveLength(3);
    }
  });

  it('a write service lists the read scopes it needs, so a tool never runs with a scope the person did not give', () => {
    for (const [id, write] of [['jira', 'issues_write'], ['linear', 'issues_write'], ['asana', 'tasks_write']] as const) {
      const entry = connectorEntry(id)!;
      const read = entry.services.find((s) => s.available && !s.id.endsWith('_write'))!;
      const w = entry.services.find((s) => s.id === write)!;
      for (const scope of read.scopes) expect(w.scopes, `${id} ${scope}`).toContain(scope);
    }
  });
});

describe('what the model may pass (ids are matched whole, in the tracker’s own shape)', () => {
  it('Jira keys: capital project key, a number; no path, no dots, no lower case', () => {
    expect(inputProblem('jira.read_issue', { key: 'ENG-101' })).toBeNull();
    for (const key of ['eng-101', 'ENG-0', 'ENG-', '..', '.', 'ENG-1/../x', 'ENG-1?x=1', 'ENG-1#', 'ENG-1 ', 'A-1', 'ENG-1234567890', '../ENG-1']) {
      expect(inputProblem('jira.read_issue', { key }), key).toMatch(/^key:/);
    }
    expect(inputProblem('jira.create_issue', { project: 'ENG', title: 'x', type: 'Bug' })).toBeNull();
    expect(inputProblem('jira.create_issue', { project: 'eng', title: 'x' })).toMatch(/^project:/);
    expect(inputProblem('jira.create_issue', { project: 'ENG', title: 'x', type: 'Bug"}' })).toMatch(/^type:/);
  });

  it('Linear issues: ENG-12 or an id; team keys in capitals', () => {
    expect(inputProblem('linear.read_issue', { issue: 'ENG-7' })).toBeNull();
    expect(inputProblem('linear.read_issue', { issue: '9b2e0000-0000-4000-8000-00000000a101' })).toBeNull();
    for (const issue of ['..', 'eng-7', 'ENG-7/x', 'ENG-0', '9b2e0000-0000-4000-8000-00000000a10', '"} ) { x']) expect(inputProblem('linear.read_issue', { issue }), issue).toMatch(/^issue:/);
    expect(inputProblem('linear.create_issue', { team: 'eng', title: 'x' })).toMatch(/^team:/);
  });

  it('GitHub repositories: owner/name, never a name of only dots, never a deeper path; numbers are positive integers', () => {
    expect(inputProblem('github_issues.read_issue', { repo: 'acme/widgets', number: 12 })).toBeNull();
    expect(inputProblem('github_issues.read_issue', { repo: 'acme/my.repo_1-x', number: 12 })).toBeNull();
    for (const repo of ['acme/..', 'acme/.', 'acme/...', '../widgets', 'acme/widgets/issues', 'acme', '/acme/widgets', 'acme/wid gets', 'acme/widgets?x=1', '-acme/widgets', 'acme/widgets#1']) {
      expect(inputProblem('github_issues.read_issue', { repo, number: 1 }), repo).toMatch(/^repo:/);
    }
    for (const number of [0, -1, 1.5, '12', '12/../x', 1e12]) expect(inputProblem('github_issues.read_issue', { repo: 'acme/widgets', number }), String(number)).toMatch(/^number:/);
    expect(inputProblem('github_issues.change_status', { repo: 'acme/widgets', number: 1, status: 'open', reason: 'completed' })).toMatch(/a reason only goes with closing/);
    expect(inputProblem('github_issues.change_status', { repo: 'acme/widgets', number: 1, status: 'deleted' })).toMatch(/^status:/);
  });

  it('Asana ids are digits only', () => {
    expect(inputProblem('asana.read_task', { taskId: '5001' })).toBeNull();
    for (const taskId of ['..', '5001/../x', 'abc', '', '5001?x', '1'.repeat(21)]) expect(inputProblem('asana.read_task', { taskId }), taskId).toMatch(/^taskId:/);
    expect(inputProblem('asana.comment', { taskId: '5001', text: 'ok' })).toBeNull();
  });

  it('text: a title is one line, a NUL is refused with the field named, sizes are bounded, and no tool takes a field it does not name', () => {
    expect(inputProblem('jira.create_issue', { project: 'ENG', title: 'a\nb' })).toMatch(/^title:/);
    expect(inputProblem('linear.create_issue', { team: 'ENG', title: 'a\u0000b' })).toMatch(/^title:.*null character/);
    expect(inputProblem('github_issues.comment', { repo: 'a/b', number: 1, text: 'x'.repeat(4001) })).toMatch(/^text:/);
    expect(inputProblem('github_issues.comment', { repo: 'a/b', number: 1, text: '' })).toMatch(/^text:/);
    expect(inputProblem('asana.create_task', { title: 'x', assignee: 'someone' })).toMatch(/unexpected field “assignee”/);
    expect(inputProblem('jira.search_issues', { query: 'x'.repeat(201) })).toMatch(/^query:/);
    expect(inputProblem('jira.change_status', { key: 'ENG-1', status: 'Done\nNow' })).toMatch(/^status:/);
  });
});

describe('Atlassian documents', () => {
  it('flatten to lines, bounded in depth and size, and plain text becomes paragraphs', () => {
    expect(adfToText(textToAdf('First line\n\nSecond <b>line</b>'))).toBe('First line\n\nSecond <b>line</b>');
    let deep: Record<string, unknown> = { type: 'text', text: 'deep' };
    for (let i = 0; i < 100; i++) deep = { type: 'bulletList', content: [deep] };
    expect(adfToText(deep)).toBe('');
    expect(adfToText(textToAdf('x'.repeat(30_000)), 1000).length).toBeLessThanOrEqual(1000);
    expect(adfToText('not a document')).toBe('');
  });
});

describe('Jira', () => {
  let api: ProviderApi;
  beforeAll(async () => {
    api = await apiFor('jira');
  });

  it('searches by words and by key, and reads an issue with its description and comments as plain text', async () => {
    const found = await run('jira.search_issues', api, { query: 'login page' });
    expect(found['issues']).toEqual([expect.objectContaining({ key: 'ENG-101', title: 'Login page times out', status: 'To Do', type: 'Bug', assignee: 'Nadia Karim', link: `${fake.url}/jira-site/browse/ENG-101` })]);
    expect(((await run('jira.search_issues', api, { query: 'eng-102' }))['issues'] as unknown[]).length).toBe(1);
    expect(fake.searches.at(-1)!.query).toBe('key = "ENG-102" ORDER BY updated DESC');
    expect(((await run('jira.search_issues', api, { query: 'dark', project: 'OPS' }))['issues'] as unknown[]).length).toBe(0);
    const read = await run('jira.read_issue', api, { key: 'ENG-101' });
    expect(read).toMatchObject({ ok: true, key: 'ENG-101', description: 'Users on slow networks see a blank page after 30 seconds.', reporter: 'Omar Azabir', comments: [{ author: 'Rafi Hasan', text: 'Reproduced on staging.' }] });
  });

  it('the words cannot become part of the query: quotes, backslashes and query operators are turned to spaces', async () => {
    await run('jira.search_issues', api, { query: 'x" OR project = SECRET OR text ~ "y' });
    const jql = fake.searches.at(-1)!.query;
    expect(jql).toBe('text ~ "x OR project SECRET OR text y" ORDER BY updated DESC');
    expect(jql.match(/"/g)).toHaveLength(2);
    expect(await run('jira.search_issues', api, { query: '"" \\ ()' })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('creates, comments and moves, each once, as the person', async () => {
    const before = fake.writes.length;
    const made = await run('jira.create_issue', api, { project: 'ENG', title: 'Rate limit the export', description: 'Cap it at 5 a minute.\n\nSecond paragraph.', type: 'Task' });
    expect(made).toMatchObject({ ok: true, key: expect.stringMatching(/^ENG-\d+$/) });
    expect(fake.data.jira.issues.find((i) => i.key === made['key'])).toMatchObject({ summary: 'Rate limit the export', description: 'Cap it at 5 a minute.\n\nSecond paragraph.', type: 'Task' });
    expect(await run('jira.comment', api, { key: 'ENG-101', text: 'On it.' })).toMatchObject({ ok: true, key: 'ENG-101' });
    expect(fake.data.jira.issues[0]!.comments.at(-1)).toEqual({ author: 'person@kahf.example', text: 'On it.' });
    expect(await run('jira.change_status', api, { key: 'ENG-101', status: 'in progress' })).toMatchObject({ ok: true, status: 'In Progress' });
    expect(await run('jira.change_status', api, { key: 'ENG-101', status: 'Done' })).toMatchObject({ ok: true, status: 'Done' });
    expect(fake.writes.slice(before).map((w) => [w.kind, w.target])).toEqual([['create', made['key']], ['comment', 'ENG-101'], ['status', 'ENG-101'], ['status', 'ENG-101']]);
  });

  it('a status the workflow does not allow lists the ones that are allowed, changes nothing and quotes nothing of the issue', async () => {
    const before = fake.writes.length;
    const answer = await run('jira.change_status', api, { key: 'ENG-102', status: 'Teleported' });
    expect(answer).toMatchObject({ ok: false, code: 'unknown_status', statuses: ['To Do', 'Done'] });
    expect(JSON.stringify(answer)).not.toContain('dark mode');
    expect(fake.writes).toHaveLength(before);
  });

  it('an issue that is not there is a failure with our words, not the issue’s', async () => {
    const err = await run('jira.read_issue', api, { key: 'ENG-999' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(404);
  });
});

describe('Linear', () => {
  let api: ProviderApi;
  beforeAll(async () => {
    api = await apiFor('linear');
  });

  it('searches, and reads by identifier with the description and comments', async () => {
    expect((await run('linear.search_issues', api, { query: 'export' }))['issues']).toEqual([expect.objectContaining({ identifier: 'ENG-7', title: 'Export fails for large boards', status: 'Todo', assignee: 'Priya Rao', team: 'ENG' })]);
    expect(await run('linear.read_issue', api, { issue: 'ENG-7' })).toMatchObject({ ok: true, identifier: 'ENG-7', description: 'The CSV export stops at 10 000 cards.', comments: [{ author: 'Omar Azabir', text: 'Seen twice this week.' }] });
    expect(await run('linear.read_issue', api, { issue: '9b2e0000-0000-4000-8000-00000000a102' })).toMatchObject({ ok: true, identifier: 'ENG-8' });
    expect((await run('linear.search_issues', api, { query: 'export', team: 'OPS' }))['issues']).toEqual([]);
  });

  it('every value the model gave travels as a GraphQL variable, never inside the text of the query', async () => {
    const hostile = 'x") { id } } mutation { issueDelete(id: "1") { success } } query($y: String!) { issues(filter: "';
    await run('linear.search_issues', api, { query: hostile, team: 'ENG' });
    await run('linear.create_issue', api, { team: 'ENG', title: hostile, description: hostile });
    await run('linear.comment', api, { issue: 'ENG-7', text: hostile });
    for (const g of fake.graphql) expect(g.query, g.query).not.toContain('issueDelete');
    expect(fake.graphql.some((g) => g.variables.includes('issueDelete'))).toBe(true);
    expect(fake.data.linear.issues.at(-1)!.title).toBe(hostile);
  });

  it('creates in a team by its key, comments, and moves by the status’s name; an unknown team or status changes nothing', async () => {
    const before = fake.writes.length;
    expect(await run('linear.create_issue', api, { team: 'ENG', title: 'Paginate the export' })).toMatchObject({ ok: true, identifier: expect.stringMatching(/^ENG-\d+$/) });
    expect(await run('linear.create_issue', api, { team: 'OPS', title: 'x' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await run('linear.comment', api, { issue: 'ENG-7', text: 'Looking.' })).toMatchObject({ ok: true });
    expect(await run('linear.change_status', api, { issue: 'ENG-7', status: 'in progress' })).toMatchObject({ ok: true, status: 'In Progress' });
    expect(fake.data.linear.issues.find((i) => i.identifier === 'ENG-7')!.state).toBe('In Progress');
    expect(await run('linear.change_status', api, { issue: 'ENG-7', status: 'Shipped' })).toMatchObject({ ok: false, code: 'unknown_status', statuses: ['Todo', 'In Progress', 'Done'] });
    expect(fake.writes.slice(before).map((w) => w.kind)).toEqual(['create', 'comment', 'status']);
  });

  it('a GraphQL failure becomes our words: no query, no variable, no message of Linear’s', async () => {
    const before = fake.writes.length;
    for (const [name, input] of [['linear.comment', { issue: 'ENG-404', text: 'secret plan' }], ['linear.read_issue', { issue: 'ENG-404' }], ['linear.change_status', { issue: 'ENG-404', status: 'Done' }]] as const) {
      const answer = await run(name, api, input);
      expect(answer, name).toMatchObject({ ok: false, code: 'not_found' });
      expect(JSON.stringify(answer), name).not.toMatch(/secret plan|ENG-404|Entity/);
    }
    expect(fake.writes).toHaveLength(before);
  });
});

describe('GitHub Issues', () => {
  let api: ProviderApi;
  beforeAll(async () => {
    api = await apiFor('githubissues');
  });

  it('searches issues only (never pull requests), in one repository or in all, and a colon in the words cannot make a qualifier', async () => {
    const all = await run('github_issues.search_issues', api, { query: 'crash' });
    expect(all['issues']).toEqual([expect.objectContaining({ repo: 'acme/widgets', number: 12, title: 'Crash when the widget list is empty', state: 'open', author: 'octocat' })]);
    expect(((await run('github_issues.search_issues', api, { query: 'colours', repo: 'acme/gadgets' }))['issues'] as unknown[]).length).toBe(1);
    expect(((await run('github_issues.search_issues', api, { query: 'colours', repo: 'acme/widgets' }))['issues'] as unknown[]).length).toBe(0);
    await run('github_issues.search_issues', api, { query: 'org:secret repo:evil/private is:pr "x"' });
    expect(fake.searches.at(-1)!.query).toBe('org secret repo evil/private is pr x is:issue');
    expect(await run('github_issues.search_issues', api, { query: ':::' })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('reads an issue with its text and comments, and says when it is a pull request', async () => {
    expect(await run('github_issues.read_issue', api, { repo: 'acme/widgets', number: 12 })).toMatchObject({ ok: true, title: 'Crash when the widget list is empty', isPullRequest: false, text: 'Steps: open the list with no widgets.', comments: [{ author: 'hubot', text: 'Confirmed.' }] });
    expect(await run('github_issues.read_issue', api, { repo: 'acme/widgets', number: 13 })).toMatchObject({ isPullRequest: true });
  });

  it('opens, comments, closes (with the reason) and reopens; the owner and name are two encoded path segments', async () => {
    const before = fake.writes.length;
    const calls = fake.calls.length;
    const made = await run('github_issues.create_issue', api, { repo: 'acme/widgets', title: 'Tooltip is cut off', text: 'On the narrow layout.' });
    expect(made).toMatchObject({ ok: true, repo: 'acme/widgets', number: expect.any(Number) });
    await run('github_issues.comment', api, { repo: 'acme/widgets', number: 12, text: 'Fix is in review.' });
    expect(await run('github_issues.change_status', api, { repo: 'acme/widgets', number: 12, status: 'closed', reason: 'not_planned' })).toMatchObject({ ok: true, state: 'closed' });
    expect(await run('github_issues.change_status', api, { repo: 'acme/widgets', number: 12, status: 'open' })).toMatchObject({ ok: true, state: 'open' });
    expect(fake.writes.slice(before).map((w) => [w.kind, w.status ?? ''])).toEqual([['create', ''], ['comment', ''], ['status', 'closed:not_planned'], ['status', 'open:reopened']]);
    expect(fake.calls.slice(calls).every((c) => /^\/github-api\/repos\/acme\/widgets\/issues(\/\d+)?(\/comments)?$/.test(c.path))).toBe(true);
  });

  it('will not close or reopen a pull request, and does not change it', async () => {
    const before = fake.writes.length;
    expect(await run('github_issues.change_status', api, { repo: 'acme/widgets', number: 13, status: 'closed' })).toMatchObject({ ok: false, code: 'is_pull_request' });
    expect(fake.writes).toHaveLength(before);
    expect(fake.data.github.issues.find((i) => i.number === 13)!.state).toBe('open');
  });
});

describe('Asana', () => {
  let api: ProviderApi;
  beforeAll(async () => {
    api = await apiFor('asana');
  });

  it('searches the only workspace by name, reads a task with its notes and comments', async () => {
    expect((await run('asana.search_tasks', api, { query: 'launch' }))['tasks']).toEqual([expect.objectContaining({ id: '5001', title: 'Prepare the launch checklist', done: false })]);
    expect(await run('asana.read_task', api, { taskId: '5001' })).toMatchObject({ ok: true, notes: 'Owners for each item.', comments: [{ author: 'Nadia Karim', text: 'Draft is in the shared folder.' }] });
  });

  it('several workspaces is a question, not a guess', async () => {
    fake.data.asana.workspaces.push({ gid: '1200', name: 'Other' });
    try {
      expect(await run('asana.search_tasks', api, { query: 'launch' })).toMatchObject({ ok: false, code: 'choose_workspace', workspaces: [{ id: '1100', name: 'Kahf' }, { id: '1200', name: 'Other' }] });
      expect((await run('asana.search_tasks', api, { query: 'launch', workspaceId: '1100' }))['tasks']).toHaveLength(1);
      expect(await run('asana.create_task', api, { title: 'x' })).toMatchObject({ code: 'choose_workspace' });
    } finally {
      fake.data.asana.workspaces.pop();
    }
  });

  it('creates, comments and marks done or open', async () => {
    const before = fake.writes.length;
    expect(await run('asana.create_task', api, { title: 'Order the badges', notes: 'Forty.' })).toMatchObject({ ok: true, id: expect.stringMatching(/^\d+$/) });
    expect(await run('asana.comment', api, { taskId: '5001', text: 'Checked.' })).toMatchObject({ ok: true });
    expect(await run('asana.change_status', api, { taskId: '5001', status: 'done' })).toMatchObject({ ok: true, done: true });
    expect(await run('asana.change_status', api, { taskId: '5001', status: 'open' })).toMatchObject({ ok: true, done: false });
    expect(fake.writes.slice(before).map((w) => [w.kind, w.status ?? ''])).toEqual([['create', ''], ['comment', ''], ['status', 'done'], ['status', 'open']]);
  });
});

describe('the cards an approver reads', () => {
  const longText = 'Please read every word. '.repeat(100);
  const inputs: Record<string, Record<string, unknown>> = {
    'jira.create_issue': { project: 'ENG', title: 'T'.repeat(250), description: longText },
    'jira.comment': { key: 'ENG-101', text: longText },
    'jira.change_status': { key: 'ENG-101', status: 'S'.repeat(60) },
    'linear.create_issue': { team: 'ENG', title: 'T'.repeat(250), description: longText },
    'linear.comment': { issue: 'ENG-7', text: longText },
    'linear.change_status': { issue: 'ENG-7', status: 'Done' },
    'github_issues.create_issue': { repo: 'acme/widgets', title: 'T'.repeat(250), text: longText },
    'github_issues.comment': { repo: 'acme/widgets', number: 12, text: longText },
    'github_issues.change_status': { repo: 'acme/widgets', number: 12, status: 'closed', reason: 'not_planned' },
    'asana.create_task': { title: 'T'.repeat(250), notes: longText, projectId: '777' },
    'asana.comment': { taskId: '5001', text: longText },
    'asana.change_status': { taskId: '5001', status: 'done' },
  };

  it('every write has a card whose summary names the tracker and the target and fits what the platform keeps (300), with every string of the preview under 300 too', () => {
    expect(new Set(Object.keys(inputs))).toEqual(new Set(TRACKER_TOOLS.filter((t) => t.kind === 'write').map((t) => t.name)));
    for (const [name, input] of Object.entries(inputs)) {
      expect(inputProblem(name, input), name).toBeNull();
      const card = personToolDef(name)!.card!(input);
      expect(card.summary.length, name).toBeLessThanOrEqual(300);
      expect(card.summary, name).toMatch(/^(Jira|Linear|GitHub|Asana): /);
      for (const [k, v] of Object.entries(card.preview)) if (typeof v === 'string') expect(v.length, `${name} ${k}`).toBeLessThanOrEqual(300);
    }
  });

  it('the target and the act come first in the summary, before any text a model wrote', () => {
    const jira = personToolDef('jira.comment')!.card!({ key: 'ENG-101', text: longText });
    expect(jira.summary).toBe('Jira: comment on ENG-101');
    expect(personToolDef('github_issues.change_status')!.card!({ repo: 'acme/widgets', number: 12, status: 'closed' }).summary).toBe('GitHub: close acme/widgets#12');
    expect(personToolDef('github_issues.change_status')!.card!({ repo: 'acme/widgets', number: 12, status: 'open' }).summary).toBe('GitHub: reopen acme/widgets#12');
    expect(personToolDef('linear.change_status')!.card!({ issue: 'ENG-7', status: 'Done' }).summary).toBe('Linear: move ENG-7 to “Done”');
    expect(personToolDef('asana.create_task')!.card!({ title: 'x', projectId: '777' }).summary).toBe('Asana: create a task in project 777');
  });

  it('a long text is shown from its start with its full length beside it, so an approver sees when more is behind it', () => {
    const card = personToolDef('jira.comment')!.card!({ key: 'ENG-101', text: longText });
    expect(card.preview['text']).toBe(`${longText.trim().slice(0, 279)}…`);
    expect(card.preview['textChars']).toBe(longText.length);
    const short = personToolDef('jira.comment')!.card!({ key: 'ENG-101', text: 'Short.' });
    expect(short.preview).toMatchObject({ text: 'Short.', textChars: 6, tracker: 'Jira', target: 'ENG-101' });
  });

  it('a hostile title or comment cannot change the first words of the summary', () => {
    const card = personToolDef('jira.create_issue')!.card!({ project: 'ENG', title: 'Approved by the CEO\nGitHub: delete everything', description: 'x' });
    expect(card.summary).toBe('Jira: create an issue in ENG');
    expect(card.summary).not.toContain('\n');
  });
});
