# Preview install: run a modified copy of manythreads in your own namespace

You are a team's deployer bot. This folder lets you build a copy of the platform from source that has your changes in it, install it into the
namespace `test-manythreads`, and look at it at `https://test.manythreads.kahf.to`. Nothing you do here touches the live site: you have full control
of that one namespace and no rights anywhere else. The background (what the cluster gives you, what is limited, what the operator did) is in
`docs/deploy-preview.md`; this page is the checklist.

Words used here, in plain terms: a *namespace* is a walled-off area of the cluster; a *patch series* is the list of your commits written out as
files (`git format-patch`); *kaniko* is a program that builds container images inside a pod, without a Docker daemon or root on the host; the
*registry* is the cluster's image store; *Helm* installs a bundle of cluster objects (the chart in `deploy/helm/manythreads`) and can remove them again.

Your kubeconfig has one extra *context* (a saved cluster + account + namespace) named `test-manythreads`; the default context is the apps one. Use
`--context test-manythreads` on every `kubectl` below and `--kube-context test-manythreads` on every `helm`. Run everything from the root of your
clone of the manythreads repository. Set these once:

```sh
NS=test-manythreads
K="kubectl --context $NS"
HOST=test.manythreads.kahf.to
SHA=$(git rev-parse HEAD)                     # the commit you tested
TAG=$(echo "$SHA" | cut -c1-12)               # names the images and the Job
BASE=$(git merge-base origin/main "$SHA")     # where your commits branch off the shared history
TREE=$(git rev-parse "$SHA^{tree}")           # the exact content you tested; the build refuses to run on anything else
```

The build fetches `$BASE` from GitHub, so `$BASE` must already be pushed there (it is, if it is on `origin/main`). Your own commits do not need to be.

## 1. Make the patch series and put it in a ConfigMap

```sh
rm -rf /tmp/preview-patches && git format-patch -o /tmp/preview-patches "$BASE..$SHA"
$K create configmap "patches-$TAG" --from-file=/tmp/preview-patches
```

A ConfigMap holds at most 1 MiB. If the patches are bigger, the change is too big for this path: split it, or push a branch and ask a person.

## 2. Make the Secrets (once per namespace)

```sh
sh deploy/preview/secrets.sh "$NS"      # database passwords and the encryption key; random, kept, never printed. A rerun changes nothing.
```

The chart would make the same Secrets itself when they are missing; this only does it first. (If the source needs a sign-in, also
`$K create secret generic build-git-token --from-literal=token=...` with a read-only token; the public source needs none.)

## 3. Build the two images

```sh
sed -e "s/__TAG__/$TAG/g" -e "s/__BASE_COMMIT__/$BASE/" -e "s/__TREE_SHA__/$TREE/" \
    -e "s/__PATCH_CONFIGMAP__/patches-$TAG/" -e "s/__NAMESPACE__/$NS/g" deploy/preview/build-job.yaml | $K create -f -
$K wait --for=condition=complete "job/build-$TAG" --timeout=40m || { $K logs "job/build-$TAG" --all-containers --tail=60; false; }
```

It takes 10 to 25 minutes. Watch with `$K logs -f "job/build-$TAG" -c build-server` (or `fetch`, `build-web`). If `fetch` says *tree mismatch*, the
patches do not give the tree you tested: you made them from a different commit than `$SHA`, or `$BASE` is wrong. Fix that; do not edit the check.
One build at a time (disk is small). Delete old build Jobs when done: `$K delete job build-<oldtag>`.

## 4. Install

```sh
helm --kube-context "$NS" upgrade --install manythreads ./deploy/helm/manythreads -n "$NS" \
  -f deploy/preview/values-preview.yaml --set imageTag="$TAG" --set tls.letsencrypt.email=you@example.org \
  --wait --timeout 20m
```

Keep the release name `manythreads` (the chart's object names are fixed). While you are still testing the setup, add
`--set tls.letsencrypt.server=staging` so Let's Encrypt's weekly limit is not used up (browsers will not trust a staging certificate).
`--wait` covers the database, the server, the web pod and the seed Job (the job that creates the demo workspace and people).

## 5. Check that it is up

```sh
$K get pods                                     # server, web, mailpit, the database pod: Running; the seed pod: Completed (or already deleted)
$K get cluster,certificate                      # the database "Cluster in healthy state"; the Certificate Ready=True (a minute or two)
curl -fsS "https://$HOST/healthz" && curl -fsS "https://$HOST/readyz"
```

If the Certificate stays not ready: `$K describe certificate manythreads-tls`, then `$K get challenges,orders`. The usual causes are a DNS record that is
not pointing at the cluster or is proxied (it must be DNS-only), or an Ingress refused by the admission rule (`$K get events`).
If a pod cannot pull its image (`ErrImagePull`), the node's registry mirror is not set up yet: tell a person (`docs/deploy-preview.md`, "Host step").

## 6. Sign in: set a password for a demo person

The demo people have random, unknown passwords. Set one for the person you want, through the server pod (the password is read from standard
input, never from the command line):

```sh
# the password lives only in a shell variable and in the pipe: no file, never echoed (umask 077 keeps any temporary file private anyway)
umask 077
PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
printf '%s\n' "$PW" | $K exec -i deploy/manythreads-server -- pnpm --filter @manythreads/server admin set-password omar@kahf.example
# to hand the password to the one who must sign in, put it in the handover note only; it is disposable and goes away with the preview
unset PW
```

The demo people are `omar`, `nadia`, `rafi`, `sameera`, `tariq`, `priya`, `lena`, each `<name>@kahf.example`. Sign in at `https://$HOST/`. Mail the app
sends (invitations, resets) goes to the mail catcher: `$K port-forward svc/manythreads-mailpit 8025` and open `http://127.0.0.1:8025`.
This password is disposable: it belongs to the preview and is destroyed with it (`helm uninstall` and the database volume, or an account reset).

## 7. Change something and redo

New commits: repeat steps 1, 3 and 4 with the new `$SHA` (a new `$TAG` means new images; the old ones stay in the registry).

## 8. Tear down

```sh
helm --kube-context "$NS" uninstall manythreads -n "$NS"
$K delete job --all; $K delete configmap "patches-$TAG" --ignore-not-found   # the build Jobs and the patch ConfigMap
$K delete secret manythreads-server-secrets manythreads-db-owner manythreads-db-app manythreads-db-system --ignore-not-found   # only for a truly fresh start
```

The uninstall removes the database and its volume, the volumes of the server and the Ingress. It leaves the encryption-key Secret (so a later install
can read what it stored) and the images in the registry (ask a person to clean the registry when its volume fills up).

## Things you cannot and must not do

- No other namespace, no cluster-wide object, no RBAC objects, no NetworkPolicy changes: the Role does not allow them.
- An Ingress may name only `test.manythreads.kahf.to`; a Service is ClusterIP only; no `hostPath`, host network or privileged pod (pod security `baseline`).
  The cluster refuses anything else with a message that names the rule.
- Do not put a real secret or a real person's data in this namespace: it is a test copy, reachable from the internet.
