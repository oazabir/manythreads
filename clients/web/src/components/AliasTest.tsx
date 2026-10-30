import { useState } from 'react';
import type { LlmAliasTest } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { testLlmAlias } from '../api/endpoints';

/*
 * The test call of one model alias (PLAN P10-01 step 2), shown on the setup wizard and on Workspace > LLM > Aliases. A test sends one small real
 * question through the alias the way a bot's call goes, and the answer is the plain sentence the server chose for the result. "Answers" is shown only
 * for a test made after the alias and its provider were last saved; an older result says it changed since, never green.
 */

function seconds(ms: number): string {
  return ms < 950 ? `${Math.max(1, Math.round(ms / 100) / 10)} s` : `${(ms / 1000).toFixed(1)} s`;
}

export function AliasTestStatus({ test }: { test: LlmAliasTest | undefined }) {
  if (!test) {
    return <span className="ob-test" data-test-state="untested"><span className="chip">not tested</span></span>;
  }
  if (!test.current) {
    return (
      <span className="ob-test" data-test-state="stale">
        <span className="chip warn">changed since the last test</span>
        <span className="ob-test-d">Test it again to know it still works.</span>
      </span>
    );
  }
  if (test.outcome === 'ok') {
    return (
      <span className="ob-test" data-test-state="ok">
        <span className="chip ok">answers</span>
        <span className="ob-test-d">{test.model ?? 'the model'} replied in {seconds(test.latencyMs)}.</span>
      </span>
    );
  }
  return (
    <span className="ob-test" data-test-state="failed" data-cause={test.cause ?? ''}>
      <span className="chip alert">failed</span>
      <span className="ob-test-d">{test.message}</span>
    </span>
  );
}

/** Runs the test for `alias` and hands the result up. A refusal that is not a test result (a limit on how often, a lost session) is shown as it is. */
export function AliasTestButton({ alias, label = 'Test', onResult }: { alias: string; label?: string; onResult: (test: LlmAliasTest) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { test } = await testLlmAlias(alias);
      onResult(test);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The test could not be started. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="btn" disabled={busy} aria-label={`${label} the ${alias} alias`} onClick={() => void run()}>
        {busy ? 'Testing…' : label}
      </button>
      {error ? <span className="ob-test-d" role="alert">{error}</span> : null}
    </>
  );
}
