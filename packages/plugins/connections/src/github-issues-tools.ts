import { z } from 'zod';
import { asArray, asRecord, enc, limit, str, untrusted, type PersonToolDef } from './person-kit.ts';
import { CARD_TITLE, commentBody, githubNumber, githubRepo, issueBody, issueTitle, linkOf, oneLine, trackerCard, words } from './tracker-kit.ts';

// The tools of a person's GitHub Issues connection (PLAN P16-06): the issues of the repositories the person can open. The repository comes as `owner/name`, matched
// whole against GitHub's own shapes (a name of only dots would climb a path) and split into two encoded path segments; the number is an integer. A pull request is an
// issue to GitHub, so the tools that change state first look at the issue and refuse a pull request: this tool does not close pull requests.

const where = (repo: string): string => {
  const [owner = '', name = ''] = repo.split('/');
  return `/repos/${enc(owner)}/${enc(name)}`;
};
const REPO_URL = /\/repos\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

const summaryOf = (n: Record<string, unknown>): Record<string, unknown> => {
  const m = REPO_URL.exec(str(n['repository_url'], 300) ?? '');
  return {
    repo: m ? `${m[1]}/${m[2]}` : null,
    number: typeof n['number'] === 'number' ? n['number'] : null,
    title: str(n['title'], 300),
    state: str(n['state'], 20),
    author: str(asRecord(n['user'])['login'], 60),
    comments: typeof n['comments'] === 'number' ? n['comments'] : null,
    updated: str(n['updated_at'], 40),
    link: linkOf(n['html_url']),
  };
};
const NOT_AN_ISSUE = { ok: false, code: 'is_pull_request', message: 'That number is a pull request, which this tool does not close or reopen.' } as const;

export const GITHUB_ISSUES_TOOLS: PersonToolDef[] = [
  {
    name: 'github_issues.search_issues',
    provider: 'githubissues',
    service: 'issues',
    kind: 'read',
    description: `Search the GitHub issues the asking person can see for the words you give, optionally in one repository (owner/name), most recently changed first; answers the repository, number, title and state of each.${untrusted}`,
    input: z.strictObject({ query: words, repo: githubRepo.optional(), limit }),
    async run(api, input) {
      const i = input as { query: string; repo?: string; limit?: number };
      const n = i.limit ?? 10;
      // a colon, quote or backslash in the words would make a search qualifier (org:, repo:, is:) of them
      const cleaned = i.query.replace(/[:"\\]/g, ' ').replace(/\s+/g, ' ').trim();
      // with a repository named the words are few (the search query holds a 256-character limit, and the repository must not be pushed out of it)
      const clean = i.repo ? cleaned.slice(0, 100).trim() : cleaned;
      if (clean === '') return { ok: false, code: 'invalid', message: 'Give words to look for.' };
      const q = `${clean} is:issue${i.repo ? ` repo:${i.repo}` : ''}`;
      const doc = asRecord(await api.json('/search/issues', { query: { q, per_page: n, sort: 'updated', order: 'desc' } }));
      return { ok: true, issues: asArray(doc['items']).slice(0, n).map((x) => summaryOf(asRecord(x))) };
    },
  },
  {
    name: 'github_issues.read_issue',
    provider: 'githubissues',
    service: 'issues',
    kind: 'read',
    description: `Read one GitHub issue by repository (owner/name) and number: title, state, author, labels, the text and the first comments.${untrusted}`,
    input: z.strictObject({ repo: githubRepo, number: githubNumber }),
    async run(api, input) {
      const base = `${where(String(input['repo']))}/issues/${String(input['number'])}`;
      const issue = asRecord(await api.json(base));
      const comments = asArray(await api.json(`${base}/comments`, { query: { per_page: 10 } })).slice(0, 10);
      const text = str(issue['body'], 20_000) ?? '';
      return {
        ok: true,
        repo: input['repo'],
        number: typeof issue['number'] === 'number' ? issue['number'] : input['number'],
        title: str(issue['title'], 300),
        state: str(issue['state'], 20),
        isPullRequest: issue['pull_request'] !== undefined,
        author: str(asRecord(issue['user'])['login'], 60),
        labels: asArray(issue['labels']).slice(0, 20).flatMap((l) => {
          const name = str(asRecord(l)['name'], 80);
          return name === null ? [] : [name];
        }),
        assignees: asArray(issue['assignees']).slice(0, 10).flatMap((a) => {
          const login = str(asRecord(a)['login'], 60);
          return login === null ? [] : [login];
        }),
        updated: str(issue['updated_at'], 40),
        link: linkOf(issue['html_url']),
        text: text.slice(0, 8000),
        textTruncated: text.length > 8000,
        comments: comments.map((c) => ({ author: str(asRecord(asRecord(c)['user'])['login'], 60), created: str(asRecord(c)['created_at'], 40), text: str(asRecord(c)['body'], 2000) })),
      };
    },
  },
  {
    name: 'github_issues.create_issue',
    provider: 'githubissues',
    service: 'issues',
    kind: 'write',
    description: "Open a GitHub issue in a repository (owner/name) the asking person can write to: a title and optionally the text. Needs the person's approval.",
    input: z.strictObject({ repo: githubRepo, title: issueTitle, text: issueBody.optional() }),
    card: (i) => trackerCard('GitHub', 'open an issue in', String(i['repo']), { title: oneLine(i['title'], CARD_TITLE) }, { text: i['text'] }),
    async run(api, input) {
      const i = input as { repo: string; title: string; text?: string };
      const doc = asRecord(await api.json(`${where(i.repo)}/issues`, { method: 'POST', body: { title: i.title, ...(i.text ? { body: i.text } : {}) } }));
      return { ok: true, repo: i.repo, number: typeof doc['number'] === 'number' ? doc['number'] : null, link: linkOf(doc['html_url']) };
    },
  },
  {
    name: 'github_issues.comment',
    provider: 'githubissues',
    service: 'issues',
    kind: 'write',
    description: "Add a comment to a GitHub issue (or the conversation of a pull request), as the asking person. Everyone who can see it can read it. Needs the person's approval.",
    input: z.strictObject({ repo: githubRepo, number: githubNumber, text: commentBody }),
    card: (i) => trackerCard('GitHub', 'comment on', `${String(i['repo'])}#${String(i['number'])}`, {}, { text: i['text'] }),
    async run(api, input) {
      const doc = asRecord(await api.json(`${where(String(input['repo']))}/issues/${String(input['number'])}/comments`, { method: 'POST', body: { body: String(input['text']) } }));
      return { ok: true, repo: input['repo'], number: input['number'], link: linkOf(doc['html_url']) };
    },
  },
  {
    name: 'github_issues.change_status',
    provider: 'githubissues',
    service: 'issues',
    kind: 'write',
    description: "Close a GitHub issue (as done, or as not planned) or open it again. It does not touch pull requests. Needs the person's approval.",
    input: z
      .strictObject({ repo: githubRepo, number: githubNumber, status: z.enum(['open', 'closed']), reason: z.enum(['completed', 'not_planned']).describe('Why it is closed (default: completed).').optional() })
      .refine((v) => v.reason === undefined || v.status === 'closed', { message: 'a reason only goes with closing', path: ['reason'] }),
    card: (i) => trackerCard('GitHub', i['status'] === 'closed' ? 'close' : 'reopen', `${String(i['repo'])}#${String(i['number'])}`, { status: i['status'], ...(i['status'] === 'closed' ? { reason: i['reason'] ?? 'completed' } : {}) }),
    async run(api, input) {
      const i = input as { repo: string; number: number; status: 'open' | 'closed'; reason?: 'completed' | 'not_planned' };
      const base = `${where(i.repo)}/issues/${String(i.number)}`;
      const current = asRecord(await api.json(base));
      if (current['pull_request'] !== undefined) return NOT_AN_ISSUE;
      const doc = asRecord(await api.json(base, { method: 'PATCH', body: i.status === 'closed' ? { state: 'closed', state_reason: i.reason ?? 'completed' } : { state: 'open', state_reason: 'reopened' } }));
      return { ok: true, repo: i.repo, number: i.number, state: str(doc['state'], 20), link: linkOf(doc['html_url']) };
    },
  },
];
