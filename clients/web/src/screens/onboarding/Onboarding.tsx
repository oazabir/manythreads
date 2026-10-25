import { Link } from 'react-router';
import { useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { fetchLlmProviders, fetchOidcProviders, fetchTeams, fetchWorkspace } from '../../api/endpoints';
import { QueryView } from '../../components/states';
import { fetchBots } from '../bots/api';

/*
 * Minimal onboarding for M1 (PLAN P5-22, SPEC §16): steps 0, 1, 2, 4, 5 and 6 —
 * bootstrap, one sign-in provider, one model provider, first team from a template,
 * default bots with Brain. Steps 3, 7 and 8 stay on the checklist for the full
 * wizard in phase 10. Step 4 (Domain & HTTPS) is optional: a trial on a private network runs fine without it, so it never
 * holds back "everything is ready" and "Continue setup" skips it. Admin-only, at the route (nested under AdminOnly) and in the
 * settings nav (an admin's Workspace group only). Every step links to the page that
 * already does the work; nothing here writes anything.
 */

export type OnboardingTeams = Array<{ slug: string; name: string }>;
export type OnboardingBots = Array<{ slug: string }> | null;

export type OnboardingInput = {
  workspaceName: string;
  enabledSignInProviders: number;
  llmProviders: number;
  teams: OnboardingTeams;
  /** Bots of the first team; null while the roster has not loaded (a team exists but its bots are unknown). */
  firstTeamBots: OnboardingBots;
  /** The page is open over HTTPS (the step has no server data of its own; the settings page runs the real checks). */
  secure?: boolean;
};

export type OnboardingStep = {
  id: 'bootstrap' | 'signin' | 'models' | 'https' | 'teams' | 'bots';
  /** The SPEC §16 step number, kept so the full wizard can extend this list in place. */
  n: 0 | 1 | 2 | 4 | 5 | 6;
  title: string;
  done: boolean;
  /** Optional steps never count towards `allDone` and are never offered as the next step. */
  optional?: boolean;
  to: string;
  hint: string;
};

export type OnboardingState = { steps: OnboardingStep[]; allDone: boolean; firstTeamSlug: string | null; brainChat: string | null };

/** Pure step derivation, so the checklist logic is pinned in vitest rather than in a browser. */
export function onboardingSteps(input: OnboardingInput): OnboardingState {
  const first = input.teams[0] ?? null;
  const brain = (input.firstTeamBots ?? []).some((b) => b.slug === 'brain');
  const steps: OnboardingStep[] = [
    {
      id: 'bootstrap',
      n: 0,
      title: 'Sign in as the workspace owner',
      done: true,
      to: '/settings/workspace/general',
      hint: `${input.workspaceName} exists and you are signed in as its admin.`,
    },
    {
      id: 'signin',
      n: 1,
      title: 'Sign-in methods',
      done: input.enabledSignInProviders > 0,
      to: '/settings/workspace/sign-in',
      hint:
        input.enabledSignInProviders > 0
          ? `${input.enabledSignInProviders} sign-in provider${input.enabledSignInProviders === 1 ? '' : 's'} enabled. Admins keep username and password as break-glass.`
          : 'Add Google or Microsoft so members do not need passwords.',
    },
    {
      id: 'models',
      n: 2,
      title: 'Models',
      done: input.llmProviders > 0,
      to: '/settings/workspace/llm',
      hint:
        input.llmProviders > 0
          ? `${input.llmProviders} model provider${input.llmProviders === 1 ? '' : 's'} configured.`
          : 'Point the workspace at a model provider first — bots cannot answer without one.',
    },
    {
      id: 'https',
      n: 4,
      title: 'Domain & HTTPS',
      done: input.secure === true,
      optional: true,
      to: '/settings/workspace/https',
      hint: input.secure
        ? 'This workspace is served over HTTPS. Open the page to run the full checks.'
        : 'Optional. Serve the workspace over HTTPS, through Cloudflare or with a Let’s Encrypt certificate.',
    },
    {
      id: 'teams',
      n: 5,
      title: 'Teams',
      done: input.teams.length > 0,
      to: '/teams',
      hint:
        input.teams.length > 0
          ? `${input.teams.length} ${input.teams.length === 1 ? 'team' : 'teams'}: ${input.teams.map((t) => t.name).join(', ')}.`
          : 'Create your first team from a template.',
    },
    {
      id: 'bots',
      n: 6,
      title: 'Bots',
      done: brain,
      to: first ? `/t/${first.slug}/bots` : '/teams',
      hint: !first
        ? 'Create a team first — its template brings the default bots.'
        : input.firstTeamBots === null
          ? `Reading ${first.name}'s roster…`
          : brain
            ? `Brain is on ${first.name}.`
            : `${first.name} has no Brain yet — add it from a team template.`,
    },
  ];
  return {
    steps,
    allDone: steps.every((s) => s.done || s.optional === true),
    firstTeamSlug: first?.slug ?? null,
    brainChat: first && brain ? `/t/${first.slug}/bots/brain/chat` : null,
  };
}

function StepRow({ step, first }: { step: OnboardingStep; first: boolean }) {
  return (
    <div className="mrow" data-step={step.id} data-done={step.done ? 'true' : 'false'}>
      <div>
        <span className={step.done ? 'status ok' : 'chip no'}>{step.done ? 'done' : step.optional ? 'optional' : `step ${step.n}`}</span>
      </div>
      <div>
        <div>
          <Link to={step.to}>{step.title}</Link>
          {first && !step.done ? <div className="d">Start here ↑</div> : null}
        </div>
        <div className="d">{step.hint}</div>
      </div>
      <div>
        <Link className="btn" to={step.to} aria-label={step.done ? `Review ${step.title}` : `Do step ${step.n}: ${step.title}`}>
          {step.done ? 'Review' : 'Open'}
        </Link>
      </div>
    </div>
  );
}

export function Onboarding() {
  const session = useSession();
  const workspace = useQuery('onboarding-workspace', fetchWorkspace);
  const providers = useQuery('onboarding-providers', fetchOidcProviders);
  const llm = useQuery('onboarding-llm', fetchLlmProviders);
  const teams = useQuery('onboarding-teams', fetchTeams);
  const firstSlug = teams.status === 'ok' ? (teams.data.teams[0]?.slug ?? null) : null;
  const bots = useQuery(`onboarding-bots:${firstSlug ?? 'none'}`, () =>
    firstSlug ? fetchBots(firstSlug).then((r) => r.bots) : Promise.resolve([] as Array<{ slug: string }>),
  );

  return (
    <div className="onboarding" data-landmark="onboarding">
      <h1 className="pane-title" data-landmark="title" data-copy="title">Finish setting up</h1>
      <p className="lede" data-landmark="lede" data-copy="lede">
        Five steps to a workspace where you can ask Brain something, plus an optional one for HTTPS. Steps 3, 7 and 8 arrive with the full
        wizard — until then, everything below is all there is.
      </p>
      <QueryView q={workspace}>
        {({ workspace: ws }) => (
          <QueryView q={providers}>
            {({ providers: ps }) => (
              <QueryView q={llm}>
                {({ providers: lp }) => (
                  <QueryView q={teams}>
                    {({ teams: ts }) => (
                      <QueryView q={bots}>
                        {(list) => {
                          const state = onboardingSteps({
                            workspaceName: ws.name,
                            enabledSignInProviders: ps.filter((p) => p.enabled).length,
                            llmProviders: lp.length,
                            teams: ts.map((t) => ({ slug: t.slug, name: t.name })),
                            firstTeamBots: firstSlug === null ? [] : bots.status === 'ok' ? list : null,
                            secure: window.location.protocol === 'https:',
                          });
                          const next = state.steps.find((s) => !s.done && !s.optional);
                          return (
                            <>
                              <section className="block" aria-label="Setup steps" data-landmark="steps">
                                {state.steps.map((s) => (
                                  <StepRow key={s.id} step={s} first={next?.id === s.id} />
                                ))}
                              </section>
                              <section className="block" aria-label="Finish" data-landmark="finish">
                                {state.allDone && state.brainChat ? (
                                  <div className="mrow">
                                    <div />
                                    <div>
                                      <div>Everything is ready, {session.person.name}.</div>
                                      <div className="d">Ask Brain a question from your team's runbook.</div>
                                    </div>
                                    <div>
                                      <Link className="btn primary" to={state.brainChat}>Ask Brain</Link>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="mrow">
                                    <div />
                                    <div>
                                      <div className="d">
                                        {next ? `Next: step ${next.n} · ${next.title}.` : 'Reading your workspace…'}
                                      </div>
                                    </div>
                                    <div>
                                      {next ? <Link className="btn primary" to={next.to}>Continue setup</Link> : null}
                                    </div>
                                  </div>
                                )}
                              </section>
                            </>
                          );
                        }}
                      </QueryView>
                    )}
                  </QueryView>
                )}
              </QueryView>
            )}
          </QueryView>
        )}
      </QueryView>
    </div>
  );
}
