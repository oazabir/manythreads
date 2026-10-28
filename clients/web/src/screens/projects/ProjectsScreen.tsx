import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { NavChannel, Project } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { Alert, Field, Notice } from '../../components/ui';
import { useChannelFeed } from '../../shell/channelFeed';
import { useHeaderTopic } from '../../shell/topic';
import { useBotPerms } from '../bots/store';
import { createProject, deleteProject, fetchProjects, removePushCredential, setPushCredential, testPushCredential, updateProject } from './api';
import { describeToken, podPath, validateEdit, validateNew, type FormErrors } from './commands';

/*
 * Projects: the git repositories a team works on. Each one is tied to a channel; a bot asked in that channel is told which repository it
 * works on, and the team's agent pod keeps a copy. A lead or a workspace admin manages them; everyone else reads the list.
 */

const message = (e: unknown): string => (isApiError(e) || e instanceof Error ? e.message : 'Something went wrong. Try again.');

function ChannelSelect({ id, value, onChange, channels }: { id: string; value: string; onChange: (v: string) => void; channels: NavChannel[] }) {
  return (
    <div className="fld">
      <label htmlFor={id}>Channel</label>
      <select id={id} className="pj-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No channel</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>{c.name.startsWith('#') ? c.name : `#${c.name}`}</option>
        ))}
      </select>
      <div className="fld-hint">Bots asked in this channel are told about the project. A channel can have one project.</div>
    </div>
  );
}

function AddForm({ slug, channels, onDone }: { slug: string; channels: NavChannel[]; onDone: () => void }) {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [channelId, setChannelId] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateNew({ name, repoUrl, defaultBranch, channelId });
    setErrors(v.ok ? {} : v.errors);
    if (!v.ok) return;
    setBusy(true);
    setError(null);
    try {
      await createProject(slug, v.body);
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="box" onSubmit={(e) => void submit(e)} data-testid="projects-add" aria-labelledby="pj-add-h">
      <h2 className="box-h" id="pj-add-h">Add a project</h2>
      {error ? <Alert>{error}</Alert> : null}
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="manythreads" autoComplete="off"
        hint={errors.name ?? 'Also the name of the repository folder on the team pod. It cannot be changed later.'} aria-invalid={errors.name ? true : undefined} />
      <Field label="Repository address" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/your-org/your-repo" autoComplete="off"
        hint={errors.repoUrl ?? 'An https address. The pod copies it only if the operator allowed that address.'} aria-invalid={errors.repoUrl ? true : undefined} />
      <Field label="Branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} autoComplete="off"
        hint={errors.defaultBranch ?? 'The branch the work starts from.'} aria-invalid={errors.defaultBranch ? true : undefined} />
      <ChannelSelect id="pj-new-channel" value={channelId} onChange={setChannelId} channels={channels} />
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Add project'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function EditForm({ slug, p, channels, onDone }: { slug: string; p: Project; channels: NavChannel[]; onDone: () => void }) {
  const [repoUrl, setRepoUrl] = useState(p.repoUrl);
  const [defaultBranch, setDefaultBranch] = useState(p.defaultBranch);
  const [channelId, setChannelId] = useState(p.channelId ?? '');
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateEdit(p, { repoUrl, defaultBranch, channelId });
    setErrors(v.ok ? {} : v.errors);
    if (!v.ok) return;
    if (!v.changed) return onDone();
    setBusy(true);
    setError(null);
    try {
      await updateProject(slug, p.id, v.body);
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  // A project keeps a channel the directory no longer lists (a private one the editor is not in), so the box can still show it.
  const choices = p.channelId && !channels.some((c) => c.id === p.channelId) ? [...channels, { id: p.channelId, name: 'current channel', isPrivate: true, unread: 0 }] : channels;

  return (
    <form className="pj-edit" onSubmit={(e) => void submit(e)} data-testid="projects-edit">
      {error ? <Alert>{error}</Alert> : null}
      <Field label="Repository address" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} autoComplete="off" hint={errors.repoUrl} aria-invalid={errors.repoUrl ? true : undefined} />
      <Field label="Branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} autoComplete="off" hint={errors.defaultBranch} aria-invalid={errors.defaultBranch ? true : undefined} />
      <ChannelSelect id={`pj-channel-${p.id}`} value={channelId} onChange={setChannelId} channels={choices} />
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Publishing: with a GitHub username and token set, the bot that tested a card's branch pushes it to this repository and opens a pull request, and a person
 * merges it in GitHub. GitHub is asked about the token before it is kept (whose it is, whether it may write here, when it expires). The token goes to the
 * team pod's secret store and is never shown again (not here, not to the bots, not in the database).
 */
function PublishingBox({ slug, p, onChanged }: { slug: string; p: Project; onChanged: () => void }) {
  const [username, setUsername] = useState(p.pushUsername ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      setToken('');
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const test = () =>
    run(async () => {
      const r = await testPushCredential(slug, p.id);
      if (r.ok) setNote(`GitHub accepts the token (${r.login ?? ''}).`);
      else setError(r.message ?? 'GitHub does not accept this token.');
    });

  const set = p.pushCredentialSetAt !== null;
  const state = describeToken(p);
  const showForm = !set || p.pushCredentialStatus === 'needs_replacing';
  return (
    <div className="pj-publish" data-testid="projects-publishing">
      <div className="pj-publish-h">Pull requests</div>
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Notice tone="ok">{note}</Notice> : null}
      {set ? (
        <div className="pj-publish-set">
          <span data-testid="projects-credential-set" data-tone={state.tone}>{state.line}. A tested branch is sent to GitHub as a pull request, and a person merges it there.</span>
          <button type="button" className="btn s" disabled={busy} onClick={() => void test()} data-testid="projects-credential-test">Test connection</button>
          <button type="button" className="btn s danger" disabled={busy} onClick={() => void run(() => removePushCredential(slug, p.id))}>Remove the token</button>
        </div>
      ) : null}
      {showForm ? (
        <form className="pj-publish-form" onSubmit={(e) => { e.preventDefault(); void run(() => setPushCredential(slug, p.id, username.trim(), token.trim())); }}>
          <Field label="GitHub username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="octocat"
            hint="The GitHub account the token belongs to." />
          <Field label="GitHub token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder="github_pat_…"
            hint="A token with write access to this one repository: contents and pull requests. GitHub is asked about it before it is kept. Kept in the team pod only; nobody can read it back." />
          <a className="btn s" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer noopener">Open GitHub&apos;s token page</a>
          <button type="submit" className="btn s primary" disabled={busy || token.trim().length < 20 || username.trim() === ''}>{busy ? 'Checking…' : 'Check and save'}</button>
        </form>
      ) : null}
    </div>
  );
}

function ProjectRow({ slug, p, channels, canManage, onChanged }: { slug: string; p: Project; channels: NavChannel[]; canManage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const channel = channels.find((c) => c.id === p.channelId);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteProject(slug, p.id);
      onChanged();
    } catch (e) {
      setError(message(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pj-row" data-testid="projects-row" data-project={p.name}>
      <div className="pj-main">
        <div className="pj-name"><span className="mono">{p.name}</span> <span className="pj-branch">branch {p.defaultBranch}</span></div>
        <div className="pj-addr mono" data-vt-mask>{p.repoUrl}</div>
        <div className="pj-meta d">
          {p.channelId === null ? 'No channel yet.' : channel ? (
            <>Worked on in <Link to={`/t/${slug}/c/${channel.name.replace(/^#/, '')}`}>{channel.name.startsWith('#') ? channel.name : `#${channel.name}`}</Link>.</>
          ) : 'Worked on in a channel you cannot see.'}
          {' '}On the team pod: <span className="mono">{podPath(p.name)}</span>
        </div>
        {error ? <Alert>{error}</Alert> : null}
        {editing ? <EditForm slug={slug} p={p} channels={channels} onDone={() => { setEditing(false); onChanged(); }} /> : null}
        {canManage ? <PublishingBox slug={slug} p={p} onChanged={onChanged} /> : p.pushCredentialSetAt ? <div className="pj-meta d">Tested branches are sent to GitHub as pull requests.</div> : null}
      </div>
      {canManage ? (
        <div className="pj-act">
          <button type="button" className="btn s" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>Edit</button>
          {!confirming ? <button type="button" className="btn s danger" onClick={() => setConfirming(true)}>Remove</button> : (
            <span className="pj-confirm" role="group" aria-label={`Remove ${p.name}`}>
              Remove this project? The copy on the pod stays.
              <button type="button" className="btn s danger" onClick={() => void remove()} disabled={busy}>Yes, remove</button>
              <button type="button" className="btn s" onClick={() => setConfirming(false)}>Keep</button>
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectsScreen() {
  const { slug, canEdit } = useBotPerms();
  useHeaderTopic('Projects');
  const projects = useQuery(`projects:${slug}`, () => fetchProjects(slug));
  const feed = useChannelFeed(slug);
  const channels = feed.groups.flatMap((g) => g.channels);
  const [adding, setAdding] = useState(false);
  const reload = () => projects.reload();

  return (
    <div className="projects-screen" data-landmark="projects">
      <div className="pj-head">
        <div>
          <h2 className="pj-title">Projects</h2>
          <p className="pj-lede">
            A project is a git repository this team works on, tied to one of its channels. A bot asked in that channel is told which repository and
            branch it is working on, and the team&apos;s agent pod keeps a copy of the repository for the bots to work in.
          </p>
        </div>
        {canEdit && !adding ? <button type="button" className="btn primary" onClick={() => setAdding(true)} data-testid="projects-add-open">Add project</button> : null}
      </div>
      {!canEdit ? <Notice tone="warn">Only a team lead or a workspace admin can change these. You can see what is set.</Notice> : null}
      {adding ? <AddForm slug={slug} channels={channels} onDone={() => { setAdding(false); reload(); }} /> : null}
      <QueryView q={projects}>
        {({ items }) => (
          <section className="box pj-list" aria-labelledby="pj-list-h" data-landmark="projects-list">
            <h2 className="box-h" id="pj-list-h">Repositories</h2>
            {items.length === 0 ? <p className="d" data-testid="projects-empty">No projects yet. Add one to tell the team&apos;s bots what code they work on.</p> : null}
            {items.map((p) => (
              <ProjectRow key={p.id} slug={slug} p={p} channels={channels} canManage={canEdit} onChanged={reload} />
            ))}
          </section>
        )}
      </QueryView>
    </div>
  );
}
