import { SEED_CONNECTORS, personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';
import { fake } from '../../connections/support.ts';
import type { APIRequestContext } from '@playwright/test';

/*
 * The team rule for documents from a connected app (PLAN P16-08, decision D14) at the API, on seed v16: Omar's Drive folder "Engineering handbook" is a source of the Engineering base
 * `handbook`; "On-call guide" is public, "Design review notes" is shared with Nadia alone. The stand-in's permission control (PUT /__fake/drive/:id/permissions) changes who may open a
 * document, and each step presses Read again and waits for the base to settle. Covered: a group share and another domain's share are "not everyone" and stay out; a document whose access is
 * narrowed later is removed on the next read and counted; a public link brings it in; what is left out is counted and never named; a disconnected sign-in pauses the source.
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'connectors', MANYTHREADS_STACK_API_ONLY: '1' });
test.describe.configure({ mode: 'serial' });

const { omar, priya } = personas;
const H = SEED_CONNECTORS.handbook;
const as = (p: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }) });

interface Detail {
  documents: Array<{ name: string }>;
  sources: Array<{ kind: string; status?: string; skippedLimited?: number }>;
}

async function detail(request: APIRequestContext): Promise<Detail> {
  const res = await request.get(`/api/teams/${H.team}/knowledge/${H.base}`, { headers: as(omar) });
  expect(res.status()).toBe(200);
  return (await res.json()) as Detail;
}

/** Reads the folder again and waits until the base shows `documents` document names and `skipped` left out. */
async function readAgain(request: APIRequestContext, documents: string[], skipped: number): Promise<void> {
  const res = await request.post(`/api/teams/${H.team}/knowledge/${H.base}/resync`, { headers: as(omar), data: {} });
  expect(res.status()).toBeLessThan(300);
  await expect
    .poll(
      async () => {
        const d = await detail(request);
        const source = d.sources.find((s) => s.kind === 'connector');
        return JSON.stringify({ documents: d.documents.map((x) => x.name).sort(), skipped: source?.skippedLimited ?? 0 });
      },
      { timeout: 90_000, intervals: [1_000, 3_000], message: `the base to show ${documents.join(', ') || 'no documents'} with ${String(skipped)} left out` },
    )
    .toBe(JSON.stringify({ documents: [...documents].sort(), skipped }));
}

const share = async (id: string, permissions: unknown[]): Promise<void> => {
  await fake(await iso.start(), 'PUT', `/__fake/drive/${id}/permissions`, { account: omar.email, permissions });
};

test('to begin with: the public document is in, the one shared with Nadia alone is left out and counted', async ({ request }) => {
  await iso.start();
  await readAgain(request, [H.shared.name], 1);
  // what is left out is counted and never named
  expect(JSON.stringify(await detail(request))).not.toContain(H.limited.name);
});

test('a share with a group, and a share with another domain, are not everyone: the document stays out', async ({ request }) => {
  await iso.start();
  await share(H.limited.id, [{ type: 'group', email: 'everyone@kahf.example' }]);
  await readAgain(request, [H.shared.name], 1);
  await share(H.limited.id, [{ type: 'domain', domain: 'elsewhere.example' }]);
  await readAgain(request, [H.shared.name], 1);
});

test('a document whose access is narrowed later is removed on the next read and counted', async ({ request }) => {
  await iso.start();
  await share(H.shared.id, [{ type: 'user', email: personas.nadia.email }]);
  await readAgain(request, [], 2);
  // and the base no longer answers a question with its text
  const found = await request.get(`/api/teams/${H.team}/knowledge/${H.base}/search?q=${encodeURIComponent('pager hand-over')}`, { headers: as(priya) });
  expect(found.status()).toBe(200);
  expect(await found.text()).not.toContain(H.shared.name);
});

test('a public link brings both back in, with nothing left out', async ({ request }) => {
  await iso.start();
  await share(H.shared.id, [{ type: 'anyone' }]);
  await share(H.limited.id, [{ type: 'anyone' }]);
  await readAgain(request, [H.shared.name, H.limited.name], 0);
});

test('Omar disconnects Google: the source is paused and says why, and a teammate still finds what was read', async ({ request }) => {
  await iso.start();
  const gone = await request.delete('/api/me/connections/google', { headers: as(omar) });
  expect(gone.status()).toBeLessThan(300);
  await request.post(`/api/teams/${H.team}/knowledge/${H.base}/resync`, { headers: as(omar), data: {} });
  await expect
    .poll(async () => (await detail(request)).sources.find((s) => s.kind === 'connector')?.status, { timeout: 90_000, intervals: [1_000, 3_000] })
    .toBe('paused');
  // what was copied before stays (the documents belong to the base)
  expect((await detail(request)).documents.length).toBe(2);
});
