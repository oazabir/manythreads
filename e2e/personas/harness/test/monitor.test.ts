import { describe, expect, it } from 'vitest';
import { judge, type PageProblem } from '../monitor.ts';

const resp = (status: number, url = 'http://x/api/a'): PageProblem => ({ kind: 'response', text: `GET ${url} answered ${status}`, url, status });

describe('judge', () => {
  it('a clean screen has no problems', () => {
    expect(judge([], undefined)).toEqual([]);
  });

  it('a console error, a page error, a failed request and a 4xx/5xx each fail a normal step', () => {
    const out = judge(
      [
        { kind: 'console', text: 'Uncaught Error' },
        { kind: 'pageerror', text: 'x is not a function' },
        { kind: 'requestfailed', text: 'GET http://x/y net::ERR_CONNECTION_REFUSED' },
        resp(500),
      ],
      undefined,
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toMatch(/^console: /);
  });

  it('a denial step passes only when the server answered the status it expects', () => {
    expect(judge([resp(403)], 403)).toEqual([]);
    expect(judge([], 403)[0]).toMatch(/expects the server to answer 403, and nothing did/);
    expect(judge([resp(500)], 403)[0]).toMatch(/saw: GET .* answered 500/);
  });

  it('a denial step relaxes the console and request checks (the browser logs the refusal)', () => {
    expect(judge([resp(403), { kind: 'console', text: 'Failed to load resource: 403' }], 403)).toEqual([]);
  });
});
