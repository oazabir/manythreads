import type { StripItem } from '../../components/StatusStrip';
import { CreateProjectRequest, UpdateProjectRequest, parseGitRepo, providerOfHost, type Project, type ProjectProvider, type SetPushCredentialResponse } from '@manythreads/shared';

/** `provider` is empty until the person chooses: github.com and gitlab.com need no choice, any other address does. */
export type FormValues = { name: string; repoUrl: string; defaultBranch: string; channelId: string; provider?: ProjectProvider | ''; commitAs?: 'bot' | 'requester' };

export const PROVIDER_NAME: Record<ProjectProvider, string> = { github: 'GitHub', gitlab: 'GitLab' };
/** The word for what a bot opens: GitHub has pull requests, GitLab merge requests. */
export const requestWord = (provider: ProjectProvider): string => (provider === 'github' ? 'pull request' : 'merge request');

/** The host of an https address, lower case, or null when it is not (yet) one. */
export function hostOf(repoUrl: string): string | null {
  const m = /^https:\/\/([^/\s?#@]+)(?:\/|$)/i.exec(repoUrl.trim());
  return m ? (m[1] ?? '').toLowerCase() : null;
}

/** The provider an address names by itself (github.com, gitlab.com), or null: another host is whichever the person says it is. */
export const providerOfAddress = (repoUrl: string): ProjectProvider | null => {
  const host = hostOf(repoUrl);
  return host === null ? null : providerOfHost(host);
};

/** Whether the form must ask which provider an address is: only for a host that is neither github.com nor gitlab.com. */
export const needsProviderChoice = (repoUrl: string): boolean => hostOf(repoUrl) !== null && providerOfAddress(repoUrl) === null;
export type FormErrors = Partial<Record<'name' | 'repoUrl' | 'defaultBranch' | 'provider', string>>;

/** The sentence under each field when the server's own check fails. */
const FRIENDLY: Record<keyof FormErrors, string> = {
  name: 'Use lowercase letters, digits, dots, dashes or underscores, up to 61 characters, starting with a letter or digit.',
  repoUrl: 'Use an https address of the repository, such as https://github.com/your-org/your-repo, with no password, query or fragment.',
  defaultBranch: 'Use a branch name such as main or release/1.0.',
  provider: 'This address is not github.com or gitlab.com: choose whether it is GitHub (Enterprise) or GitLab (self-hosted).',
};

const errorsOf = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): FormErrors => {
  const out: FormErrors = {};
  for (const i of issues) {
    const k = i.path[0];
    if (k === 'name' || k === 'repoUrl' || k === 'defaultBranch' || k === 'provider') out[k] = FRIENDLY[k];
  }
  return out;
};

/** Check the add form with the server's own schema, so the page never accepts what the server would refuse. */
export function validateNew(v: FormValues): { ok: true; body: CreateProjectRequest } | { ok: false; errors: FormErrors } {
  const provider = v.provider ?? '';
  if (needsProviderChoice(v.repoUrl) && provider === '') return { ok: false, errors: { provider: FRIENDLY.provider } };
  const r = CreateProjectRequest.safeParse({
    name: v.name.trim(),
    repoUrl: v.repoUrl.trim(),
    defaultBranch: v.defaultBranch.trim() === '' ? undefined : v.defaultBranch.trim(),
    channelId: v.channelId === '' ? null : v.channelId,
    ...(provider !== '' && providerOfAddress(v.repoUrl) === null ? { provider } : {}),
    commitAs: v.commitAs ?? 'bot',
  });
  return r.success ? { ok: true, body: r.data } : { ok: false, errors: errorsOf(r.error.issues) };
}

/** Only what changed is sent; `changed` is false when nothing differs. */
export function validateEdit(
  current: Pick<Project, 'repoUrl' | 'defaultBranch' | 'channelId'> & { provider?: ProjectProvider },
  v: Omit<FormValues, 'name' | 'commitAs'>,
): { ok: true; body: UpdateProjectRequest; changed: boolean } | { ok: false; errors: FormErrors } {
  const draft: Record<string, string | null> = {};
  if (v.repoUrl.trim() !== current.repoUrl) draft['repoUrl'] = v.repoUrl.trim();
  if (v.defaultBranch.trim() !== current.defaultBranch) draft['defaultBranch'] = v.defaultBranch.trim();
  const channel = v.channelId === '' ? null : v.channelId;
  if (channel !== current.channelId) draft['channelId'] = channel;
  // the provider is sent only when it differs from the project's: github.com and gitlab.com decide it themselves, any other host keeps the one chosen
  const chosen = v.provider === undefined || v.provider === '' ? null : v.provider;
  const next = providerOfAddress(v.repoUrl) ?? chosen ?? current.provider ?? null;
  if (next === null) return { ok: false, errors: { provider: FRIENDLY.provider } };
  if (current.provider !== undefined && next !== current.provider) draft['provider'] = next;
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

const EXPIRY_WARN_DAYS = 14;

/** "Connected as octocat · expires 15 Jan 2027", and a warning from 14 days before the date. */
export function describeToken(p: Pick<Project, 'pushUsername' | 'pushCredentialExpiresAt' | 'pushCredentialStatus'> & { provider?: ProjectProvider }, now = Date.now()): { line: string; tone: 'ok' | 'warn' | 'bad' } {
  if (p.pushCredentialStatus === 'needs_replacing') return { line: `Token needs replacing: ${PROVIDER_NAME[p.provider ?? 'github']} no longer accepts it, so the bots cannot publish. Save a new one below`, tone: 'bad' };
  const who = p.pushUsername ? `Connected as ${p.pushUsername}` : `A ${PROVIDER_NAME[p.provider ?? 'github']} token is set`;
  if (!p.pushCredentialExpiresAt) return { line: `${who} · no expiry date`, tone: 'ok' };
  const at = Date.parse(p.pushCredentialExpiresAt);
  const days = Math.ceil((at - now) / 86_400_000);
  const date = new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (days <= 0) return { line: `${who} · expired ${date}`, tone: 'bad' };
  return { line: `${who} · expires ${date}`, tone: days <= EXPIRY_WARN_DAYS ? 'warn' : 'ok' };
}

/**
 * One line of the status strip for a project: its name, whether the bots can send finished work to GitHub, and when the token was saved.
 * GitHub is asked about a token only when it is saved or tested, so the page says "token saved", not "last checked".
 */
export function stripItem(p: Pick<Project, 'id' | 'name' | 'repoUrl' | 'pushUsername' | 'pushCredentialSetAt' | 'pushCredentialExpiresAt' | 'pushCredentialStatus'> & { provider?: ProjectProvider }, now = Date.now()): StripItem {
  const when = p.pushCredentialSetAt ? { label: 'token saved', iso: p.pushCredentialSetAt } : null;
  const base = { id: p.id, host: p.name, detail: null, when };
  if (p.pushCredentialSetAt === null) return { ...base, tone: 'idle', word: 'No token yet' };
  const t = describeToken(p, now);
  if (t.tone === 'bad') return { ...base, tone: 'bad', word: p.pushCredentialStatus === 'needs_replacing' ? 'Token needs replacing' : 'Token expired' };
  if (t.tone === 'warn') return { ...base, tone: 'warn', word: 'Token expires soon' };
  return { ...base, tone: 'ok', word: `Can send ${requestWord(p.provider ?? 'github')}s` };
}

/** The GitHub account a project's repository lives under (the first part of its path), or null for any other provider: a token is shared only between GitHub projects of one owner. */
export const ownerOfRepo = (repoUrl: string, provider: ProjectProvider = 'github'): string | null => (provider === 'github' ? (parseGitRepo(repoUrl, 'github')?.owner ?? null) : null);

/** What the bot's token page and token look like for each provider, for the form's hints. */
export const TOKEN_HELP: Record<ProjectProvider, { page: (host: string | null) => string; placeholder: string; hint: string }> = {
  github: {
    page: (host) => (host === null || host === 'github.com' ? 'https://github.com/settings/personal-access-tokens/new' : `https://${host}/settings/personal-access-tokens/new`),
    placeholder: 'github_pat_…',
    hint: 'A token of the bot account with write access to this one repository: contents and pull requests.',
  },
  gitlab: {
    page: (host) => `https://${host ?? 'gitlab.com'}/-/user_settings/personal_access_tokens`,
    placeholder: 'glpat-…',
    hint: 'A token of the bot account with the api scope. The account needs the Developer role (or higher) on this project.',
  },
};

/** What a person is told after a save that was shared with the owner's other projects: who else now publishes, and who was left out. */
export function describeShare(r: Pick<SetPushCredentialResponse, 'alsoConnected' | 'notConnected' | 'keptOwn'>): string | null {
  const parts: string[] = [];
  if (r.alsoConnected.length > 0) parts.push(`Also connected: ${r.alsoConnected.join(', ')}.`);
  if (r.notConnected.length > 0) parts.push(`Not connected, because this token cannot write to them: ${r.notConnected.join(', ')}.`);
  if (r.keptOwn.length > 0) parts.push(`Left as they were, because they already have a token of their own: ${r.keptOwn.join(', ')}.`);
  return parts.length > 0 ? parts.join(' ') : null;
}
