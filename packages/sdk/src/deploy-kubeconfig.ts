import type { ProviderImpl } from './types.ts';

// The `deploy.kubeconfig` provider (registered by `hermes-pods`, extension point `provider.deploy.kubeconfig`; PLAN P26-11): the team's deployer login, the one a deployer bot uses to
// build and install into the test namespace. The Hermes pods already make it for their own deployer bot; an agent pod (claude-pods) asks for the same Secret so its deployer bot gets the
// same, namespace-limited login and nothing wider. Look the provider up when you need it, not in `register`. Absent where the Hermes pods are not on.

export interface DeployKubeconfigProvider extends ProviderImpl {
  id: 'deploy.kubeconfig';
  /**
   * Makes sure the team's deployer kubeconfig Secret exists in the pods namespace and says where it is: the Secret's name and the key of the in-cluster file in it. Null when the team has no
   * deploy target and no apps namespace ready (nothing to hand out). Rejects when the cluster cannot be asked.
   */
  ensure(input: { team: { id: string; slug: string } }): Promise<{ secret: string; key: string } | null>;
  /**
   * The kubeconfig text itself, for a bot on a machine outside the cluster (an enrolled server) that cannot mount the Secret: the file for in-cluster use, and the one whose API address is the host's
   * (null when the chart does not name one). Null when there is none. The text is a credential: the caller keeps it out of logs.
   */
  texts(input: { team: { id: string; slug: string } }): Promise<{ inCluster: string; host: string | null } | null>;
}
