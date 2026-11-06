import { PageHeader } from '../../components/PageHeader';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { BRAIN_BOT_SLUG, type BotDeployResponse, type BotRun, type BotSummary } from '@manythreads/shared';
import { isAdmin, useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { AvatarPicker } from '../../avatars/AvatarPicker';
import { Alert, Avatar, Notice } from '../../components/ui';
import { useCrumbTail } from '../../shell/topic';
import { botMdPath, deployBot, fetchMcpTools } from './api';
import { saveFailureOf, saveMessage, useBot, useDefinition, proposeDefinition, type SaveFailure } from './store';
import { MoreMenu, type MoreItem } from './MoreMenu';
import { GroupPanel } from './tabs';
import { BOT_GROUPS, viewOf, type BotGroupId, type BotView } from './groups';
import { BotTestPanel } from './test-panel';
import { canOfferTest } from './test-run';
import { DeployResult } from './deploy-panel';
import { deployBody, deployFailureText, deployProblem } from './deploy-run';

/*
 * One bot's page (SPEC §7.2/§7.5, PLAN P5-05, `[proto §05]`): the same fourteen sections for every bot in the workspace, shown under five
 * group tabs (Basics, What it can do, Safety, Where it runs, History; P21-17), reached from the roster's Configure button. `?tab=` takes a
 * group id or an old section id (`guard`): the second opens its group and scrolls to the section. The head carries the bot's identity; the tabs describe it and — for the team's lead or a workspace admin — edit
 * the definition, which is the file `bots/<slug>/BOT.md` of the team repo.
 *
 * Three things the page owes a reader:
 *  - a definition that failed to load shows the red banner with the field path, and the previous version stays live (the reason comes
 *    from the row's `invalid_reason`, cleared by the loader once the file loads again);
 *  - a member who is not a lead reads every tab and is offered the file (to propose a change there) instead of Save, which is the
 *    same rule the repo writer enforces with 403;
 *  - bots/ is never committed directly (PLAN P7-01): "Save as proposal" leaves a proposal, "Propose and apply" (lead or admin) records one and
 *    applies it in the same step as the signed-in person; a file someone else changed meanwhile is refused rather than overwritten.
 */

/**
 * One line under the title for a bot placed on a Hermes gateway (PLAN P14-22): does that Hermes hold the tools the bot has now? It compares the digest of
 * the last `tools/list` the profile made with the current one. A Hermes that keeps the tools stream open is current within seconds of any change; an older
 * Hermes (or a cut stream) shows the second sentence, and the fix is one command. Nothing is drawn when the status cannot be read or nothing has listed yet.
 */
function HermesTools({ slug, botSlug }: { slug: string; botSlug: string }) {
  const q = useQuery(`bot-mcp-tools:${slug}:${botSlug}`, () => fetchMcpTools(slug, botSlug));
  const { reload } = q;
  useEffect(() => {
    const timer = setInterval(reload, 20_000);
    return () => clearInterval(timer);
  }, [reload]);
  if (q.status !== 'ok' || q.data.state === 'never') return null;
  const current = q.data.state === 'current';
  return (
    <p className={`b-sub ${current ? '' : 'warn'}`} data-testid="hermes-tools" data-state={q.data.state}>
      {current ? 'Hermes has the current tools' : 'Hermes has an older list: restart its profile'}
      {current ? null : <> (<span className="mono">hermes -p &lt;profile&gt; gateway restart</span>)</>}
    </p>
  );
}

type SaveState = { kind: 'ok'; message: string; proposalId?: string } | { kind: 'bad'; failure: SaveFailure } | null;

export function BotPage() {
  const { team = '', botSlug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const view = viewOf(params.get('tab'));
  const { slug, canEdit, q } = useBot(botSlug);
  const [revision, setRevision] = useState(0);
  const [save, setSave] = useState<SaveState>(null);
  useCrumbTail(q.status === 'ok' ? q.data.bot.name : null);

  const goTab = (id: BotGroupId): void => {
    const next = new URLSearchParams(params);
    if (id === 'basics') next.delete('tab');
    else next.set('tab', id);
    void setParams(next, { replace: true });
  };

  return (
    <div className="bot-screen" data-testid="bot-page">
      <QueryView q={q}>
        {(data) => (
          <BotBody
            slug={slug || team}
            canEdit={canEdit}
            bot={data.bot}
            path={data.path || botMdPath(botSlug)}
            runs={data.runs}
            view={view}
            onTab={goTab}
            revision={revision}
            save={save}
            onSave={setSave}
            onSaved={() => setRevision((r) => r + 1)}
          />
        )}
      </QueryView>
    </div>
  );
}

function BotBody({ slug, canEdit, bot, path, runs, view, onTab, revision, save, onSave, onSaved }: {
  slug: string;
  canEdit: boolean;
  bot: BotSummary;
  path: string;
  runs: BotRun[];
  view: BotView;
  onTab: (id: BotGroupId) => void;
  revision: number;
  save: SaveState;
  onSave: (s: SaveState) => void;
  onSaved: () => void;
}) {
  const draft = useDefinition(slug, path, revision);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [picking, setPicking] = useState(false);
  // Brain's picture is a workspace admin's to change (the server checks as well); every other bot's is a lead's or an admin's
  const session = useSession();
  const canPick = canEdit && (bot.slug !== BRAIN_BOT_SLUG || isAdmin(session));
  // the picture shows at once after a lead or admin chooses it; `bot.avatar` is the roster's copy from the last load
  const [picture, setPicture] = useState<string | null>(bot.avatar);

  const doSave = async (applyNow: boolean): Promise<void> => {
    if (!draft.frontmatter || busy || draft.issues.length > 0) return;
    setBusy(true);
    onSave(null);
    try {
      const res = await proposeDefinition(slug, path, draft.text(), draft.baseBlobSha, saveMessage(bot.slug, bot.name), applyNow);
      onSave({
        kind: 'ok',
        proposalId: res.proposalId,
        message: res.applied
          ? 'Saved. A commit by you was made and is kept on record as a proposal; the loader picks the new definition up on the next commit.'
          : 'Proposal saved. A team lead or workspace admin can now see which lines change and apply them. Nothing changes until then.',
      });
      onSaved();
    } catch (err) {
      // The draft stays on screen, so nothing typed is lost when the write is refused.
      onSave({ kind: 'bad', failure: saveFailureOf(err) });
    } finally {
      setBusy(false);
    }
  };

  // The Deploy action (P8-34): the definition (with this page's unsaved changes), its knowledge and its connection, in one go, with the three outcomes shown.
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState<BotDeployResponse | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const deployWait = deployProblem({ status: bot.status, busy: deploying || busy, issues: draft.issues.length });
  const doDeploy = async (): Promise<void> => {
    if (!draft.frontmatter || deployWait !== null) return;
    const body = deployBody(draft);
    if (body === null) return;
    setDeploying(true);
    setDeployError(null);
    setDeployed(null);
    try {
      const res = await deployBot(slug, bot.slug, body);
      setDeployed(res);
      // a commit changes the file: read it again so the page and its base blob are the repo's
      if (res.outcomes.some((o) => o.step === 'definition' && o.state === 'changed')) onSaved();
    } catch (err) {
      setDeployError(deployFailureText(err));
    } finally {
      setDeploying(false);
    }
  };

  // The "…" menu (P21-17): everything the header keeps out of the way. Test is a rehearsal for someone who may manage the bot (P7-11; the server
  // checks again and holds back every write); Change picture is a lead's or, for Brain, an admin's.
  const moreItems: MoreItem[] = [
    ...(canOfferTest({ canEdit, status: bot.status, conversational: bot.conversational, runtime: bot.runtime })
      ? [{ label: testing ? 'Hide the test' : 'Test', testId: 'open-test', onSelect: () => setTesting((v) => !v) }]
      : []),
    ...(canPick ? [{ label: 'Change picture', testId: 'bot-change-picture', onSelect: () => setPicking(true) }] : []),
    { label: 'Roster', testId: 'back-to-roster', to: `/t/${slug}/bots` },
    { label: 'Open the file', testId: 'open-in-files', to: `/t/${slug}/files?open=${encodeURIComponent(path)}` },
    { label: 'Proposals', testId: 'bot-proposals', to: `/t/${slug}/proposals` },
    { label: 'Usage', testId: 'bot-usage', to: `/t/${slug}/bots/${bot.slug}/usage` },
  ];

  const group = view.group;
  const ready = draft.frontmatter !== null;
  // An old `?tab=guard` link opens its group and brings the section into view once the sections are drawn (once per link, not on every render).
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (view.section === null) scrolled.current = null;
    if (!ready || view.section === null || scrolled.current === view.section) return;
    scrolled.current = view.section;
    document.getElementById(`sec-${view.section}`)?.scrollIntoView({ block: 'start' });
  }, [ready, view.section]);

  // The group strip is a tablist: arrow keys move between the five, Home and End jump to the ends, and the focus follows.
  const onTabKey = (e: KeyboardEvent<HTMLElement>): void => {
    const at = BOT_GROUPS.findIndex((g) => g.id === group);
    const last = BOT_GROUPS.length - 1;
    const next = e.key === 'ArrowRight' ? (at + 1) % BOT_GROUPS.length : e.key === 'ArrowLeft' ? (at + last) % BOT_GROUPS.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    onTab(BOT_GROUPS[next]!.id);
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="tab-${BOT_GROUPS[next]!.id}"]`)?.focus();
  };

  const invalid = bot.invalid;
  return (
    <>
      <header className="b-head" data-landmark="bot-head">
        <Avatar name={bot.name} kind={bot.kind === 'automation' ? 'automation' : 'agent'} avatar={picture} />
        <div className="b-head-who">
          <PageHeader
            title={<>{bot.name}<span className={`kind ${bot.kind === 'automation' ? 'ru' : 'ag'}`}>{bot.kind}</span></>}
            testIds={{ title: 'bot-title' }}
            description={<><span title={path} data-testid="bot-head-runtime">{bot.runtime === 'hermes' ? 'Hermes' : 'Rules'}</span>{bot.visibility === 'workspace' ? ' · shared with the workspace' : ''}</>}
          />
          {bot.runtime === 'hermes' && bot.status === 'active' && bot.placement?.gateway !== undefined ? <HermesTools slug={slug} botSlug={bot.slug} /> : null}
        </div>
        <div className="b-head-act">
          {/* no conversation trigger, no 1:1 chat: nothing is drawn (the API answers 409 as well) */}
          {bot.status === 'active' && bot.conversational ? (
            <Link className="btn s primary" to={`/t/${slug}/bots/${bot.slug}/chat`} aria-label={`Talk to ${bot.name}`} data-testid="open-conversation">Talk</Link>
          ) : null}
          {/* the Deploy action (P8-34): commits the definition, makes the knowledge ready, switches the connection on; the server checks every part and reports each */}
          {canEdit && draft.frontmatter ? (
            <button type="button" className="btn s" disabled={deployWait !== null} title={deployWait ?? 'Commit the definition, make its knowledge ready and switch on its connection'} onClick={() => void doDeploy()} data-testid="deploy-bot">
              {deploying ? 'Deploying…' : 'Deploy'}
            </button>
          ) : null}
          <MoreMenu label="More actions" testId="bot-more" compact items={moreItems} />
        </div>
      </header>

      {picking && canPick ? <AvatarPicker name={bot.name} target={{ kind: 'bot', slug, botSlug: bot.slug }} current={picture} onChanged={setPicture} onClose={() => setPicking(false)} /> : null}

      {invalid ? (
        <div className="b-banner" role="alert" data-testid="bot-invalid-banner">
          <span className="bang" aria-hidden="true">!</span>
          <div>
            <b title={invalid.fieldPath ?? undefined}>This bot&apos;s file has a mistake</b>
            <div className="d">{invalid.message}</div>
            <div className="d">The previous version is still running. Fix the file and the bot updates as soon as the fix is saved.</div>
          </div>
        </div>
      ) : null}

      {testing ? <BotTestPanel slug={slug} botSlug={bot.slug} botName={bot.name} onClose={() => setTesting(false)} /> : null}

      {deployed ? <DeployResult slug={slug} result={deployed} onClose={() => setDeployed(null)} /> : null}
      {deployError ? <Alert>{deployError}</Alert> : null}

      {save?.kind === 'ok' ? (
        <Notice>
          <span data-testid="save-notice">{save.message}</span>
          {save.proposalId ? <> <Link to={`/t/${slug}/proposals/${save.proposalId}`} data-testid="open-proposal">Open the proposal</Link></> : null}
        </Notice>
      ) : null}
      {save?.kind === 'bad' ? <Alert>{save.failure.message}</Alert> : null}

      <div className="b-tabs" role="tablist" aria-label="Bot sections" data-landmark="bot-tabs" onKeyDown={onTabKey}>
        {BOT_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            id={`bot-tab-${g.id}`}
            data-testid={`tab-${g.id}`}
            aria-selected={g.id === group}
            aria-controls="bot-panel"
            tabIndex={g.id === group ? 0 : -1}
            className={`b-tab ${g.id === group ? 'on' : ''}`}
            onClick={() => onTab(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {draft.status === 'error' ? <Alert>{draft.error ?? 'Could not read the definition.'}</Alert> : null}
      {draft.status === 'unreadable' ? (
        <div className="b-banner" role="alert" data-testid="definition-unreadable">
          <span className="bang" aria-hidden="true">!</span>
          <div>
            <b>{draft.unreadable?.fieldPath ? `The file does not parse: ${draft.unreadable.fieldPath}` : 'The file does not parse'}</b>
            <div className="d">{draft.unreadable?.message}</div>
            <div className="d">Edit it in Files — this page will not rewrite a definition it cannot read.</div>
          </div>
        </div>
      ) : null}

      <div className="b-pane" id="bot-panel" role="tabpanel" aria-labelledby={`bot-tab-${group}`} data-testid={`pane-${group}`}>
        {draft.status === 'loading' ? <p className="loading" aria-busy="true">Loading the definition…</p> : null}
        {draft.frontmatter ? <GroupPanel group={group} bot={bot} draft={draft} slug={slug} canEdit={canEdit} runs={runs} /> : null}
      </div>

      {draft.frontmatter && (group !== 'history' || draft.dirty) ? (
        <footer className="b-foot" data-testid="bot-foot">
          {canEdit ? (
            <>
              <button type="button" className="btn primary" data-testid="save-bot" disabled={!draft.dirty || busy || draft.issues.length > 0} onClick={() => void doSave(true)}>
                {busy ? 'Applying…' : 'Propose and apply'}
              </button>
              <button type="button" className="btn" data-testid="propose-bot" disabled={!draft.dirty || busy || draft.issues.length > 0} onClick={() => void doSave(false)}>
                Save as proposal
              </button>
              <button type="button" className="btn" data-testid="reset-bot" disabled={!draft.dirty || busy} onClick={draft.reset}>Discard changes</button>
              <span className="b-hint" data-testid="dirty-state">{draft.dirty ? 'Unsaved changes' : 'No changes'}</span>
              {draft.issues.length > 0 ? (
                <span className="b-warnline" role="alert" data-testid="draft-issues">
                  Cannot save yet: {draft.issues[0]!.path ? `${draft.issues[0]!.path}: ` : ''}{draft.issues[0]!.message}
                  {draft.issues.length > 1 ? ` (+${draft.issues.length - 1} more)` : ''}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className="b-hint" data-testid="read-only-note">You can read this definition but not change it. To change it, propose a change in Files; a team lead or workspace admin applies it.</span>
              <Link className="btn s" to={`/t/${slug}/files?open=${encodeURIComponent(path)}`} data-testid="open-readonly">Open in Files</Link>
            </>
          )}
        </footer>
      ) : null}
    </>
  );
}