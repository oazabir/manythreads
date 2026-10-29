import { describe, expect, it } from 'vitest';
import { parseMarkup } from '@manythreads/shared';
import { adapt, parseBody } from '../src/adapters/index.ts';
import type { Adapted } from '../src/adapters/index.ts';

const call = (json: unknown, headers: Record<string, string> = {}, contentType = 'application/json'): Adapted =>
  adapt({ headers, contentType, raw: typeof json === 'string' ? json : JSON.stringify(json), json: typeof json === 'string' ? undefined : json });
const posted = (r: Adapted): string => {
  expect(r.kind, JSON.stringify(r)).toBe('post');
  return r.kind === 'post' ? r.text : '';
};
const gh = (event: string, payload: unknown): Adapted => call(payload, { 'x-github-event': event });

describe('generic JSON', () => {
  it('shows text, title, link, status and fields', () => {
    const text = posted(call({ text: 'Build finished', title: 'CI', url: 'https://ci.example.com/run/1', status: 'success', fields: [{ title: 'Branch', value: 'main' }, { title: 'Time', value: '4m' }] }));
    expect(text).toContain('Build finished');
    expect(text).toContain('CI');
    expect(text).toContain('](https://ci.example.com/run/1)');
    expect(text).toContain('Branch');
    expect(text).toContain('main');
  });
  it('marks failure and success differently', () => {
    const bad = posted(call({ text: 'x', status: 'failed' }));
    const good = posted(call({ text: 'x', status: 'success' }));
    expect(bad).not.toBe(good);
  });
  it('reads a Slack shaped call with attachments', () => {
    const text = posted(call({ text: '*Deploy* done <https://example.com/d|details>', attachments: [{ color: 'danger', title: 'Error', text: 'boom', fields: [{ title: 'Env', value: 'prod', short: true }] }] }));
    expect(text).toContain('Deploy');
    expect(text).toContain('](https://example.com/d)');
    expect(text).toContain('boom');
    expect(text).toContain('prod');
  });
  it('shows an object with no text as received, so nothing is lost', () => {
    const text = posted(call({ weird: 1 }));
    expect(text).toContain('```json');
    expect(text).toContain('weird');
  });
  it('posts plain text as is', () => {
    expect(posted(call('hello from cron\n', {}, 'text/plain'))).toBe('hello from cron');
  });
  it('refuses an empty body', () => {
    expect(call('   ', {}, 'text/plain').kind).toBe('reject');
  });
  it('reads a form with a payload field', () => {
    const body = `payload=${encodeURIComponent(JSON.stringify({ text: 'from a form' }))}`;
    expect(parseBody('application/x-www-form-urlencoded', body)).toEqual({ text: 'from a form' });
  });
  it('parseBody never throws', () => {
    expect(parseBody('application/json', '{broken')).toBeUndefined();
    expect(parseBody('text/plain', 'hi')).toBeUndefined();
  });
});

describe('safety of untrusted text', () => {
  it('leaves no mention for the platform parser to find, in any script, in every kind of call', () => {
    const hostile = 'hi @everyone @here @channel @omar @éric @عمر @Иван @_x @9 and email a@b.co';
    const texts = [
      posted(call({ text: hostile, title: hostile, fields: [{ title: hostile, value: hostile }], attachments: [{ text: hostile, pretext: hostile }] })),
      posted(call(hostile, {}, 'text/plain')),
      posted(call({ text: '<!here> <!channel> <@U1|@omar>' })),
      posted(gh('issues', { action: 'opened', issue: { number: 1, title: hostile, body: hostile, html_url: 'https://github.com/kahf/app/issues/1' }, repository: { full_name: hostile }, sender: { login: hostile } })),
      posted(call({ version: '4', alerts: [{ status: 'firing', labels: { alertname: hostile }, annotations: { summary: hostile } }] })),
    ];
    for (const t of texts) expect(parseMarkup(t).mentions, t).toEqual([]);
  });
  it('answers a payload nested too deeply to print with a refusal, not a crash', () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    expect(adapt({ headers: {}, contentType: 'application/json', raw: deep, json: parseBody('application/json', deep) }).kind).toBe('reject');
  });
  it('breaks mentions so a sender cannot ping people', () => {
    const text = posted(call({ text: 'hi @everyone and @omar' }));
    expect(text).not.toMatch(/@(?=[A-Za-z])/);
    expect(text).toContain('everyone');
  });
  it('strips raw HTML and scripts', () => {
    const text = posted(call({ text: 'ok <script>alert(1)</script><img src=x onerror=alert(1)> done' }));
    expect(text).not.toMatch(/<script|<img|onerror=alert/i);
    expect(text).toContain('done');
  });
  it('drops control and direction-override characters', () => {
    const text = posted(call({ text: 'a\u0000b‮c\u0007d' }));
    // eslint-disable-next-line no-control-regex -- the test is that control characters are gone
    expect(text).not.toMatch(/[\u0000\u0007‮]/);
  });
  it('does not make links from javascript: or credentialed addresses', () => {
    const t1 = posted(call({ text: 'x', url: 'javascript:alert(1)' }));
    expect(t1).not.toContain('javascript:');
    const t2 = posted(call({ text: 'x', url: 'https://user:pw@example.com/a' }));
    expect(t2).not.toContain('user:pw');
  });
  it('caps the length of a message', () => {
    const text = posted(call({ text: 'a'.repeat(200_000) }));
    expect(text.length).toBeLessThanOrEqual(8_100);
  });
  it('stays linear on hostile 1 MB inputs', () => {
    const inputs = ['<'.repeat(1_000_000), '<a '.repeat(300_000), '`'.repeat(1_000_000), '@a'.repeat(500_000), '['.repeat(1_000_000), '<!'.repeat(500_000)];
    for (const input of inputs) {
      const t0 = performance.now();
      call({ text: input, title: input, fields: [{ title: input, value: input }] });
      call(input, {}, 'text/plain');
      expect(performance.now() - t0).toBeLessThan(2_000);
    }
  });
});

describe('GitHub', () => {
  const repo = { full_name: 'kahf/app', html_url: 'https://github.com/kahf/app' };
  const sender = { login: 'octo' };
  it('push', () => {
    const text = posted(gh('push', { ref: 'refs/heads/main', repository: repo, sender, pusher: { name: 'octo' }, compare: 'https://github.com/kahf/app/compare/a...b', commits: [{ id: 'abcdef1234567', message: 'Fix the loader\n\nlong', url: 'https://github.com/kahf/app/commit/abcdef1', author: { name: 'Octo' } }] }));
    expect(text).toContain('kahf/app');
    expect(text).toContain('main');
    expect(text).toContain('Fix the loader');
  });
  it('pull request opened, merged, review requested', () => {
    const pr = { number: 7, title: 'Add hooks', html_url: 'https://github.com/kahf/app/pull/7', user: sender, merged: false, head: { ref: 'f' }, base: { ref: 'main' } };
    expect(posted(gh('pull_request', { action: 'opened', pull_request: pr, repository: repo, sender }))).toContain('Add hooks');
    const merged = posted(gh('pull_request', { action: 'closed', pull_request: { ...pr, merged: true }, repository: repo, sender }));
    expect(merged.toLowerCase()).toContain('merged');
    const review = posted(gh('pull_request', { action: 'review_requested', requested_reviewer: { login: 'nadia' }, pull_request: pr, repository: repo, sender }));
    expect(review).toContain('nadia');
  });
  it('issues opened and closed', () => {
    const issue = { number: 3, title: 'Crash', html_url: 'https://github.com/kahf/app/issues/3', user: sender };
    expect(posted(gh('issues', { action: 'opened', issue, repository: repo, sender }))).toContain('Crash');
    expect(posted(gh('issues', { action: 'closed', issue, repository: repo, sender }))).toContain('Crash');
  });
  it('workflow run succeeded and failed read differently', () => {
    const run = (conclusion: string): unknown => ({ action: 'completed', workflow_run: { name: 'CI', conclusion, html_url: 'https://github.com/kahf/app/actions/runs/1', head_branch: 'main', head_sha: 'abcdef1234', run_number: 12 }, repository: repo, sender });
    const ok = posted(gh('workflow_run', run('success')));
    const bad = posted(gh('workflow_run', run('failure')));
    expect(ok).toContain('CI');
    expect(bad).toContain('CI');
    expect(ok).not.toBe(bad);
  });
  it('check run and release', () => {
    expect(posted(gh('check_run', { action: 'completed', check_run: { name: 'lint', conclusion: 'failure', html_url: 'https://github.com/kahf/app/runs/1', head_sha: 'abcdef1234' }, repository: repo, sender }))).toContain('lint');
    expect(posted(gh('release', { action: 'published', release: { tag_name: 'v1.2.0', name: 'One two', html_url: 'https://github.com/kahf/app/releases/tag/v1.2.0', body: 'Notes' }, repository: repo, sender }))).toContain('v1.2.0');
  });
  it('ping and unknown events are ignored with a reason, not an error', () => {
    const ping = gh('ping', { zen: 'x', hook_id: 1, repository: repo });
    expect(ping.kind).toBe('ignore');
    const star = gh('star', { action: 'created', repository: repo });
    expect(star.kind).toBe('ignore');
    if (star.kind === 'ignore') expect(star.reason).toContain('star');
  });
  it('names in untrusted fields cannot ping or inject', () => {
    const text = posted(gh('issues', { action: 'opened', issue: { number: 1, title: '@everyone <b>hi</b> `x`', html_url: 'https://github.com/kahf/app/issues/1', user: sender }, repository: repo, sender }));
    expect(text).not.toMatch(/@(?=[A-Za-z])/);
    expect(text).not.toContain('<b>');
  });
  it('rejects a GitHub call whose body is not JSON', () => {
    expect(adapt({ headers: { 'x-github-event': 'push' }, contentType: 'text/plain', raw: 'nope', json: undefined }).kind).toBe('reject');
  });
});

describe('GitLab', () => {
  const h = (e: string): Record<string, string> => ({ 'x-gitlab-event': e });
  it('push, merge request, pipeline, issue', () => {
    const project = { path_with_namespace: 'kahf/app', web_url: 'https://gitlab.com/kahf/app' };
    expect(posted(call({ object_kind: 'push', ref: 'refs/heads/main', user_name: 'Octo', project, total_commits_count: 1, commits: [{ id: 'abc1234', message: 'Fix', url: 'https://gitlab.com/kahf/app/-/commit/abc1234' }] }, h('Push Hook')))).toContain('kahf/app');
    expect(posted(call({ object_kind: 'merge_request', user: { name: 'Octo' }, project, object_attributes: { iid: 4, title: 'Add', action: 'open', url: 'https://gitlab.com/kahf/app/-/merge_requests/4', source_branch: 'f', target_branch: 'main' } }, h('Merge Request Hook')))).toContain('Add');
    expect(posted(call({ object_kind: 'pipeline', user: { name: 'Octo' }, project, object_attributes: { id: 9, status: 'failed', ref: 'main', url: 'https://gitlab.com/kahf/app/-/pipelines/9' } }, h('Pipeline Hook')))).toContain('main');
    expect(posted(call({ object_kind: 'issue', user: { name: 'Octo' }, project, object_attributes: { iid: 2, title: 'Bug', action: 'open', url: 'https://gitlab.com/kahf/app/-/issues/2' } }, h('Issue Hook')))).toContain('Bug');
  });
});

describe('alert managers', () => {
  it('Alertmanager', () => {
    const text = posted(call({ version: '4', status: 'firing', receiver: 'x', groupLabels: { alertname: 'HighCpu' }, commonLabels: { severity: 'critical' }, externalURL: 'https://am.example.com', alerts: [{ status: 'firing', labels: { alertname: 'HighCpu', instance: 'web-1', severity: 'critical' }, annotations: { summary: 'CPU is above 90%' }, generatorURL: 'https://prom.example.com/graph' }] }));
    expect(text).toContain('HighCpu');
    expect(text).toContain('CPU is above 90%');
  });
  it('Alertmanager resolved reads differently from firing', () => {
    const body = (status: string): unknown => ({ version: '4', status, groupLabels: { alertname: 'A' }, alerts: [{ status, labels: { alertname: 'A' }, annotations: {} }] });
    expect(posted(call(body('firing')))).not.toBe(posted(call(body('resolved'))));
  });
  it('Sentry issue alert', () => {
    const text = posted(call({ action: 'created', data: { issue: { title: 'TypeError: x is undefined', web_url: 'https://sentry.example.com/issues/1', level: 'error', project: { slug: 'web' } } } }, { 'sentry-hook-resource': 'issue' }));
    expect(text).toContain('TypeError');
  });
});

describe('plain text', () => {
  it('breaks mentions in a plain text call too', () => {
    const r = call('deploy done @everyone', {}, 'text/plain');
    expect(posted(r)).not.toMatch(/@(?=[A-Za-z])/);
  });
});
