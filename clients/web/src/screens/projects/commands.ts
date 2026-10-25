import { CreateProjectRequest, UpdateProjectRequest, type Project } from '@manythreads/shared';

export type FormValues = { name: string; repoUrl: string; defaultBranch: string; channelId: string };
export type FormErrors = Partial<Record<'name' | 'repoUrl' | 'defaultBranch', string>>;

/** The sentence under each field when the server's own check fails. */
const FRIENDLY: Record<keyof FormErrors, string> = {
  name: 'Use lowercase letters, digits, dots, dashes or underscores, up to 61 characters, starting with a letter or digit.',
  repoUrl: 'Use an https address of the repository, such as https://github.com/your-org/your-repo, with no password, query or fragment.',
  defaultBranch: 'Use a branch name such as main or release/1.0.',
};

const errorsOf = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): FormErrors => {
  const out: FormErrors = {};
  for (const i of issues) {
    const k = i.path[0];
    if (k === 'name' || k === 'repoUrl' || k === 'defaultBranch') out[k] = FRIENDLY[k];
  }
  return out;
};

/** Check the add form with the server's own schema, so the page never accepts what the server would refuse. */
export function validateNew(v: FormValues): { ok: true; body: CreateProjectRequest } | { ok: false; errors: FormErrors } {
  const r = CreateProjectRequest.safeParse({
    name: v.name.trim(),
    repoUrl: v.repoUrl.trim(),
    defaultBranch: v.defaultBranch.trim() === '' ? undefined : v.defaultBranch.trim(),
    channelId: v.channelId === '' ? null : v.channelId,
  });
  return r.success ? { ok: true, body: r.data } : { ok: false, errors: errorsOf(r.error.issues) };
}

/** Only what changed is sent; `changed` is false when nothing differs. */
export function validateEdit(
  current: Pick<Project, 'repoUrl' | 'defaultBranch' | 'channelId'>,
  v: Omit<FormValues, 'name'>,
): { ok: true; body: UpdateProjectRequest; changed: boolean } | { ok: false; errors: FormErrors } {
  const draft: Record<string, string | null> = {};
  if (v.repoUrl.trim() !== current.repoUrl) draft['repoUrl'] = v.repoUrl.trim();
  if (v.defaultBranch.trim() !== current.defaultBranch) draft['defaultBranch'] = v.defaultBranch.trim();
  const channel = v.channelId === '' ? null : v.channelId;
  if (channel !== current.channelId) draft['channelId'] = channel;
  const r = UpdateProjectRequest.safeParse(draft);
  if (!r.success) return { ok: false, errors: errorsOf(r.error.issues) };
  return { ok: true, body: r.data, changed: Object.keys(draft).length > 0 };
}

/** The project a channel is tied to, if any. */
export const projectOfChannel = (projects: ReadonlyArray<Project>, channelId: string): Project | undefined => projects.find((p) => p.channelId === channelId);

/** The words for the channel header: the project's name, then the channel's own topic when it has one. */
export const headerTopic = (project: Pick<Project, 'name'> | undefined, purpose: string | null | undefined): string | null => {
  const topic = purpose && purpose.trim() !== '' ? purpose : null;
  if (!project) return topic;
  return topic ? `Project: ${project.name} · ${topic}` : `Project: ${project.name}`;
};

/** Where the repository lives on the team's pod, for the list. */
export const podPath = (name: string): string => `/workspace/repos/${name}.git`;
