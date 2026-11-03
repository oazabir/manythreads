import { z } from 'zod';
import type { ProviderApi } from './oauth/api.ts';
import { asArray, asRecord, enc, limit, str, untrusted, type PersonToolDef } from './person-kit.ts';
import { asanaGid, CARD_TITLE, commentBody, issueBody, issueTitle, linkOf, oneLine, trackerCard, words } from './tracker-kit.ts';

// The tools of a person's Asana connection (PLAN P16-06). Asana wraps what it takes and gives in `data`. Its ids (gids) are digits only and are matched whole before they
// are put in a path. Its text search is a paid feature, so the search here is the typeahead of a workspace, which every plan has.

const data = (value: unknown): Record<string, unknown> => asRecord(asRecord(value)['data']);
const OPT = 'name,completed,assignee.name,due_on,permalink_url,modified_at';

type Workspace = { id: string; name: string | null };
async function workspaces(api: ProviderApi): Promise<Workspace[]> {
  return asArray(data(await api.json('/users/me', { query: { opt_fields: 'workspaces.name' } }))['workspaces'])
    .slice(0, 20)
    .flatMap((w) => {
      const id = str(asRecord(w)['gid'], 30);
      return id !== null && /^[0-9]{1,20}$/.test(id) ? [{ id, name: str(asRecord(w)['name'], 100) }] : [];
    });
}
/** The workspace to work in: the one named, else the person's only one. Several is a question for the model to settle with the person. */
async function workspaceFor(api: ProviderApi, named: string | undefined): Promise<{ id: string } | { answer: Record<string, unknown> }> {
  if (named !== undefined) return { id: named };
  const all = await workspaces(api);
  if (all.length === 1) return { id: all[0]!.id };
  if (all.length === 0) return { answer: { ok: false, code: 'no_workspace', message: 'This Asana sign-in has no workspace that can be used.' } };
  return { answer: { ok: false, code: 'choose_workspace', message: 'This person is in several Asana workspaces. Ask which one, then call again with workspaceId.', workspaces: all.map((w) => ({ id: w.id, name: w.name })) } };
}

const summaryOf = (t: Record<string, unknown>): Record<string, unknown> => ({
  id: str(t['gid'], 30),
  title: str(t['name'], 300),
  done: typeof t['completed'] === 'boolean' ? t['completed'] : null,
  assignee: str(asRecord(t['assignee'])['name'], 100),
  due: str(t['due_on'], 12),
  updated: str(t['modified_at'], 40),
  link: linkOf(t['permalink_url']),
});

export const ASANA_TOOLS: PersonToolDef[] = [
  {
    name: 'asana.search_tasks',
    provider: 'asana',
    service: 'tasks',
    kind: 'read',
    description: `Search the Asana tasks of a workspace by the words in their name; answers the id, title and whether it is done. If the person is in several workspaces, say which with workspaceId (the first answer lists them).${untrusted}`,
    input: z.strictObject({ query: words, workspaceId: asanaGid('workspace').optional(), limit }),
    async run(api, input) {
      const i = input as { query: string; workspaceId?: string; limit?: number };
      const n = i.limit ?? 10;
      const ws = await workspaceFor(api, i.workspaceId);
      if ('answer' in ws) return ws.answer;
      const doc = await api.json(`/workspaces/${enc(ws.id)}/typeahead`, { query: { resource_type: 'task', query: i.query, count: n, opt_fields: OPT } });
      return { ok: true, tasks: asArray(asRecord(doc)['data']).slice(0, n).map((x) => summaryOf(asRecord(x))) };
    },
  },
  {
    name: 'asana.read_task',
    provider: 'asana',
    service: 'tasks',
    kind: 'read',
    description: `Read one Asana task by the id a search answered: title, whether it is done, who has it, the notes and the latest comments.${untrusted}`,
    input: z.strictObject({ taskId: asanaGid('task') }),
    async run(api, input) {
      const id = enc(String(input['taskId']));
      const task = data(await api.json(`/tasks/${id}`, { query: { opt_fields: `${OPT},notes,projects.name` } }));
      const stories = asArray(asRecord(await api.json(`/tasks/${id}/stories`, { query: { opt_fields: 'text,type,created_at,created_by.name', limit: 50 } }))['data'])
        .map((s) => asRecord(s))
        .filter((s) => s['type'] === 'comment')
        .slice(-10);
      const notes = str(task['notes'], 20_000) ?? '';
      return {
        ok: true,
        ...summaryOf(task),
        projects: asArray(task['projects']).slice(0, 10).flatMap((p) => {
          const name = str(asRecord(p)['name'], 100);
          return name === null ? [] : [name];
        }),
        notes: notes.slice(0, 8000),
        notesTruncated: notes.length > 8000,
        comments: stories.map((s) => ({ author: str(asRecord(s['created_by'])['name'], 100), created: str(s['created_at'], 40), text: str(s['text'], 2000) })),
      };
    },
  },
  {
    name: 'asana.create_task',
    provider: 'asana',
    service: 'tasks_write',
    kind: 'write',
    description: "Create an Asana task with a name and optionally notes, in a project (projectId) or, without one, in a workspace (workspaceId, or the person's only one). Needs the person's approval.",
    input: z.strictObject({ title: issueTitle, notes: issueBody.optional(), projectId: asanaGid('project').optional(), workspaceId: asanaGid('workspace').optional() }),
    card: (i) =>
      trackerCard('Asana', 'create a task in', i['projectId'] !== undefined ? `project ${String(i['projectId'])}` : i['workspaceId'] !== undefined ? `workspace ${String(i['workspaceId'])}` : 'your workspace', { title: oneLine(i['title'], CARD_TITLE) }, { notes: i['notes'] }),
    async run(api, input) {
      const i = input as { title: string; notes?: string; projectId?: string; workspaceId?: string };
      let place: Record<string, unknown>;
      if (i.projectId !== undefined) place = { projects: [i.projectId] };
      else {
        const ws = await workspaceFor(api, i.workspaceId);
        if ('answer' in ws) return ws.answer;
        place = { workspace: ws.id };
      }
      const task = data(await api.json('/tasks', { method: 'POST', body: { data: { name: i.title, ...(i.notes ? { notes: i.notes } : {}), ...place } } }));
      return { ok: true, id: str(task['gid'], 30), link: linkOf(task['permalink_url']) };
    },
  },
  {
    name: 'asana.comment',
    provider: 'asana',
    service: 'tasks_write',
    kind: 'write',
    description: "Add a comment to an Asana task, as the asking person. Everyone who can see the task can read it. Needs the person's approval; the approver sees the task as a number, so name the task by its title in your message to them.",
    input: z.strictObject({ taskId: asanaGid('task'), text: commentBody }),
    card: (i) => trackerCard('Asana', 'comment on task', String(i['taskId']), {}, { text: i['text'] }),
    async run(api, input) {
      const story = data(await api.json(`/tasks/${enc(String(input['taskId']))}/stories`, { method: 'POST', body: { data: { text: String(input['text']) } } }));
      return { ok: true, taskId: input['taskId'], commentId: str(story['gid'], 30) };
    },
  },
  {
    name: 'asana.change_status',
    provider: 'asana',
    service: 'tasks_write',
    kind: 'write',
    description: "Mark an Asana task done, or open it again. Needs the person's approval; the approver sees the task as a number, so name the task by its title in your message to them.",
    input: z.strictObject({ taskId: asanaGid('task'), status: z.enum(['done', 'open']) }),
    card: (i) => trackerCard('Asana', i['status'] === 'done' ? 'mark done task' : 'reopen task', String(i['taskId']), { status: i['status'] }),
    async run(api, input) {
      const task = data(await api.json(`/tasks/${enc(String(input['taskId']))}`, { method: 'PUT', query: { opt_fields: 'completed,permalink_url' }, body: { data: { completed: input['status'] === 'done' } } }));
      return { ok: true, taskId: input['taskId'], done: typeof task['completed'] === 'boolean' ? task['completed'] : null, link: linkOf(task['permalink_url']) };
    },
  },
];
