import { invalid, conflict, forbidden, json, notFound, route, HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  DeletePersonalMemoryResponse,
  GetPersonalMemoryFileResponse,
  ListPersonalMemoryResponse,
  ListPersonalMemoryVersionsResponse,
  PersonalMemoryPathQuery,
  RestorePersonalMemoryRequest,
  WritePersonalMemoryRequest,
  WritePersonalMemoryResponse,
  deletePersonalMemoryRoute,
  getPersonalMemoryFileRoute,
  listPersonalMemoryRoute,
  listPersonalMemoryVersionsRoute,
  restorePersonalMemoryRoute,
  writePersonalMemoryRoute,
} from '@manythreads/shared';
import { PersonalStore, type PersonalPutResult } from './personal-store.ts';

// A person's own Memory, over HTTP (P20-05): `/api/me/memory/*`. Everything acts as the signed-in person on their own bundle; there is no way to name
// another person (the owner is never a parameter). The database enforces the same: only the owner (or the system, or the bot of a run the owner asked and
// allowed) writes, and only the owner (or an admin during a live audited open, which these routes do not use) reads. docs/plugins/memory.md.

interface Me {
  personId: string;
  workspaceId: string;
}

async function requireMe(tx: PluginTx): Promise<Me> {
  const row = (await tx.query<{ person_id: string | null; role: string | null }>('SELECT app.person_id() AS person_id, app.workspace_role() AS role')).rows[0];
  if (!row?.person_id) throw forbidden('Only a person has a Personal space.');
  if (row.role === 'guest') throw forbidden('A guest has no Personal space.');
  return { personId: row.person_id, workspaceId: tx.actor.workspaceId };
}

/** The sentence a refused write says, as an HTTP error. A success returns nothing. */
export function refusePersonalPut(result: PersonalPutResult, path: string): never {
  switch (result.status) {
    case 'conflict':
      throw conflict(`“${path}” changed since you opened it (it is at version ${result.versionNo}). Open it again and redo your edit.`);
    case 'invalid':
      throw invalid(`“${path}”: ${result.reason ?? 'not a valid memory file'}`);
    case 'too_many_files':
      throw new HttpError(409, 'personal_memory_full', 'Your Memory already holds the most files it can (2,000). Delete a file you no longer need, then save again.');
    case 'too_large':
      throw invalid('That file is larger than a memory file may be (1,000,000 bytes).');
    case 'person_owned':
      throw conflict(`“${path}” was written or verified by a person, so a bot does not replace it.`);
    default:
      throw forbidden('Only the owner may write this Memory.');
  }
}

export function registerPersonalRoutes(ctx: PluginContext): void {
  const now = (): string => ctx.runtime.now().toISOString();
  const written = async (tx: PluginTx, me: Me, op: 'put' | 'delete', versionNo: number, authorKind: 'person' | 'bot' | 'system'): Promise<void> => {
    await ctx.audit.emit(tx, { type: 'memory.personal.written', workspaceId: me.workspaceId, personId: me.personId, op, versionNo: Math.max(1, versionNo), authorKind, at: now() });
  };
  const put = async (tx: PluginTx, me: Me, path: string, text: string, baseVersion: number | null | undefined): Promise<WritePersonalMemoryResponse> => {
    const store = new PersonalStore(tx, me.personId);
    const result = await store.put(path, text, baseVersion === undefined ? {} : { baseVersion });
    if (result.status !== 'ok' && result.status !== 'unchanged') refusePersonalPut(result, path);
    if (result.status === 'ok') await written(tx, me, 'put', result.versionNo, result.callerKind ?? 'person');
    const saved = await store.read(path);
    if (saved === null) throw notFound(`“${path}” was not saved.`);
    return saved;
  };

  ctx.http.route({
    ...listPersonalMemoryRoute,
    schema: { response: ListPersonalMemoryResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      const me = await requireMe(tx);
      return json({ items: await new PersonalStore(tx, me.personId).list() });
    }),
  });

  ctx.http.route({
    ...getPersonalMemoryFileRoute,
    schema: { response: GetPersonalMemoryFileResponse },
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const { path } = PersonalMemoryPathQuery.parse(req.query);
      const found = await new PersonalStore(tx, me.personId).read(path);
      if (found === null) throw notFound(`You have no memory file “${path}”.`);
      return json({ file: found.file });
    }),
  });

  ctx.http.route({
    ...writePersonalMemoryRoute,
    schema: { body: WritePersonalMemoryRequest, response: WritePersonalMemoryResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const body = WritePersonalMemoryRequest.parse(req.body);
      return json(await put(tx, me, body.path, body.content, body.baseVersion));
    }),
  });

  ctx.http.route({
    ...deletePersonalMemoryRoute,
    schema: { response: DeletePersonalMemoryResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const { path } = PersonalMemoryPathQuery.parse(req.query);
      const store = new PersonalStore(tx, me.personId);
      const before = await store.read(path);
      const out = await store.remove(path);
      if (out === 'not_found') throw notFound(`You have no memory file “${path}”.`);
      if (out === 'forbidden') throw forbidden('Only the owner may delete this Memory.');
      await written(tx, me, 'delete', before?.file.versionNo ?? 1, 'person');
      return json({ removed: true as const });
    }),
  });

  ctx.http.route({
    ...listPersonalMemoryVersionsRoute,
    schema: { response: ListPersonalMemoryVersionsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const { path } = PersonalMemoryPathQuery.parse(req.query);
      const items = await new PersonalStore(tx, me.personId).versions(path);
      if (items.length === 0) throw notFound(`You have no memory file “${path}”.`);
      return json({ items });
    }),
  });

  ctx.http.route({
    ...restorePersonalMemoryRoute,
    schema: { body: RestorePersonalMemoryRequest, response: WritePersonalMemoryResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const body = RestorePersonalMemoryRequest.parse(req.body);
      const store = new PersonalStore(tx, me.personId);
      const old = await store.versionText(body.path, body.versionNo);
      if (old === null) throw notFound(`“${body.path}” has no saved version ${body.versionNo}.`);
      // The restored text becomes the NEXT version: the history only goes forward.
      return json(await put(tx, me, body.path, old, undefined));
    }),
  });
}
