// The screenshot hook (PLAN P13-02). The persona harness calls it after every picture (`onShot`, e2e/personas/harness/shot.ts); register it without editing a spec:
//   MANYTHREADS_PERSONAS_ONSHOT=/root/manythreads/tools/review/hook.ts
// It checks the picture (a failure), runs axe-core and the computed-style probe on the live page at the same step and writes both to review/precheck-report.json.
// With MANYTHREADS_PRECHECK_STRICT=1 an axe or token finding fails the step too.
import type { ShotEvent } from '../../e2e/personas/harness/shot.ts';
import { runAxe } from './lib/axe.ts';
import { judgeProbe, probePage } from './lib/probe.ts';
import { checkPicture, isStrict, reportPath, strictProblems, writeReportEntry, type ReportEntry } from './precheck.ts';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function precheckShot(event: ShotEvent, options: { strict?: boolean; report?: string } = {}): Promise<ReportEntry> {
  const { entry } = event;
  const where = `${entry.persona}/${entry.journey}/${entry.step} (${entry.kind})`;
  const entryOut: ReportEntry = {
    persona: entry.persona,
    journey: entry.journey,
    step: entry.step,
    kind: entry.kind,
    picture: checkPicture(event.png),
  };
  try {
    entryOut.axe = await runAxe(event.page as never);
  } catch (e) {
    entryOut.axeError = message(e);
  }
  try {
    const raw = await probePage(event.page as never);
    entryOut.elements = raw.elements;
    entryOut.tokens = judgeProbe(raw);
  } catch (e) {
    entryOut.tokensError = message(e);
  }
  writeReportEntry(options.report ?? reportPath(), entry.file, entryOut);
  if (entryOut.picture.problem) throw new Error(`${where}: ${entryOut.picture.problem}`);
  if (options.strict ?? isStrict()) {
    const problems = strictProblems(entry.file, entryOut);
    if (problems.length > 0) throw new Error(`${where}: pre-check (strict):\n- ${problems.slice(0, 8).join('\n- ')}`);
  }
  return entryOut;
}

export default async function hook(event: ShotEvent): Promise<void> {
  await precheckShot(event);
}
