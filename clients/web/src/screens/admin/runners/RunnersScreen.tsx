import { PageHeader } from '../../../components/PageHeader';
import { useEffect, useRef, useState } from 'react';
import type { BotRunner, OldConnection, RunnerPlacement } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { fetchLlmAliases, fetchTeams } from '../../../api/endpoints';
import { useQuery } from '../../../app/useQuery';
import { QueryView } from '../../../components/states';
import { Alert, Toggle } from '../../../components/ui';
import { fetchBotRunners, fetchOldConnections, fetchRunnerNodes, setDefaultBotRunner, testBotRunner, updateBotRunner } from './api';
import {
  addedWords,
  boundAliases,
  cannotBeDefault,
  cannotSwitchOff,
  countBots,
  defaultWords,
  describeGateway,
  describeOld,
  describeTeams,
  hasNoTeams,
  hasNodeChoice,
  isChangingPlacement,
  isSigninKind,
  runnerKindWords,
  placementLine,
  stateLook,
  switchWords,
  teamOptions,
  teamsSavedWords,
  testWords,
} from './commands';
import { AddRunnerDialog, AdoptDialog, DeleteDialog, EditRunnerDialog, NodeDialog, TeamsDialog, TestDialog } from './dialogs';
import { CredentialsDialog } from './CredentialsCard';
import { StarIcon } from '../../../shell/icons';

/*
 * Workspace → Runners (PLAN P19-04, docs/plugins/bot-runners.md). A runner is a place where bots run; a workspace admin sets them up here once and a team lead
 * only picks one by name. The page lists the runners with their state, the teams that may use each, how many bots run on it and which one is the default.
 * It adds a runner by kind, tests, switches on and off, shares with teams, deletes (the server refuses while bots still run there) and adopts the
 * connections team leads made before runners existed.
 *
 * Admin only at the route (`AdminOnly`), in the settings menu and on the server. A key is never read back: a gateway row says "A key is set".
 * Changes are announced in one polite status line; a failure is an alert under the heading. Every control is a real button, switch or field with a label.
 */

type Dialogs =
  | { kind: 'add' }
  | { kind: 'edit'; runner: BotRunner }
  | { kind: 'teams'; runner: BotRunner }
  | { kind: 'node'; runner: BotRunner }
  | { kind: 'signin'; runner: BotRunner }
  | { kind: 'test'; runner: BotRunner }
  | { kind: 'delete'; runner: BotRunner }
  | { kind: 'adopt'; connection: OldConnection }
  | null;

const message = (e: unknown): string => (isApiError(e) ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');

export function RunnersScreen() {
  const q = useQuery('runners-page', async () => {
    const [runners, old, teams, aliases] = await Promise.all([
      fetchBotRunners(),
      fetchOldConnections(),
      fetchTeams(),
      // The model names only matter for an LLM gateway runner; the list of runners must not wait on, or fail with, the LLM page.
      fetchLlmAliases().catch(() => ({ aliases: [] })),
    ]);
    // Where each pod runner's pods stand comes from the cluster, live. A runner whose answer fails shows no state line; it must not fail the page.
    const placements: Record<string, RunnerPlacement | null> = {};
    await Promise.all(
      runners.items.filter(hasNodeChoice).map(async (r) => {
        placements[r.id] = await fetchRunnerNodes(r.id).then((n) => n.placement, () => null);
      }),
    );
    return { runners: runners.items, claudePodsAvailable: runners.claudePodsAvailable, placements, old: old.items, teams: teams.teams.map((t) => ({ id: t.id as string, name: t.name })), aliases: boundAliases(aliases.aliases) };
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the rows that are saving a change; one row at a time may be busy, but another row stays usable
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const say = (text: string): void => {
    setError(null);
    setNote(text);
  };
  const fail = (e: unknown): void => {
    setNote(null);
    setError(message(e));
  };
  /**
   * A row can vanish (delete, adopt moves it): put keyboard focus on the page heading rather than let it fall to the page’s start. It waits for the
   * fresh list, because the closing dialog hands focus back to the button that opened it, and that button only goes away when the list is reloaded.
   */
  const listed = q.status === 'ok' ? q.data : null;
  const staleList = useRef<unknown>(null);
  const toHeading = (): void => {
    staleList.current = listed;
  };
  useEffect(() => {
    if (staleList.current === null || listed === null || listed === staleList.current || dialog !== null) return;
    staleList.current = null;
    heading.current?.focus();
  }, [listed, dialog]);
  const close = (): void => setDialog(null);

  // A pod that waits or moves is changing: look again every few seconds while any is, so the state line does not go stale.
  // Only while one is changing by itself (a pod that waits for the admin's word is not), and not while the tab is hidden: the page looks again when it comes back.
  const changing = listed !== null && Object.values(listed.placements).some(isChangingPlacement);
  const reload = q.reload;
  useEffect(() => {
    if (!changing) return undefined;
    const visible = (): boolean => document.visibilityState !== 'hidden';
    const timer = setInterval(() => {
      if (visible()) reload();
    }, 8000);
    const back = (): void => {
      if (visible()) reload();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [changing, reload]);

  const working = useRef(new Set<string>());
  async function act(key: string, work: () => Promise<string>): Promise<void> {
    if (working.current.has(key)) return;
    working.current.add(key);
    setBusy(new Set(working.current));
    setError(null);
    try {
      say(await work());
      q.reload();
    } catch (e) {
      fail(e);
    } finally {
      working.current.delete(key);
      setBusy(new Set(working.current));
    }
  }

  return (
    <>
      <div className="rn-head">
        <PageHeader
          title="Runners"
          headingRef={heading}
          description="A runner is a place where bots run. You set each one up here once, choose which teams may use it, and a team lead picks it by name when editing a bot."
          actions={<button type="button" className="btn primary" onClick={() => setDialog({ kind: 'add' })} data-testid="runner-add">Add runner</button>}
        />
      </div>

      {error ? <Alert>{error}</Alert> : null}
      {/* one polite status line for every change, so a screen reader hears what happened */}
      <div className="rn-status" role="status" aria-live="polite" data-testid="runner-status">{note ? <p className="notice ok">{note}</p> : null}</div>

      <QueryView q={q}>
        {(data) => (
          <>
            {data.runners.length === 0 ? (
              <Empty onAdd={() => setDialog({ kind: 'add' })} />
            ) : (
              <section className="block" aria-labelledby="runners-list">
                <h2 className="bh" id="runners-list">Your runners <span className="cnt">{data.runners.length}</span></h2>
                <ul className="rn-list" data-testid="runner-list">
                  {data.runners.map((r) => (
                    <RunnerRow
                      key={r.id}
                      runner={r}
                      placement={data.placements[r.id] ?? null}
                      busy={busy.has(r.id)}
                      onTest={() => {
                        if (r.kind === 'hermes_gateway') return setDialog({ kind: 'test', runner: r });
                        void act(r.id, async () => testWords(r, await testBotRunner(r.id)));
                      }}
                      onEdit={() => setDialog({ kind: 'edit', runner: r })}
                      onTeams={() => setDialog({ kind: 'teams', runner: r })}
                      onNode={() => setDialog({ kind: 'node', runner: r })}
                      onSignin={() => setDialog({ kind: 'signin', runner: r })}
                      onDelete={() => setDialog({ kind: 'delete', runner: r })}
                      onSwitch={(on) => void act(r.id, async () => switchWords((await updateBotRunner(r.id, { enabled: on })).runner, on))}
                      onDefault={() =>
                        void act(r.id, async () => {
                          const makeIt = !r.isDefault;
                          await setDefaultBotRunner(makeIt ? r.id : null);
                          return defaultWords(makeIt ? r : null);
                        })
                      }
                    />
                  ))}
                </ul>
              </section>
            )}

            <OldSection items={data.old} onAdopt={(connection) => setDialog({ kind: 'adopt', connection })} />

            {dialog?.kind === 'add' ? (
              <AddRunnerDialog
                claudePodsAvailable={data.claudePodsAvailable}
                teams={data.teams}
                aliases={data.aliases}
                onClose={close}
                onDone={(r) => {
                  close();
                  say(addedWords(r));
                  q.reload();
                }}
              />
            ) : null}
            {dialog?.kind === 'edit' ? (
              <EditRunnerDialog
                runner={dialog.runner}
                aliases={data.aliases}
                onClose={close}
                onDone={(_r, text) => {
                  close();
                  say(text);
                  q.reload();
                }}
              />
            ) : null}
            {dialog?.kind === 'teams' ? (
              <TeamsDialog
                runner={dialog.runner}
                teams={teamOptions(data.teams, dialog.runner.teams)}
                onClose={close}
                onDone={(r) => {
                  close();
                  say(teamsSavedWords(r));
                  q.reload();
                }}
              />
            ) : null}
            {dialog?.kind === 'node' ? (
              <NodeDialog
                runner={dialog.runner}
                onClose={close}
                onDone={(_r, text) => {
                  close();
                  say(text);
                  q.reload();
                }}
              />
            ) : null}
            {dialog?.kind === 'signin' ? (
              <CredentialsDialog
                runner={data.runners.find((x) => x.id === dialog.runner.id) ?? dialog.runner}
                onClose={close}
                onChanged={(_r, text) => {
                  say(text);
                  q.reload();
                }}
              />
            ) : null}
            {dialog?.kind === 'test' ? (
              <TestDialog
                runner={dialog.runner}
                onClose={close}
                onTested={(r, ok, text) => {
                  say(testWords(r, { ok, error: ok ? null : text, status: ok ? 'ready' : 'not_set_up' }));
                  q.reload();
                }}
              />
            ) : null}
            {dialog?.kind === 'delete' ? (
              <DeleteDialog
                runner={dialog.runner}
                onClose={close}
                onDone={(r) => {
                  close();
                  say(`${r.label} was deleted.`);
                  q.reload();
                  toHeading();
                }}
              />
            ) : null}
            {dialog?.kind === 'adopt' ? (
              <AdoptDialog
                connection={dialog.connection}
                onClose={close}
                onDone={(r) => {
                  close();
                  say(`${r.label} is now a runner. ${teamsSavedWords(r)}`);
                  q.reload();
                  toHeading();
                }}
              />
            ) : null}
          </>
        )}
      </QueryView>
    </>
  );
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="block" aria-labelledby="runners-empty" data-testid="runner-empty">
      <h2 className="bh" id="runners-empty">No runner yet</h2>
      <div className="block-body">
        <p className="lede">Bots need a place to run. It takes three steps.</p>
        <ol className="rn-steps">
          <li><strong>Add a runner.</strong> Choose the kind: a Hermes you already run, the team Hermes pod, or an LLM gateway.</li>
          <li><strong>Choose the teams</strong> that may use it. A team that is not on the list cannot see it.</li>
          <li><strong>Make it the default</strong> if bots with no choice of their own should run there.</li>
        </ol>
        <button type="button" className="btn primary" onClick={onAdd}>Add runner</button>
      </div>
    </section>
  );
}

function StateBadge({ runner }: { runner: BotRunner }) {
  const look = stateLook(runner.status);
  return (
    <span className={`rn-state ${look.tone}`} data-state={runner.status} data-testid="runner-state">
      <span aria-hidden="true">{look.glyph}</span> {look.label}
    </span>
  );
}

function RunnerRow({
  runner: r,
  placement,
  busy,
  onTest,
  onEdit,
  onTeams,
  onNode,
  onSignin,
  onDelete,
  onSwitch,
  onDefault,
}: {
  runner: BotRunner;
  placement: RunnerPlacement | null;
  busy: boolean;
  onTest: () => void;
  onEdit: () => void;
  onTeams: () => void;
  onNode: () => void;
  onSignin: () => void;
  onDelete: () => void;
  onSwitch: (on: boolean) => void;
  onDefault: () => void;
}) {
  const noDefault = r.isDefault ? null : cannotBeDefault(r);
  const stuckOn = cannotSwitchOff(r);
  const stuckId = `rn-stuck-${r.id}`;
  const gateway = describeGateway(r);
  const where = hasNodeChoice(r) ? placementLine(r.node, placement) : null;
  return (
    <li className="rn-row" data-runner={r.name} data-testid="runner-row" aria-busy={busy || undefined}>
      <div className="rn-main">
        <div className="rn-title">
          <button
            type="button"
            className={`rn-star ${r.isDefault ? 'on' : ''}`}
            aria-pressed={r.isDefault}
            aria-label={r.isDefault ? `${r.label} is the default runner. Press to have no default.` : noDefault ? `${r.label} cannot be the default runner. ${noDefault}` : `Make ${r.label} the default runner`}
            title={noDefault ?? (r.isDefault ? 'The default runner' : 'Make this the default runner')}
            aria-disabled={noDefault ? true : undefined}
            data-testid="runner-default"
            onClick={() => {
              if (!noDefault && !busy) onDefault();
            }}
          >
            <StarIcon filled={r.isDefault} />
          </button>
          <strong className="rn-label">{r.label}</strong>
          <span className="mono faint">{r.name}</span>
          {r.isDefault ? <span className="rn-default-word">Default</span> : null}
        </div>
        <div className="rn-meta">
          <span>{runnerKindWords(r)}</span>
          <StateBadge runner={r} />
          <span data-testid="runner-teams" className={hasNoTeams(r) ? 'rn-warn' : undefined}>{hasNoTeams(r) ? 'No team can use it yet' : `Teams: ${describeTeams(r)}`}</span>
          <span data-testid="runner-bots">{countBots(r.botCount)}</span>
        </div>
        {gateway ? <div className="rn-detail mono">{gateway}</div> : null}
        {r.kind === 'llm_gateway' ? <div className="rn-detail">Model name: <span className="mono">{r.modelAlias ?? 'none chosen'}</span></div> : null}
        {where ? <div className={`rn-detail rn-place ${where.tone}`} data-testid="runner-place" data-state={placement?.state ?? 'unknown'}>{where.text}</div> : null}
        {r.status !== 'ready' && r.status !== 'off' && r.statusDetail ? <div className="rn-detail">{r.statusDetail}</div> : null}
        {stuckOn ? <div className="rn-detail faint" id={stuckId}>{stuckOn}</div> : null}
      </div>
      <div className="rn-actions">
        <span className="rn-switch">
          <Toggle label={`Use ${r.label}`} checked={r.enabled} busy={busy} locked={Boolean(stuckOn)} {...(stuckOn ? { describedBy: stuckId } : {})} onChange={onSwitch} />
          <span aria-hidden="true">{r.enabled ? 'On' : 'Off'}</span>
        </span>
        <button type="button" className="btn sm" onClick={onTest} disabled={busy} data-testid="runner-test" aria-label={`Test ${r.label}`}>Test</button>
        <button type="button" className="btn sm" onClick={onTeams} disabled={busy} data-testid="runner-teams-open" aria-label={`Teams for ${r.label}`}>Teams</button>
        {isSigninKind(r.kind) ? (
          <button type="button" className="btn sm" onClick={onSignin} disabled={busy} data-testid="runner-signin-open" aria-label={`Sign-in for ${r.label}`}>Sign-in</button>
        ) : null}
        {hasNodeChoice(r) ? (
          <button type="button" className="btn sm" onClick={onNode} disabled={busy} data-testid="runner-node-open" aria-label={`Machine for ${r.label}`}>Machine</button>
        ) : null}
        <button type="button" className="btn sm" onClick={onEdit} disabled={busy} data-testid="runner-edit-open" aria-label={`Change ${r.label}`}>Change</button>
        <button type="button" className="btn sm" onClick={onDelete} disabled={busy} data-testid="runner-delete" aria-label={`Delete ${r.label}`}>Delete</button>
      </div>
    </li>
  );
}

function OldSection({ items, onAdopt }: { items: OldConnection[]; onAdopt: (c: OldConnection) => void }) {
  return (
    <section className="block" aria-labelledby="runners-old" data-testid="runner-old">
      <h2 className="bh" id="runners-old">Team-owned (old) <span className="cnt">{items.length}</span></h2>
      <div className="block-body">
        <p className="lede">
          Before runners existed, a team lead could connect a Hermes to their own team. Those connections still work. Adopting one turns it into a runner you own, so
          you can rotate its key in one place. Nothing changes for the bots that use it.
        </p>
        {items.length === 0 ? (
          <p className="faint" data-testid="runner-old-none">None left. Every old connection has been adopted.</p>
        ) : (
          <ul className="rn-list">
            {items.map((c) => (
              <li key={c.id} className="rn-row" data-testid="runner-old-row" data-connection={`${c.teamSlug}/${c.name}`}>
                <div className="rn-main">
                  <div className="rn-title"><strong className="rn-label">{c.name}</strong></div>
                  <div className="rn-meta"><span>{describeOld(c)}</span></div>
                  {c.baseUrl ? <div className="rn-detail mono">{c.baseUrl}</div> : null}
                  {c.adoptable ? null : <div className="rn-detail faint">{c.adoptableReason ?? 'This connection cannot be adopted yet.'}</div>}
                </div>
                <div className="rn-actions">
                  {c.adoptable ? (
                    <button type="button" className="btn sm" onClick={() => onAdopt(c)} aria-label={`Adopt ${c.name} of ${c.teamName}`} data-testid="runner-adopt">Adopt</button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
