# Deploy preview: a modified copy of the platform in its own namespace

This page is for the person who runs the cluster. It says what the chart sets up so that a team's deployer bot can build the platform from modified
source and run it at its own address, what that bot can and cannot do, the one step on the host you must do yourself, and what still needs a live test.
The bot's own checklist is `deploy/preview/README.md`.

Terms: a *namespace* is a walled-off area of the cluster; a *deploy target* is a namespace the chart sets aside for one team's deployer bot with full control inside it;
*CNPG* (CloudNativePG) is the operator that runs our PostgreSQL; *cert-manager* gets Let's Encrypt certificates; *kaniko* builds container images inside a pod with no Docker
daemon; a *ValidatingAdmissionPolicy* is a rule the cluster itself applies to every create or update of an object, before it is stored.

## What you get

```
 deployer bot (workbench pod, namespace manythreads-bots)
   kubeconfig: default context "deployer" (apps-<team>)   +   context "test-manythreads"
                                                                 │ ServiceAccount deployer, Role in that namespace only
                                                                 ▼
 namespace test-manythreads  ── build Job (git → kaniko ×2) ──push──▶  namespace manythreads-registry (registry:2, :5000)
   helm release "manythreads": CNPG Cluster, server, web, mailpit,     ▲
   Ingress test.manythreads.kahf.to, Issuer+Certificate (HTTP-01)      │ node pulls registry.local:5000/... through NodePort 30500
```

## Chart values

In `values.yaml` (defaults empty or off; `values-live.yaml` turns on the engineering target and the registry):

- `hermesPods.deployTargets`: a list of `{ team, namespace, hosts, podSecurity, quota?, limitRange? }`. `hermesPods.deployTargetDefaults` holds the quota and default limits.
  The template is `templates/deploy-targets.yaml`; it needs `hermesPods.enabled`, and the render fails on a bad name, no host, a wildcard host or a namespace the platform already uses.
- `registry.*`: `templates/registry.yaml`.
- `tls.defaultStore` (default true): set false for a second release in the same cluster (see below).
- `seed.resources`: memory limit of the seed Job, needed when the namespace has a LimitRange default.

### What a deploy target contains

| Object | Purpose |
| --- | --- |
| `Namespace` | labels `manythreads.io/deploy-target=true`, `manythreads.io/team`, pod security `podSecurity` (baseline: kaniko runs as root inside its container, unprivileged, which baseline allows and restricted does not); annotation `manythreads.io/hosts` (the Ingress hosts allowed); kept on `helm uninstall` |
| `ServiceAccount deployer` + `Secret deployer-token` | the bot's identity; the token is filled in by the cluster |
| `Role deployer` + `RoleBinding` | deployments, statefulsets, replicasets (+scale); jobs, cronjobs; ingresses; services, configmaps, **secrets** (this is also where Helm stores its releases), persistent volume claims; read endpoints, events, quotas; pods get/list/watch/delete, `pods/log`, `pods/exec`; CNPG `clusters`, `backups`, `scheduledbackups`, `poolers`; cert-manager `issuers`, `certificates` (+ read `certificaterequests`, `orders`, `challenges`). Nothing else: no RBAC objects, no NetworkPolicy, no ServiceAccount, no Namespace, nothing cluster-wide |
| `Role` + `RoleBinding manythreads-hermes-pods-token-reader` | lets the server's controller read exactly the Secret `deployer-token` |
| `ResourceQuota`, `LimitRange` | see "Sizing" |
| `NetworkPolicy` ×6 | default deny; allow inside the namespace; DNS + internet 80/443 (no private ranges); out to the registry :5000; out to the Kubernetes API for pods labelled `cnpg.io/cluster` only; in from Traefik and from `cnpg-system` (ports 8000, 5432) |
| `ValidatingAdmissionPolicy` + binding `manythreads-deploy-target-guard` (cluster-wide objects, one for all targets) | see "What the cluster refuses" |

The controller (plugin `hermes-pods`) reads each target's token (env `MANYTHREADS_HERMES_PODS_DEPLOY_TARGETS`, set by the chart) and adds one context per target of the team to the deployer bot's kubeconfig, named after the namespace
and signed in as that namespace's own account; `current-context` stays the apps one. A target whose token is not ready yet is left out with a warning in the server log.

### What the cluster refuses (admission rule)

It applies to everyone who writes in a deploy target, including CNPG and cert-manager, so neither can be used to get round it. Pod security `baseline` already covers privileged pods, `hostPath`, host networking and host ports; the rule adds:

- every Ingress rule needs a `host` that is in the namespace's `manythreads.io/hosts` (a rule without a host would match every host), and so does every `tls` section;
- no default backend; ingress class only `traefik`; no `traefik.*` annotation at all;
- a Service is `ClusterIP` (no `NodePort`, `LoadBalancer`, `ExternalName`) with no `externalIPs`, `loadBalancerIP`, `loadBalancerSourceRanges`;
- a PersistentVolumeClaim may not name a volume or set a selector when created, and an update may not change either (only the volume controller — `system:kube-controller-manager` and the `kube-system` provisioners — may: its bind is exactly such an update, and refusing it leaves every claim Pending);
- no pod sets a `priorityClassName` (this covers the pods of Deployments, StatefulSets, Jobs and database Clusters whoever creates them), and a second `ResourceQuota` allows 0 pods at `system-node-critical` / `system-cluster-critical`;
- a Secret of type `kubernetes.io/tls` may be written only by cert-manager (`system:serviceaccount:cert-manager:cert-manager`);
- a cert-manager `Certificate` may name only the target's hosts (`dnsNames`, `commonName`), no IP, URI or e-mail names, no CA, and only an `Issuer` of its own namespace; an `Issuer` must be ACME with the Let's Encrypt production or staging address and plain `http01` solvers (no CA, selfSigned, Vault, Venafi, DNS or Gateway solvers, no solver ingress template).

cert-manager's challenge Service is a NodePort by default; the chart's Issuer now sets `serviceType: ClusterIP` (this also applies to the live Issuer in `http01` mode, harmlessly).

### Sizing

The quota (`deployTargetDefaults.quota`) is for one install plus one build at a time: 25 pods, 4 CPUs requested, 6Gi memory requested, **8Gi memory limits**, 8Gi ephemeral storage requested and **16Gi ephemeral-storage limits** (the disk pods write to, outside volumes), 6 volume claims, 12Gi of volumes, 12 services, 4 Ingresses, 12 Jobs, 60 Secrets, 40 ConfigMaps.
An install is about: database 1Gi limit, server 2Gi, web 0.5Gi, mail catcher 0.25Gi, seed Job 1Gi (a minute or two), cert challenge pod; a build pod is 4Gi. The node has 15 GB in all and the live site runs next to it:
lower `quota.limits.memory` if the live site gets squeezed. LimitRange: containers without settings get 50m CPU / 64Mi memory / 128Mi disk requested and a 512Mi memory / 2Gi disk limit; none may ask more than 6Gi memory or 10Gi disk. The kaniko containers ask for 4Gi memory and 10Gi disk each (they run one after the other, so a build counts once): 4Gi of the 8Gi memory and 10Gi of the 16Gi disk, leaving 4Gi and 6Gi for the install.
Disk is the tight resource (about 11 GB free on the node): the 16Gi disk quota is a ceiling, not a reservation, and a build rarely reaches it, but a build at its cap plus a busy install could still fill the node — the kubelet then evicts pods — so do not raise it above what the node can spare. A build uses up to 10Gi of node storage while it runs (limit set on the kaniko containers; the kubelet evicts the pod beyond it), the install's volumes are 4Gi, the registry volume is 10Gi.

## The registry

`registry.enabled: true` makes the namespace `manythreads-registry` with `registry:2.8.3`, a 10Gi volume (`registry.size`; **the node's disk is small and images are large — the server image alone is over 1 GB — so watch it and remove old tags**),
the Service `registry` (ClusterIP, port 5000) for pushes and the Service `registry-node` (NodePort `registry.nodePort`, default 30500, `externalTrafficPolicy: Local`) for the node's own pulls.
Names: a build pushes to `registry.manythreads-registry.svc.cluster.local:5000/<ns>/<image>:<tag>`; pods pull `registry.local:5000/<ns>/<image>:<tag>` (the same image).

**There is no sign-in on the registry.** Anyone in a deploy-target namespace can push and pull any image in it, including over another team's path; that is why only deploy targets are let in. **There is also no isolation between targets in it: before a second deploy target is added, the registry must get sign-in (per-target credentials and paths) or one registry per target,** otherwise one team's deployer can overwrite or read another team's images. The network policy allows ingress on 5000 from namespaces labelled
`manythreads.io/deploy-target=true` and from `registry.nodeCidrs` (default the node IP `10.0.2.15/32`); the registry may call nothing. Also keep port 30500 closed to the outside on the host firewall.
Deleting tags needs the registry's API and a garbage-collection run; the deployer cannot do either (no rights in that namespace), so an operator cleans up.

## Host step (once, as root on the node)

The node's container runtime pulls images itself, outside the cluster network, so it needs to know where `registry.local:5000` is. Create `/etc/rancher/k3s/registries.yaml`:

```yaml
mirrors:
  "registry.local:5000":
    endpoint:
      - "http://127.0.0.1:30500"
```

then `systemctl restart k3s`. (Restarting k3s restarts the containers it runs: expect a short blip of the live site. If the file exists already, add the mirror to it.)
Check: `curl -s http://127.0.0.1:30500/v2/` answers `{}`, and a pod using `registry.local:5000/...` pulls.

## Preview install

`deploy/preview/values-preview.yaml` is the chart's values for the install the bot runs with `helm upgrade --install` inside the target: no Hermes pods, no LiteLLM or Hindsight (the server starts without them; bot runs and memory answer that they are not configured), the mail catcher on, `tls.mode=letsencrypt` with `wildcard=false` (a
namespaced Issuer and Certificate, proved by HTTP-01 through Traefik), `tls.defaultStore=false`, images from the registry, `postgres.image=manythreads/postgres:19` (already on the node), the demo seed on.

`tls.defaultStore=false` matters: the chart normally makes the Traefik `TLSStore` named `default` (Traefik's fallback certificate); the live release owns it, and a second one in another namespace would fight it.

Objects rendered by `helm template -n test-manythreads -f deploy/preview/values-preview.yaml` (all namespaced, all inside the deployer Role): Deployment ×3 (server, web, mailpit), Service ×3, Job (the seed, a Helm hook),
PersistentVolumeClaim ×2, Secret ×4 (three database logins, the server's keys), Ingress, cert-manager Issuer and Certificate, CNPG Cluster; plus Helm's own release Secret. `deploy/preview/secrets.sh` creates the four Secrets ahead of time (the chart makes them when absent).

DNS: an A record `test.manythreads.kahf.to` pointing at the node, **DNS-only (not proxied)**, or the HTTP-01 challenge cannot reach Traefik.

## What is not protected

A deployer can run any image from the internet in its namespace (pods can reach the internet on 80/443 and the registry), read every Secret in it, and use the Let's Encrypt account only for its listed host. Pod security `baseline` is the floor
for containers; kaniko is root inside its container. A node-level escape from a root container would be a kernel bug, not something this setup allows. The preview is reachable from the internet: no real data in it.

## Needs a live test (none of this ran against the cluster)

1. After `helm upgrade` of the live release: the namespaces, Roles, policies exist; the controller logs and the deployer bot's kubeconfig gets the `test-manythreads` context (`kubectl config get-contexts`).
2. The Host step, then a pod pulling `registry.local:5000/...`; the registry NetworkPolicy lets the node's pull through (if not, add the address the pull arrives from to `registry.nodeCidrs`; the cni0 gateway is `10.42.0.1`).
3. A real build: kaniko under pod security baseline, the memory (4Gi) and disk (10Gi) limits, and pnpm install through the policy (internet 443).
4. The admission rule with real requests: an Ingress for another host is refused; the cert-manager challenge Ingress and ClusterIP Service are accepted; a CEL type warning in `kubectl get validatingadmissionpolicy manythreads-deploy-target-guard -o yaml` (`status.typeChecking`) is empty.
5. The CNPG Cluster comes up under the policies (operator reaching port 8000 and 5432; the instance reaching the API) and `helm uninstall` removes it.
6. The Certificate becomes ready; `/healthz` answers over HTTPS.
