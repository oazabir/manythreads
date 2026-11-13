import { PageHeader } from '../../components/PageHeader';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { NavChannel, Project, ProjectProvider } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { StatusStrip } from '../../components/StatusStrip';
import { Alert, Field, Notice } from '../../components/ui';
import { useChannelFeed } from '../../shell/channelFeed';
import { useBotPerms } from '../bots/store';
import { createProject, deleteProject, fetchProjects, removePushCredential, setPushCredential, testPushCredential, updateProject } from './api';
import { PROVIDER_NAME, TOKEN_HELP, describeShare, describeToken, hostOf, needsProviderChoice, ownerOfRepo, podPath, providerOfAddress, requestWord, stripItem, validateEdit, validateNew, type FormErrors } from './commands';
import { announceProjectsChanged } from './changed';

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

/** For an address that is neither github.com nor gitlab.com: which kind of server it is. The two public hosts need no choice. */
function ProviderSelect({ id, repoUrl, value, onChange, error }: { id: string; repoUrl: string; value: ProjectProvider | ''; onChange: (v: ProjectProvider | '') => void; error?: string | undefined }) {
  if (!needsProviderChoice(repoUrl)) {
    const own = providerOfAddress(repoUrl);
    return own ? <div className="d pj-provider" data-testid="projects-provider-auto">{PROVIDER_NAME[own]} (from the address)</div> : null;
  }
  return (
    <div className="fld" data-testid="projects-provider">
      <label htmlFor={id}>What runs at {hostOf(repoUrl)}</label>
      <select id={id} className="pj-select" value={value} onChange={(e) => onChange(e.target.value as ProjectProvider | '')} aria-invalid={error ? true : undefined}>
        <option value="">Choose…</option>
        <option value="gitlab">GitLab (your own installation)</option>
        <option value="github">GitHub Enterprise</option>
      </select>
      <div className="fld-hint">{error ?? 'This address is not github.com or gitlab.com, so say which kind of server it is. It decides how the token is checked and how a merge request or pull request is opened.'}</div>
    </div>
  );
}

/** Whose name the published commit carries: the bot account's (off) or the requester's (on). */
function CommitAsField({ requester, onChange, disabled }: { requester: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="pj-commitas" data-testid="projects-commit-as">
      <label className="pj-share">
        <input type="checkbox" checked={requester} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid="projects-commit-as-requester" />
        <span>Sign commits with the name and email of the person who asked for the work, not the bot&apos;s</span>
      </label>
      <div className="fld-hint">
        One commit is made for each card. Off: the bot account is its author. On: the person who started the thread is its author; the bot account is still the committer.
        {requester ? <strong data-testid="projects-commit-as-warning"> Their account email becomes public in the repository&apos;s history and cannot be taken back.</strong> : null}
      </div>
    </div>
  );
}

/** The bot account of a project: its username and token, for the provider the address belongs to. */
function BotFields({ repoUrl, provider, username, token, onUsername, onToken, optional }: { repoUrl: string; provider: ProjectProvider | null; username: string; token: string; onUsername: (v: string) => void; onToken: (v: string) => void; optional?: boolean }) {
  if (provider === null) return null;
  const help = TOKEN_HELP[provider];
  const name = PROVIDER_NAME[provider];
  return (
    <>
      <Field label={`Bot username on ${name}${optional ? ' (optional now)' : ''}`} value={username} onChange={(e) => onUsername(e.target.value)} autoComplete="off" placeholder={provider === 'github' ? 'octocat' : 'mybot'}
        hint={`The ${name} account the bots publish as. It becomes the committer of every commit.`} data-testid="projects-bot-username" />
      <Field label={`Bot token${optional ? ' (optional now)' : ''}`} type="password" value={token} onChange={(e) => onToken(e.target.value)} autoComplete="off" placeholder={help.placeholder}
        hint={`${help.hint} ${name} is asked about it before it is kept. Kept in the team pod only; nobody can read it back.`} data-testid="projects-bot-token" />
      <a className="btn s" href={help.page(hostOf(repoUrl))} target="_blank" rel="noreferrer noopener">Open {name}&apos;s token page</a>
    </>
  );
}

function AddForm({ slug, channels, onDone }: { slug: string; channels: NavChannel[]; onDone: (note?: string) => void }) {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [channelId, setChannelId] = useState('');
  const [provider, setProvider] = useState<ProjectProvider | ''>('');
  const [botUsername, setBotUsername] = useState('');
  const [botToken, setBotToken] = useState('');
  const [requester, setRequester] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const effective = providerOfAddress(repoUrl) ?? (provider === '' ? null : provider);
  const wantsToken = botToken.trim() !== '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateNew({ name, repoUrl, defaultBranch, channelId, provider, commitAs: requester ? 'requester' : 'bot' });
    setErrors(v.ok ? {} : v.errors);
    if (!v.ok) return;
    if (wantsToken && botUsername.trim() === '') return setError('Enter the bot account\'s username with its token.');
    setBusy(true);
    setError(null);
    try {
      const created = await createProject(slug, v.body);
      if (!wantsToken) return onDone();
      // the project exists now; a token that is refused is told apart and can be saved again on the project
      try {
        await setPushCredential(slug, created.project.id, botUsername.trim(), botToken.trim());
        onDone();
      } catch (err) {
        onDone(`${name} was added, but its token was not saved: ${message(err)} Save it again on the project.`);
      }
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
      <Field label="Repository address" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/your-org/your-repo or https://gitlab.example.com/group/repo" autoComplete="off"
        hint={errors.repoUrl ?? 'An https address: GitHub, GitLab or your own GitLab installation. The pod copies it only if the operator allowed that address.'} aria-invalid={errors.repoUrl ? true : undefined} />
      <Field label="Branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} autoComplete="off"
        hint={errors.defaultBranch ?? 'The branch the work starts from.'} aria-invalid={errors.defaultBranch ? true : undefined} />
      <ProviderSelect id="pj-new-provider" repoUrl={repoUrl} value={provider} onChange={setProvider} error={errors.provider} />
      <ChannelSelect id="pj-new-channel" value={channelId} onChange={setChannelId} channels={channels} />
      <BotFields repoUrl={repoUrl} provider={effective} username={botUsername} token={botToken} onUsername={setBotUsername} onToken={setBotToken} optional />
      <CommitAsField requester={requester} onChange={setRequester} />
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? (wantsToken ? 'Adding and checking…' : 'Adding…') : 'Add project'}</button>
        <button type="button" className="btn" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

function EditForm({ slug, p, channels, onDone }: { slug: string; p: Project; channels: NavChannel[]; onDone: () => void }) {
  const [repoUrl, setRepoUrl] = useState(p.repoUrl);
  const [defaultBranch, setDefaultBranch] = useState(p.defaultBranch);
  const [channelId, setChannelId] = useState(p.channelId ?? '');
  const [provider, setProvider] = useState<ProjectProvider | ''>(providerOfAddress(p.repoUrl) === null ? p.provider : '');
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateEdit(p, { repoUrl, defaultBranch, channelId, provider });
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
      <ProviderSelect id={`pj-provider-${p.id}`} repoUrl={repoUrl} value={provider} onChange={setProvider} error={errors.provider} />
      {p.pushCredentialSetAt !== null && (repoUrl.trim() !== p.repoUrl || defaultBranch.trim() !== p.defaultBranch || (provider !== '' && provider !== p.provider)) ? (
        <Notice tone="warn">A token is for one repository, branch and provider: changing any of them removes this project&apos;s token, and you save a new one.</Notice>
      ) : null}
      <ChannelSelect id={`pj-channel-${p.id}`} value={channelId} onChange={setChannelId} channels={choices} />
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Publishing: with the bot account's username and token set, the bot that tested a card's branch publishes it to this repository as one commit and opens a
 * pull request (GitHub) or merge request (GitLab), and a person merges it there. The provider is asked about the token before it is kept (whose it is, whether
 * it may write here, when it expires). The token goes to the team pod's secret store and is never shown again (not here, not to the bots, not in the database).
 * The "sign as the requester" box says whose name the commit carries and is saved at once, with or without a token.
 */
function PublishingBox({ slug, p, onChanged }: { slug: string; p: Project; onChanged: () => void }) {
  const [username, setUsername] = useState(p.pushUsername ?? '');
  const [token, setToken] = useState('');
  const [share, setShare] = useState(p.pushCredentialShared);
  const [replacing, setReplacing] = useState(false);
  const owner = ownerOfRepo(p.repoUrl, p.provider);
  const name = PROVIDER_NAME[p.provider];
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
      setReplacing(false);
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
      if (r.ok) setNote(`${name} accepts the token (${r.login ?? ''}).`);
      else setError(r.message ?? `${name} does not accept this token.`);
    });

  const set = p.pushCredentialSetAt !== null;
  const state = describeToken(p);
  const showForm = !set || p.pushCredentialStatus === 'needs_replacing' || replacing;
  return (
    <div className="pj-publish" data-testid="projects-publishing">
      <div className="pj-publish-h">{p.provider === 'github' ? 'Pull requests' : 'Merge requests'}</div>
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Notice tone="ok">{note}</Notice> : null}
      <CommitAsField requester={p.commitAs === 'requester'} disabled={busy} onChange={(v) => void run(() => updateProject(slug, p.id, { commitAs: v ? 'requester' : 'bot' }))} />
      {set ? (
        <div className="pj-publish-set">
          <span data-testid="projects-credential-set" data-tone={state.tone}>{state.line}. A tested change is sent to {name} as a {requestWord(p.provider)}, and a person merges it there.</span>
          {p.pushCredentialShared && owner ? <span className="d" data-testid="projects-credential-shared">The same token serves every project of this team under {owner}.</span> : null}
          <button type="button" className="btn s" disabled={busy} onClick={() => void test()} data-testid="projects-credential-test">Test connection</button>
          {!showForm ? <button type="button" className="btn s" disabled={busy} onClick={() => setReplacing(true)} data-testid="projects-credential-replace">Replace token</button> : null}
          <button type="button" className="btn s danger" disabled={busy} onClick={() => void run(() => removePushCredential(slug, p.id))}>Remove the token</button>
        </div>
      ) : null}
      {showForm ? (
        <form
          className="pj-publish-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await setPushCredential(slug, p.id, username.trim(), token.trim(), share && owner !== null);
              setNote(describeShare(r));
            });
          }}
        >
          <BotFields repoUrl={p.repoUrl} provider={p.provider} username={username} token={token} onUsername={setUsername} onToken={setToken} />
          {owner ? (
            <label className="pj-share" data-testid="projects-credential-share">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
              <span>Use for every project of this team that lives under <span className="mono">{owner}</span>. The token is kept once and each project is checked against GitHub. Only projects that exist now are covered, and one that already has a token of its own is left as it is.</span>
            </label>
          ) : null}
          <button type="submit" className="btn s primary" disabled={busy || token.trim().length < 20 || username.trim() === ''}>{busy ? 'Checking…' : 'Check and save'}</button>
          {replacing ? <button type="button" className="btn s" onClick={() => setReplacing(false)}>Cancel</button> : null}
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
        <div className="pj-name"><span className="mono">{p.name}</span> <span className="pj-branch" data-testid="projects-provider-tag">{PROVIDER_NAME[p.provider]}</span> <span className="pj-branch">branch {p.defaultBranch}</span></div>
        <div className="pj-addr mono" data-vt-mask>{p.repoUrl}</div>
        <div className="pj-meta d">
          {p.channelId === null ? 'No channel yet.' : channel ? (
            <>Worked on in <Link to={`/t/${slug}/c/${channel.name.replace(/^#/, '')}`}>{channel.name.startsWith('#') ? channel.name : `#${channel.name}`}</Link>.</>
          ) : 'Worked on in a channel you cannot see.'}
          {' '}On the team pod: <span className="mono">{podPath(p.name)}</span>
        </div>
        {error ? <Alert>{error}</Alert> : null}
        {editing ? <EditForm slug={slug} p={p} channels={channels} onDone={() => { setEditing(false); onChanged(); }} /> : null}
        {canManage ? <PublishingBox slug={slug} p={p} onChanged={onChanged} /> : p.pushCredentialSetAt ? <div className="pj-meta d">Tested changes are sent to {PROVIDER_NAME[p.provider]} as {requestWord(p.provider)}s.</div> : null}
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
  const { projectId } = useParams();
  const projects = useQuery(`projects:${slug}`, () => fetchProjects(slug));
  const feed = useChannelFeed(slug);
  const channels = feed.groups.flatMap((g) => g.channels);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // every change on this page tells the sidebar's Projects section to ask again
  const reload = () => {
    projects.reload();
    announceProjectsChanged();
  };

  return (
    <div className="projects-screen" data-landmark="projects">
      <PageHeader
        title="Projects"
        description="The git repositories this team works on (GitHub, GitLab or your own GitLab), each tied to one of its channels, with the bot account that publishes to it."
        actions={canEdit && !adding ? <button type="button" className="btn primary" onClick={() => setAdding(true)} data-testid="projects-add-open">Add project</button> : null}
      />
      <QueryView q={projects}>
        {({ items }) => {
          const shown = projectId ? items.filter((p) => p.id === projectId) : items;
          return (
            <>
              <StatusStrip label="Project status" testId="projects-strip" items={items.map((p) => stripItem(p))} empty="No repository is connected yet." />
              {!canEdit ? <p className="d pj-note" data-testid="projects-note">Only a team lead or a workspace admin can change these. You can see what is set.</p> : null}
              {flash ? <Alert>{flash}</Alert> : null}
              {adding ? <AddForm slug={slug} channels={channels} onDone={(note) => { setAdding(false); setFlash(note ?? null); reload(); }} /> : null}
              <section className="box pj-list" aria-labelledby="pj-list-h" data-landmark="projects-list">
                <h2 className="box-h" id="pj-list-h">{projectId ? 'Project' : 'Repositories'}</h2>
                {projectId ? <p className="d"><Link to={`/t/${slug}/projects`} data-testid="projects-all">All projects</Link></p> : null}
                {items.length === 0 ? <p className="d" data-testid="projects-empty">No projects yet. Add one to tell the team&apos;s bots what code they work on.</p> : null}
                {projectId && shown.length === 0 && items.length > 0 ? <p className="d" data-testid="projects-missing">There is no such project in this team.</p> : null}
                {shown.map((p) => (
                  <ProjectRow key={p.id} slug={slug} p={p} channels={channels} canManage={canEdit} onChanged={reload} />
                ))}
              </section>
            </>
          );
        }}
      </QueryView>
      <details className="box pj-fold" data-landmark="projects-how" data-testid="projects-how-fold">
        <summary className="pj-fold-h">How to connect</summary>
        <ol className="pj-how">
          <li>Press <strong>Add project</strong>. Give it a name, the https address of the repository (GitHub, GitLab, or your own GitLab: say which for an address that is not github.com or gitlab.com) and the branch the work starts from.</li>
          <li>Pick the channel the team works on it in. A bot asked in that channel is told which repository and branch it works on, and the team&apos;s agent pod keeps a copy for the bots to work in.</li>
          <li>To let a bot send tested work to the repository, give the project a bot account: its username and a token. The bot publishes one commit for each card as a pull request or merge request, and a person still merges it there.</li>
          <li>Choose whose name the commits carry: the bot account&apos;s, or the name and email of the person who asked for the work. The second makes that person&apos;s email public in the repository&apos;s history.</li>
        </ol>
      </details>
    </div>
  );
}
