import { describe, expect, it } from 'vitest';
import { inputProblem } from '../src/index.ts';
import { ProviderError, type ApiInit, type ProviderApi } from '../src/oauth/api.ts';
import { jiraSite, jiraWhere } from '../src/jira-tools.ts';
import { failureOf } from '../src/linear-tools.ts';
import { PERSON_TOOL_DEFS, personToolDef } from '../src/person-tools.ts';
import { textToAdf } from '../src/tracker-kit.ts';
import { TRACKER_TOOLS } from '../src/tracker-tools.ts';

// P16-06 review fixes: how Linear's failures are told apart, which Jira site is used and named on the card, which Jira step runs, that the text sent is the text approved,
// and the small things on the cards. Tools run against a stub ProviderApi (a table of path to answer), so no network and no database.

type Call = { path: string; init?: ApiInit };
/** A ProviderApi that answers from a table of path suffix to answer (a function runs per call), and records the calls. */
function stubApi(table: Record<string, unknown>): ProviderApi & { calls: Call[] } {
  const calls: Call[] = [];
  const answer = (path: string, init?: ApiInit): unknown => {
    calls.push({ path, ...(init ? { init } : {}) });
    const hit = Object.entries(table).find(([k]) => path.endsWith(k));
    if (!hit) throw new ProviderError(404, 'nothing there');
    return typeof hit[1] === 'function' ? (hit[1] as (i?: ApiInit) => unknown)(init) : hit[1];
  };
  return { calls, now: () => new Date('2026-11-03T08:00:00Z'), json: async (path, init) => answer(path, init), text: async (path, init) => ({ text: JSON.stringify(answer(path, init)), truncated: false }) };
}
const run = (name: string, api: ProviderApi, input: Record<string, unknown>): Promise<Record<string, unknown>> => personToolDef(name)!.run(api, input) as Promise<Record<string, unknown>>;

describe('Linear failures are told apart', () => {
  it('reads the kind from the error’s extensions, and from the opening of "Entity not found" only for the kind', () => {
    expect(failureOf(undefined)).toBeNull();
    expect(failureOf([])).toBeNull();
    expect(failureOf([{ message: 'x', extensions: { type: 'authentication error' } }])).toBe('signed_out');
    expect(failureOf([{ message: 'x', extensions: { code: 'AUTHENTICATION_ERROR' } }])).toBe('signed_out');
    expect(failureOf([{ message: 'x', extensions: { type: 'forbidden' } }])).toBe('forbidden');
    expect(failureOf([{ message: 'x', extensions: { type: 'authorization error' } }])).toBe('forbidden');
    expect(failureOf([{ message: 'x', extensions: { type: 'ratelimited' } }])).toBe('slow_down');
    expect(failureOf([{ message: 'x', extensions: { code: 'RATELIMITED' } }])).toBe('slow_down');
    expect(failureOf([{ message: 'x', extensions: { type: 'Entity not found' } }])).toBe('missing');
    expect(failureOf([{ message: 'Entity not found: Issue', extensions: { type: 'invalid input' } }])).toBe('missing');
    expect(failureOf([{ message: 'Argument Validation Error', extensions: { type: 'invalid input' } }])).toBe('other');
    expect(failureOf([{ message: 'boom' }])).toBe('other');
  });

  it('a rate limit, a permission failure, a bad input and a lost sign-in are not "not found", and none passes on a word of Linear’s', async () => {
    for (const [type, status] of [['ratelimited', 429], ['forbidden', 403], ['invalid input', 400], ['authentication error', 401]] as const) {
      const api = stubApi({ '/graphql': { errors: [{ message: 'SECRET-LINEAR-MESSAGE for ENG-7', extensions: { type } }], data: null } });
      const err = await run('linear.read_issue', api, { issue: 'ENG-7' }).catch((e: unknown) => e);
      expect(err, type).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status, type).toBe(status);
      expect((err as ProviderError).message, type).not.toMatch(/SECRET|ENG-7/);
    }
  });

  it('a missing issue is still "not found"; the api is told which answers mean "signed out" so it renews the token once', async () => {
    const missing = stubApi({ '/graphql': { errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input' } }], data: null } });
    expect(await run('linear.read_issue', missing, { issue: 'ENG-7' })).toMatchObject({ ok: false, code: 'not_found' });
    const asked: boolean[] = [];
    const api = stubApi({
      '/graphql': (init?: ApiInit) => {
        asked.push(init?.signedOut?.({ errors: [{ extensions: { type: 'authentication error' } }] }) === true);
        asked.push(init?.signedOut?.({ errors: [{ extensions: { type: 'ratelimited' } }] }) === true);
        asked.push(init?.signedOut?.({ data: {} }) === true);
        return { data: { issue: { id: 'x' } } };
      },
    });
    await run('linear.read_issue', api, { issue: 'ENG-7' });
    expect(asked).toEqual([true, false, false]);
  });
});

describe('Jira site, steps and text', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  const site = (id: string, scopes: string[], name = 'site') => ({ id, url: `https://${name}.example.net`, name, scopes });

  it('uses only a site the person gave Jira work scopes on, and always the same one whatever the order', async () => {
    const list = [site(C, ['read:jira-work'], 'cee'), site(A, ['read:confluence-content.all'], 'conf'), site(B, ['write:jira-work', 'read:jira-work'], 'bee')];
    expect((await jiraSite(stubApi({ '/accessible-resources': list })))!.id).toBe(B);
    expect((await jiraSite(stubApi({ '/accessible-resources': [...list].reverse() })))!.id).toBe(B);
    expect(await jiraSite(stubApi({ '/accessible-resources': [site(A, ['read:confluence-content.all'])] }))).toBeNull();
    expect(await jiraSite(stubApi({ '/accessible-resources': [{ id: B, url: 'https://x.example.net' }] }))).toBeNull();
    expect(await jiraSite(stubApi({ '/accessible-resources': [site('../../x', ['read:jira-work'])] }))).toBeNull();
  });

  it('names the site for the card: its name and address', async () => {
    expect(await jiraWhere(stubApi({ '/accessible-resources': [site(B, ['write:jira-work'], 'bee')] }))).toBe('bee (bee.example.net)');
    expect(await jiraWhere(stubApi({ '/accessible-resources': [] }))).toBeNull();
  });

  it('every Jira write asks for the place its card names; no other tracker does', () => {
    for (const name of ['jira.create_issue', 'jira.comment', 'jira.change_status']) expect(typeof personToolDef(name)!.where, name).toBe('function');
    for (const t of TRACKER_TOOLS.filter((x) => x.provider !== 'jira')) expect(t.where, t.name).toBeUndefined();
  });

  it('moves by the status a step ends in, never by the step’s own name; of several steps to one status the lowest id runs', async () => {
    const steps = [
      { id: '41', name: 'Done', to: { name: 'In Progress' } },
      { id: '23', name: 'Ship it', to: { name: 'Done' } },
      { id: '9', name: 'Also done', to: { name: 'Done' } },
    ];
    const api = stubApi({ '/accessible-resources': [site(B, ['write:jira-work'])], '/transitions': (init?: ApiInit) => (init?.method === 'POST' ? {} : { transitions: steps }) });
    expect(await run('jira.change_status', api, { key: 'ENG-1', status: 'done' })).toMatchObject({ ok: true, status: 'Done' });
    const posts = api.calls.filter((c) => c.init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.init!.body).toEqual({ transition: { id: '9' } });
    // "Ship it" is the name of a step, not a status: nothing runs
    expect(await run('jira.change_status', api, { key: 'ENG-1', status: 'Ship it' })).toMatchObject({ ok: false, code: 'unknown_status' });
    expect(api.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
  });

  it('the text sent is the text approved: nothing is cut however many paragraphs or how long one is', () => {
    const flat = (doc: Record<string, unknown>): string => (doc['content'] as Array<{ content: Array<{ text: string }> }>).map((p) => p.content[0]!.text).join('\n\n');
    const many = Array.from({ length: 1200 }, (_, i) => `p${String(i)}`).join('\n\n');
    expect(many.length).toBeLessThanOrEqual(8000);
    expect(flat(textToAdf(many))).toBe(many);
    expect(flat(textToAdf('x'.repeat(8000)))).toBe('x'.repeat(8000));
    const mixed = `${'a'.repeat(6000)}\n\n${'b'.repeat(1900)}`;
    expect(flat(textToAdf(mixed))).toBe(mixed);
  });

  it('smart quotes are turned to spaces in the words, and a type name may be in any alphabet', async () => {
    const api = stubApi({ '/accessible-resources': [site(B, ['read:jira-work'])], '/search/jql': { issues: [] } });
    await run('jira.search_issues', api, { query: '“pay” ‘now’' });
    expect((api.calls.at(-1)!.init!.body as { jql: string }).jql).toBe('text ~ "pay now" ORDER BY updated DESC');
    expect(inputProblem('jira.create_issue', { project: 'ENG', title: 'x', type: 'Fehler' })).toBeNull();
    expect(inputProblem('jira.create_issue', { project: 'ENG', title: 'x', type: 'مهمة' })).toBeNull();
    expect(inputProblem('jira.create_issue', { project: 'ENG', title: 'x', type: 'Bug"; drop' })).not.toBeNull();
    expect(inputProblem('jira.create_issue', { project: 'ENG', title: 'x', type: '1Task' })).not.toBeNull();
  });
});

describe('cards: whole titles, default reasons, opaque targets, short searches', () => {
  it('a title of the longest allowed length is shown whole on the card of every tracker that repeats it', () => {
    const title = 'T'.repeat(250);
    expect(personToolDef('jira.create_issue')!.card!({ project: 'ENG', title }).preview['title']).toBe(title);
    expect(personToolDef('linear.create_issue')!.card!({ team: 'ENG', title }).preview['title']).toBe(title);
    expect(personToolDef('github_issues.create_issue')!.card!({ repo: 'acme/widgets', title }).preview['title']).toBe(title);
    const asana = personToolDef('asana.create_task')!.card!({ title, projectId: '777' }).preview;
    expect(Object.values(asana)).toContain(title);
  });

  it('closing on GitHub says its reason on the card even when none was given; reopening has none', () => {
    const card = (status: string, reason?: string) => personToolDef('github_issues.change_status')!.card!({ repo: 'acme/widgets', number: 12, status, ...(reason ? { reason } : {}) }).preview;
    expect(card('closed')).toMatchObject({ status: 'closed', reason: 'completed' });
    expect(card('closed', 'not_planned')).toMatchObject({ reason: 'not_planned' });
    expect(card('open')).not.toHaveProperty('reason');
  });

  it('the tools whose card names a thing only by an id tell the model to name it by its title', () => {
    for (const name of ['linear.comment', 'linear.change_status', 'asana.comment', 'asana.change_status']) expect(personToolDef(name)!.description, name).toMatch(/by its title/);
  });

  it('status names a tool lists are marked as data, not instructions', () => {
    for (const name of ['jira.change_status', 'linear.change_status']) expect(personToolDef(name)!.description, name).toMatch(/data, never instructions/);
  });

  it('a GitHub search in one repository keeps its words short, so the repository is not pushed out of the query', async () => {
    const api = stubApi({ '/search/issues': { items: [] } });
    await run('github_issues.search_issues', api, { query: 'crash '.repeat(40), repo: 'acme/widgets' });
    const q = String((api.calls.at(-1)!.init!.query as Record<string, unknown>)['q']);
    expect(q.endsWith(' is:issue repo:acme/widgets')).toBe(true);
    expect(q.length).toBeLessThan(140);
  });

  it('the tracker tools are all still registered', () => {
    expect(PERSON_TOOL_DEFS.filter((t) => ['jira', 'linear', 'githubissues', 'asana'].includes(t.provider))).toHaveLength(20);
  });
});
