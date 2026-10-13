import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { BotRun, BotSummary } from '@manythreads/shared';
import { QueryView } from '../../components/states';
import { Alert, Avatar, Notice } from '../../components/ui';
import { useHeaderTopic } from '../../shell/topic';
import { NO_CONVERSATION, botMdPath } from './api';
import { BOT_TABS, saveFailureOf, saveMessage, useBot, useDefinition, writeDefinition, type SaveFailure } from './store';
import { TabPanel } from './tabs';

/*
 * One bot's page (SPEC §7.2/§7.5, PLAN P5-05, `[proto §05]`): the same fourteen tabs for every bot in the workspace, reached from the
 * roster's Configure button. The head carries the bot's identity; the tabs describe it and — for the team's lead or a workspace admin — edit
 * the definition, which is the file `bots/<slug>/BOT.md` of the team repo.
 *
 * Three things the page owes a reader:
 *  - a definition that failed to load shows the red banner with the field path, and the previous version stays live (the reason comes
 *    from the row's `invalid_reason`, cleared by the loader once the file loads again);
 *  - a member who is not a lead reads every tab and is offered the file (and therefore a pull request) instead of Save, which is the
 *    same rule the repo writer enforces with 403;
 *  - Save is one commit as the signed-in person, and a file someone else changed meanwhile is refused rather than overwritten.
 */

type SaveState = { kind: 'ok'; message: string } | { kind: 'bad'; failure: SaveFailure } | null;

/** The tab of the URL, or Identity: an unknown value falls back rather than rendering an empty page.
 */
const tabOf = (raw: string | null): string => (BOT_TABS.some((t) => t.id === raw) ? (raw as string) : 'identity');

export function BotPage() {
  const { team = '', botSlug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'));
  const { slug, canEdit, q } = useBot(botSlug);
  const [revision, setRevision] = useState(0);
  const [save, setSave] = useState<SaveState>(null);
  useHeaderTopic(q.status === 'ok' ? q.data.bot.role || null : null);

  const goTab = (id: string): void => {
    const next = new URLSearchParams(params);
    if (id === 'identity') next.delete('tab');
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
            tab={tab}
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

function BotBody({ slug, canEdit, bot, path, runs, tab, onTab, revision, save, onSave, onSaved }: {
  slug: string;
  canEdit: boolean;
  bot: BotSummary;
  path: string;
  runs: BotRun[];
  tab: string;
  onTab: (id: string) => void;
  revision: number;
  save: SaveState;
  onSave: (s: SaveState) => void;
  onSaved: () => void;
}) {
  const draft = useDefinition(slug, path, revision);
  const [busy, setBusy] = useState(false);

  const doSave = async (): Promise<void> => {
    if (!draft.frontmatter || busy || draft.issues.length > 0) return;
    setBusy(true);
    onSave(null);
    try {
      const res = await writeDefinition(slug, path, draft.text(), draft.baseBlobSha, saveMessage(bot.slug, bot.name));
      onSave({ kind: 'ok', message: res.noop ? 'Nothing to commit: the file already held that definition.' : 'Saved. A commit by you was made; the loader picks it up on the next commit.' });
      onSaved();
    } catch (err) {
      // The draft stays on screen, so nothing typed is lost when the write is refused.
      onSave({ kind: 'bad', failure: saveFailureOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const invalid = bot.invalid;
  return (
    <>
      <header className="b-head" data-landmark="bot-head">
        <Avatar name={bot.name} kind={bot.kind === 'automation' ? 'automation' : 'agent'} />
        <div className="b-head-who">
          <h1 className="b-title" data-testid="bot-title">
            {bot.name}
            <span className={`kind ${bot.kind === 'automation' ? 'ru' : 'ag'}`}>{bot.kind}</span>
          </h1>
          <p className="b-sub">
            {bot.runtime === 'hermes' ? 'Hermes' : 'Rules'} · <span className="mono">{path}</span>
            {bot.visibility === 'workspace' ? ' · shared with the workspace' : ''}
          </p>
        </div>
        <div className="b-head-act">
          {bot.status !== 'active' ? null : bot.conversational ? (
            <Link className="btn s primary" to={`/t/${slug}/bots/${bot.slug}/chat`} data-testid="open-conversation">Talk to {bot.name}</Link>
          ) : (
            <button type="button" className="btn s" disabled title={NO_CONVERSATION} data-testid="open-conversation">Talk to {bot.name}</button>
          )}
          <Link className="btn s" to={`/t/${slug}/bots`} data-testid="back-to-roster">Roster</Link>
          <Link className="btn s" to={`/t/${slug}/files?open=${encodeURIComponent(path)}`} data-testid="open-in-files">Open the file</Link>
        </div>
      </header>

      {invalid ? (
        <div className="b-banner" role="alert" data-testid="bot-invalid-banner">
          <span className="bang" aria-hidden="true">!</span>
          <div>
            <b>BOT.md invalid{invalid.fieldPath ? `: ${invalid.fieldPath}` : ''}</b>
            <div className="d">{invalid.message}</div>
            <div className="d">The previous version is still running. Fix the file and the loader picks it up on the next commit.</div>
          </div>
        </div>
      ) : null}

      {save?.kind === 'ok' ? <Notice>{save.message}</Notice> : null}
      {save?.kind === 'bad' ? <Alert>{save.failure.message}</Alert> : null}

      <nav className="b-tabs" aria-label="Bot sections" data-landmark="bot-tabs">
        {BOT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`tab-${t.id}`}
            aria-current={t.id === tab ? 'page' : undefined}
            className={`b-tab ${t.id === tab ? 'on' : ''}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

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

      <div className="b-pane" data-testid={`pane-${tab}`}>
        {draft.status === 'loading' ? <p className="loading" aria-busy="true">Loading the definition…</p> : null}
        {draft.frontmatter ? <TabPanel id={tab} bot={bot} draft={draft} slug={slug} canEdit={canEdit} runs={runs} /> : null}
      </div>

      {draft.frontmatter && tab !== 'audit' ? (
        <footer className="b-foot" data-testid="bot-foot">
          {canEdit ? (
            <>
              <button type="button" className="btn primary" data-testid="save-bot" disabled={!draft.dirty || busy || draft.issues.length > 0} onClick={() => void doSave()}>
                {busy ? 'Saving…' : 'Save'}
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
              <span className="b-hint" data-testid="read-only-note">You can read this definition but not change it. Changes to bots/ go by pull request.</span>
              <Link className="btn s" to={`/t/${slug}/files?open=${encodeURIComponent(path)}`} data-testid="open-readonly">Open in Files</Link>
            </>
          )}
        </footer>
      ) : null}
    </>
  );
}