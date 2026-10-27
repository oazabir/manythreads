import type { CredentialTeam, ProjectCredentialsProvider } from '@manythreads/sdk';
import { ProjectBranch, ProjectName, isPlainRepoUrl } from '@manythreads/shared';
import type { K8s, K8sObject } from './k8s.ts';
import { resolvePodNames } from './reconcile.ts';
import { labelsFor, type PodConfig } from './render.ts';

/**
 * The `project.credentials` provider: the projects' GitHub tokens, in one Secret of the team's pod namespace (`hermes-<team>-push`, one key per
 * project name). The workbench container mounts it root-only and hands each file to the `repo` Unix user alone, so a bot cannot read a token and
 * neither can the database or an event: nothing here is ever logged, and the errors that leave this file name the Kubernetes call, never the value.
 *
 * Changes to one team's Secret run one at a time IN THIS PROCESS (a promise chain: the server runs as a single replica, as the blob volume requires; two
 * replicas would need a lock in the cluster, e.g. a resourceVersion-checked update) (read, change one key, write back), so two people setting tokens for two projects of the same
 * team cannot overwrite each other. The Secret is written with `data` (not `stringData`) so server-side apply owns each key and drops one that is left out.
 */
export class PushCredentials implements ProjectCredentialsProvider {
  readonly id = 'project.credentials' as const;
  [member: string]: unknown;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly k8s: () => K8s,
    private readonly cfg: Pick<PodConfig, 'namespace'>,
  ) {}

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(team: CredentialTeam): Promise<{ name: string; data: Record<string, string> }> {
    const k8s = this.k8s();
    const names = await resolvePodNames(k8s, this.cfg, team);
    const existing = await k8s.get('Secret', this.cfg.namespace, names.push);
    return { name: names.push, data: { ...((existing?.data as Record<string, string> | undefined) ?? {}) } };
  }

  private secret(team: CredentialTeam, name: string, data: Record<string, string>): K8sObject {
    return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: this.cfg.namespace, labels: labelsFor(team) }, type: 'Opaque', data };
  }

  put(team: CredentialTeam, projectName: string, token: string, origin: string, branch: string): Promise<void> {
    if (!ProjectName.safeParse(projectName).success) return Promise.reject(new Error('bad project name'));
    if (token === '' || !/^[\x21-\x7e]+$/.test(token)) return Promise.reject(new Error('bad token'));
    if (!isPlainRepoUrl(origin)) return Promise.reject(new Error('bad origin'));
    if (!ProjectBranch.safeParse(branch).success) return Promise.reject(new Error('bad branch'));
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      // one JSON document per project: what mt-publish.sh reads with jq (the token for git and curl, the address it must match)
      data[projectName] = Buffer.from(JSON.stringify({ branch, origin, setAt: new Date().toISOString(), token }), 'utf8').toString('base64');
      await this.k8s().apply(this.secret(team, name, data));
    });
  }

  remove(team: CredentialTeam, projectName: string): Promise<void> {
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      if (!(projectName in data)) return;
      delete data[projectName];
      if (Object.keys(data).length === 0) await this.k8s().delete('Secret', this.cfg.namespace, name);
      else await this.k8s().apply(this.secret(team, name, data));
    });
  }

  /**
   * Remove the tokens of projects that are not in `keep` (the projects whose row says a token is set) and that are older than `graceMs`. A token whose row
   * never got the flag (the request that wrote the Secret failed to commit) is cleaned up here, and the grace period keeps a token that is being set
   * right now (its row is not committed yet) from being taken away. Returns the names removed.
   */
  prune(team: CredentialTeam, keep: ReadonlySet<string>, graceMs = 120_000, now = Date.now()): Promise<string[]> {
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      const gone: string[] = [];
      for (const [project, v] of Object.entries(data)) {
        if (keep.has(project)) continue;
        let setAt = 0;
        try {
          setAt = Date.parse(String((JSON.parse(Buffer.from(v, 'base64').toString('utf8')) as { setAt?: unknown }).setAt ?? ''));
        } catch {
          /* an unreadable entry counts as old */
        }
        if (Number.isFinite(setAt) && now - setAt < graceMs) continue;
        delete data[project];
        gone.push(project);
      }
      if (gone.length === 0) return gone;
      if (Object.keys(data).length === 0) await this.k8s().delete('Secret', this.cfg.namespace, name);
      else await this.k8s().apply(this.secret(team, name, data));
      return gone;
    });
  }

  async read(team: CredentialTeam, projectName: string): Promise<{ token: string; origin: string; branch: string } | null> {
    const { data } = await this.load(team);
    const v = data[projectName];
    if (!v) return null;
    try {
      const doc = JSON.parse(Buffer.from(v, 'base64').toString('utf8')) as { token?: unknown; origin?: unknown; branch?: unknown };
      return typeof doc.token === 'string' && typeof doc.origin === 'string' && typeof doc.branch === 'string' ? { token: doc.token, origin: doc.origin, branch: doc.branch } : null;
    } catch {
      return null;
    }
  }
}
