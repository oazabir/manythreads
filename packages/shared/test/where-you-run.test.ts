import { describe, expect, it } from 'vitest';
import { DEPLOYER_MIN_RUN_SECONDS, RECORD_ROOTS, repositoryLine, whereYouRun, workFolder, type RunPlace } from '../src/runners/where-you-run.ts';

// The one "Where you run" text (P26-05): the same bot text must be true in the Hermes pod, an agent pod and on a server.

const base = { teamSlug: 'engineering', botSlug: 'committer' } as const;
const places: RunPlace[] = ['hermes_pod', 'agent_pod', 'server'];

describe('where you run', () => {
  it('puts the team\'s repository of record at the same relative place everywhere', () => {
    expect(RECORD_ROOTS.hermes_pod('engineering')).toBe('/workspace/repos');
    expect(RECORD_ROOTS.agent_pod('engineering')).toBe('/work/engineering/repos');
    expect(RECORD_ROOTS.server('engineering')).toBe('/var/lib/manythreads-bridge/work/engineering/repos');
  });

  it('keeps the sentence the Hermes run prompt has always had', () => {
    expect(repositoryLine({ place: 'hermes_pod', ...base }, 'manythreads')).toBe("On the team's Hermes pod its repository of record is /workspace/repos/manythreads.git and your clone is ~/manythreads.");
  });

  it('names the folders of each place', () => {
    expect(workFolder({ place: 'agent_pod', ...base })).toBe('/work/engineering/committer');
    expect(workFolder({ place: 'server', ...base })).toBe('/var/lib/manythreads-bridge/work/engineering/committer');
    expect(repositoryLine({ place: 'agent_pod', ...base }, 'app')).toContain('/work/engineering/repos/app.git and your clone is /work/engineering/committer/app');
  });

  it('says `mt-publish` (never the script behind it) in every place, with the task id rule, only for a bot that may publish', () => {
    for (const place of places) {
      const text = whereYouRun({ place, agent: 'codex', ...base, mayPublish: true });
      expect(text, place).toContain('`mt-publish check <project>`');
      expect(text, place).toContain('`mt-publish publish <project> <card id> <tested commit> "<title>"`');
      expect(text, place).toContain('starts with the task id');
      expect(text, place).not.toContain('mt-publish.sh');
      expect(text, place).not.toContain('sudo');
      expect(whereYouRun({ place, agent: 'codex', ...base }), place).not.toContain('mt-publish');
    }
  });

  it('uses mt-git for everything with Claude, and for the repository of record only with the others, away from the Hermes pod', () => {
    for (const place of ['agent_pod', 'server'] as const) {
      expect(whereYouRun({ place, agent: 'claude', ...base })).toContain('For git, use `mt-git` in place of `git`');
      for (const agent of ['codex', 'hermes'] as const) {
        const text = whereYouRun({ place, agent, ...base });
        expect(text).toContain('`mt-git record-push <branch>`');
        expect(text).toContain('`mt-git record-fetch`');
        expect(text).not.toContain('For git, use `mt-git`');
      }
    }
    expect(whereYouRun({ place: 'hermes_pod', agent: 'hermes', ...base })).toContain('`git push origin <branch>`');
    expect(whereYouRun({ place: 'hermes_pod', agent: 'hermes', ...base })).not.toContain('mt-git');
  });

  it('tells Claude to run one command per call (item 10 proof: a read-only Engineer joined cd, mt-git, head and grep, and the run waited on an approval)', () => {
    for (const place of ['agent_pod', 'server'] as const) {
      expect(whereYouRun({ place, agent: 'claude', ...base })).toContain('one command per call, never joined with `&&`, `;` or `|`');
      expect(whereYouRun({ place, agent: 'codex', ...base })).not.toContain('one command per call');
      expect(whereYouRun({ place, agent: 'claude', ...base })).toContain('read that file with your Read tool, in parts, never with `python3`');
    }
  });

  it('gives the deployer its kube context and the 45-minute budget, and nobody else', () => {
    const deployer = whereYouRun({ place: 'agent_pod', agent: 'codex', teamSlug: 'engineering', botSlug: 'deployer', kubeconfig: '/deploy/engineering/deployer.kubeconfig' });
    expect(deployer).toContain('/deploy/engineering/deployer.kubeconfig');
    expect(deployer).toContain('at least 45 minutes');
    expect(DEPLOYER_MIN_RUN_SECONDS).toBe(2700);
    expect(whereYouRun({ place: 'agent_pod', agent: 'codex', ...base })).not.toContain('kubectl');
  });

  it('gives Codex the three notes P25-16 needed, and other agents the poll note', () => {
    const codex = whereYouRun({ place: 'agent_pod', agent: 'codex', ...base });
    expect(codex).toContain('search for it by name');
    expect(codex).toContain('poll it until it has ended');
    expect(codex).toContain('Do not leave a process running in the background');
    const claude = whereYouRun({ place: 'agent_pod', agent: 'claude', ...base });
    expect(claude).toContain('poll it until it has ended');
    expect(claude).not.toContain('search for it by name');
  });

  it('mentions the browser only where there is one, and never a secret, address or the previous name', () => {
    expect(whereYouRun({ place: 'agent_pod', agent: 'codex', ...base, browser: true })).toContain('Chromium');
    expect(whereYouRun({ place: 'agent_pod', agent: 'codex', ...base })).not.toContain('Chromium');
    const all = places.map((place) => whereYouRun({ place, agent: 'codex', ...base, project: 'app', mayPublish: true, kubeconfig: '/k', browser: true })).join('\n');
    expect(all).not.toMatch(/https?:\/\//);
  });

  it('refuses a name that is not a plain name, so a folder can never be steered by a slug', () => {
    expect(() => whereYouRun({ place: 'agent_pod', agent: 'codex', teamSlug: '../etc', botSlug: 'x' })).toThrow(/plain name/);
    expect(() => whereYouRun({ place: 'server', agent: 'codex', teamSlug: 'a', botSlug: 'b c' })).toThrow(/plain name/);
    expect(() => repositoryLine({ place: 'agent_pod', ...base }, 'a/../b')).toThrow(/plain name/);
  });
});
