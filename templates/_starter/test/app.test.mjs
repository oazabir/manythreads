// The starter app's own test (node:test, no dependencies): `node --test`.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeServer, teamName } from '../server.mjs';

describe('starter app', () => {
  let server;
  let base;
  before(async () => {
    server = makeServer({ TEAM_NAME: 'Engineering' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  it('shows its page with the team name', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<h1>Starter app<\/h1>/);
    assert.match(html, /Engineering/);
  });

  it('answers its health check', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok\n');
  });

  it('refuses what it does not serve', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  });

  it('has a default team name', () => {
    assert.equal(teamName({}), 'your team');
    assert.equal(teamName({ TEAM_NAME: '  ' }), 'your team');
  });
});
