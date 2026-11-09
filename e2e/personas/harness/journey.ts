// The journey declaration (PLAN P12-01, Bundle E decisions E30-E33). A journey is one persona's walk through the app for one goal: a list of steps, each of
// which does something and then leaves one screenshot. A journey is a file `e2e/personas/<persona>/<id>-<slug>.journey.ts` that default-exports `defineJourney({...})`;
// the generic spec `e2e/personas/personas.spec.ts` finds it, runs it on each viewport and writes the pictures. Nothing else is needed.
import type { Page } from '@playwright/test';
import type { PersonaKey } from '../../support/env.ts';
import type { Pages } from '../../pages/index.ts';
import type { Stack } from '../../fixtures/stack.ts';

/** The seven seeded people, in the order PLAN §4 lists them. */
export const PERSONAS = ['omar', 'nadia', 'rafi', 'sameera', 'tariq', 'priya', 'lena'] as const satisfies readonly PersonaKey[];
export type Persona = (typeof PERSONAS)[number];

/** `B`: the journey has a Brain interaction. `A`: it has an acting-bot interaction. Every persona needs one non-pending journey of each (journeys.meta.spec.ts). */
export type Marker = 'B' | 'A';

/** Where the journey starts: a saved snapshot (tools/seed) or an empty install (the first-admin link). */
export type Start = 'day-1' | 'week-2' | 'empty';

/** `desktop` is 1440x900, `mobile` the 390x844 web client. (`native` is the phone app's Maestro pictures, written by another tool.) */
export type ViewportKind = 'desktop' | 'mobile' | 'native';
export const VIEWPORTS: Record<'desktop' | 'mobile', { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export interface NextControl {
  /** The `data-testid` of the thing the person clicks or types into next. */
  testid: string;
  /** What it says or is called on screen: shown to the persona simulation (P12-07) as the expected answer. */
  label?: string;
  /** Do not check that it is on the page when the picture is taken (it appears only after a hover or on the other viewport). */
  unchecked?: boolean;
}

export interface StepDeclaration {
  /** Lower-case words and hyphens, unique inside the journey: it becomes the file name. */
  id: string;
  /** The landmark that must be visible when the picture is taken: a `data-landmark` or `data-testid` value (`app-frame` is any screen). */
  expect: string;
  /** The control the next step uses. Absent on the last step. */
  next?: NextControl;
  /** The prototype plate this step is compared with by the visual specs, for example `§12/2`. */
  plate?: string;
  /** The step proves a refusal: the console and request checks are relaxed for it and this HTTP status must have been answered. */
  expectDenied?: number;
  /** The feature this step shows is not built yet (a PLAN task id such as `P8-19`): the step is declared and counted, takes no picture, fails nothing. */
  pending?: string;
  /** The step uses the composer, or shows what the composer made. The canary (`VITE_MANYTHREADS_CANARY=hide-composer`) must fail exactly these. Default: derived from `expect` and `next`. */
  composer?: boolean;
  /** The step shows a loading state on purpose (requests held by `holdRequests`): the picture is taken without waiting for `data-ready`. */
  loading?: boolean;
  /** Extra CSS selectors to paint over in the picture (times, counters). `[data-vt-mask]` and `time` are always painted over. */
  mask?: string[];
  /** What the person does to get to this screen. The picture is taken after it returns. Not needed on a pending step. */
  run?: (ctx: JourneyContext) => Promise<void>;
}

export interface JourneyDeclaration {
  /** `O1`, `N10`: the persona's letter and a number, unique inside the persona. */
  id: string;
  persona: Persona;
  /** One sentence in the persona's words: what they are trying to do. It is what the persona simulation is told. */
  goal: string;
  /** `B` and/or `A`, empty for a journey of negatives. */
  markers: readonly Marker[];
  start?: Start;
  /**
   * Extra variables for the stack this journey runs on (the Hermes stand-in of `e2e/conversations/support.ts`, a fake model address). Journeys with the same
   * `start` and the same `stackEnv` share one stack per persona; a different value gets its own.
   */
  stackEnv?: Readonly<Record<string, string>>;
  /** Default: both. A journey the plan marks "repeat at 390 px" declares both; one that only makes sense on a wide screen declares `['desktop']`. */
  viewports?: ReadonlyArray<'desktop' | 'mobile'>;
  /** The whole journey is not built yet: counted and listed, runs nothing. */
  pending?: string;
  /** A reason this journey has fewer than five pictures (the plan asks for five). */
  fewerShots?: string;
  steps: StepDeclaration[];
  /** The final assertion on the OUTCOME (the answer was cited, the card moved, the denial held), not on the last picture. Required unless the journey is pending. */
  outcome?: (ctx: JourneyContext) => Promise<void>;
}

/** What a step receives. */
export interface JourneyContext {
  readonly persona: Persona;
  readonly viewport: 'desktop' | 'mobile';
  readonly stack: Stack;
  /** The page the persona is looking at: the one the next picture is taken of. */
  page: Page;
  /** Page objects bound to `page`. */
  readonly pages: Pages;
  /** Another person, signed in on the same stack in a second window (the approver, the colleague whose message arrives). Closed when the journey ends. */
  also(persona: Persona, path?: string): Promise<{ page: Page; pages: Pages }>;
  /** That person's API calls (arrange or check state the screens cannot reach). */
  api(persona: Persona): Promise<import('../../support/stack-browser.ts').StackApi>;
  /** A window with nobody signed in (the sign-in screen, an invitation link). */
  anonymous(path?: string): Promise<{ page: Page; pages: Pages }>;
}

/** A declaration with its place in the persona's numbering resolved. */
export interface ResolvedStep {
  persona: Persona;
  journeyId: string;
  /** The persona-wide running number, from 1, in declaration order over non-pending steps. */
  number: number;
  id: string;
  expect: string;
  next: NextControl | undefined;
  plate: string | undefined;
  expectDenied: number | undefined;
  pending: string | undefined;
  composer: boolean;
  loading: boolean;
  mask: string[];
}

export function defineJourney(declaration: JourneyDeclaration): JourneyDeclaration {
  const problems = validateJourney(declaration);
  if (problems.length > 0) throw new Error(`journey ${declaration.persona}/${declaration.id} is not valid:\n- ${problems.join('\n- ')}`);
  return declaration;
}

const WORDS = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The testids of the message box: a step that expects or uses one of these needs a composer. */
export const COMPOSER_TESTIDS: readonly string[] = ['composer', 'reply-composer', 'send', 'msg-input'];

/** What is wrong with a declaration (empty: nothing). Shape only; whether the journey is good enough for the plan is `journeyRuleProblems`. */
export function validateJourney(j: JourneyDeclaration): string[] {
  const out: string[] = [];
  if (!/^[A-Z]+[0-9]+$/.test(j.id)) out.push(`id "${j.id}" must be letters then a number, like N2`);
  if (!(PERSONAS as readonly string[]).includes(j.persona)) out.push(`persona "${j.persona}" is not one of ${PERSONAS.join(', ')}`);
  if (j.id[0] && (PERSONAS as readonly string[]).includes(j.persona) && j.persona.slice(0, 1).toUpperCase() !== j.id[0]) {
    out.push(`id "${j.id}" should start with the letter of ${j.persona} (${j.persona.slice(0, 1).toUpperCase()})`);
  }
  if (j.goal.trim() === '') out.push('goal is empty');
  if (j.steps.length === 0) out.push('no steps');
  const seen = new Set<string>();
  for (const s of j.steps) {
    if (!WORDS.test(s.id)) out.push(`step id "${s.id}" must be lower-case words joined by hyphens`);
    if (seen.has(s.id)) out.push(`step id "${s.id}" is used twice`);
    seen.add(s.id);
    if (s.expect.trim() === '') out.push(`step "${s.id}" has no expect landmark`);
    if (s.pending === undefined && !s.run && j.pending === undefined) out.push(`step "${s.id}" has no run() and is not pending`);
    if (s.expectDenied !== undefined && (!Number.isInteger(s.expectDenied) || s.expectDenied < 400 || s.expectDenied > 599)) out.push(`step "${s.id}": expectDenied must be an HTTP error status`);
    if (s.pending !== undefined && !/^P\d+-\d+/.test(s.pending)) out.push(`step "${s.id}": pending must name a PLAN task id like P8-19`);
  }
  if (j.pending !== undefined && !/^P\d+-\d+/.test(j.pending)) out.push('pending must name a PLAN task id like P8-19');
  return out;
}

/**
 * The plan's rules for a journey that is not pending (PLAN P12-03, acceptance 4): five pictures or a stated reason, an outcome assertion, and a B and an A
 * marker overall (checked per persona by `personaRuleProblems`).
 */
export function journeyRuleProblems(j: JourneyDeclaration): string[] {
  if (j.pending !== undefined) return [];
  const out: string[] = [];
  const shots = j.steps.filter((s) => s.pending === undefined).length;
  if (shots < 5 && j.fewerShots === undefined) out.push(`${j.persona}/${j.id}: ${shots} picture(s); the plan asks for at least 5 (or set fewerShots to say why)`);
  if (!j.outcome) out.push(`${j.persona}/${j.id}: no outcome() assertion`);
  return out;
}

/** Per persona: each of the seven needs a non-pending Brain (B) journey and a non-pending acting-bot (A) journey. */
export function personaRuleProblems(journeys: readonly JourneyDeclaration[], personas: readonly Persona[] = PERSONAS): string[] {
  const out: string[] = [];
  for (const persona of personas) {
    const mine = journeys.filter((j) => j.persona === persona && j.pending === undefined);
    for (const marker of ['B', 'A'] as const) {
      if (!mine.some((j) => j.markers.includes(marker))) {
        const pendingOnes = journeys.filter((j) => j.persona === persona && j.pending !== undefined && j.markers.includes(marker)).map((j) => j.id);
        out.push(
          `${persona} has no journey marked ${marker} that is built${pendingOnes.length ? ` (${pendingOnes.join(', ')} ${pendingOnes.length === 1 ? 'is' : 'are'} pending)` : ''}`,
        );
      }
    }
  }
  const ids = new Map<string, string>();
  for (const j of journeys) {
    const key = `${j.persona}/${j.id}`;
    if (ids.has(key)) out.push(`journey id ${key} is declared twice`);
    ids.set(key, j.id);
  }
  return out;
}

/** `N2` < `N10`: letters first, then the number as a number. */
export function compareJourneyIds(a: string, b: string): number {
  const split = (id: string): [string, number] => {
    const m = /^([A-Z]+)(\d+)$/.exec(id);
    return m ? [m[1]!, Number(m[2])] : [id, 0];
  };
  const [la, na] = split(a);
  const [lb, nb] = split(b);
  return la === lb ? na - nb : la < lb ? -1 : 1;
}

export function usesComposer(s: StepDeclaration): boolean {
  if (s.composer !== undefined) return s.composer;
  return COMPOSER_TESTIDS.includes(s.expect) || (s.next !== undefined && COMPOSER_TESTIDS.includes(s.next.testid));
}

/**
 * The persona's steps with their file numbers. Journeys are ordered by id (N2 before N10), steps by declaration; pending steps and pending journeys take no number, so
 * a step that is built later does not renumber the ones before it. The same number is used on every viewport, so a desktop and a mobile picture pair up.
 */
export function resolvePersona(journeys: readonly JourneyDeclaration[], persona: Persona): ResolvedStep[] {
  const mine = journeys.filter((j) => j.persona === persona).sort((a, b) => compareJourneyIds(a.id, b.id));
  const out: ResolvedStep[] = [];
  let n = 0;
  for (const j of mine) {
    for (const s of j.steps) {
      const pending = j.pending ?? s.pending;
      if (pending === undefined) n += 1;
      out.push({
        persona,
        journeyId: j.id,
        number: pending === undefined ? n : 0,
        id: s.id,
        expect: s.expect,
        next: s.next,
        plate: s.plate,
        expectDenied: s.expectDenied,
        pending,
        composer: usesComposer(s),
        loading: s.loading === true,
        mask: s.mask ?? [],
      });
    }
  }
  return out;
}

/** `NN-<journeyId>-<step>.png` (two digits at least). */
export function stepFileName(step: Pick<ResolvedStep, 'number' | 'journeyId' | 'id'>): string {
  return `${String(step.number).padStart(2, '0')}-${step.journeyId}-${step.id}.png`;
}

/** Path of the picture below the journeys folder: `<persona>/[mobile/]NN-<journey>-<step>.png`. */
export function stepRelativePath(step: Pick<ResolvedStep, 'persona' | 'number' | 'journeyId' | 'id'>, kind: ViewportKind): string {
  return [step.persona, ...(kind === 'desktop' ? [] : [kind]), stepFileName(step)].join('/');
}

/** The viewports a journey runs on. */
export function viewportsOf(j: JourneyDeclaration): ReadonlyArray<'desktop' | 'mobile'> {
  return j.viewports ?? ['desktop', 'mobile'];
}
