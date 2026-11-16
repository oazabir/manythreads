# Deploy the starter app to the team's apps namespace

You are a team's Deployer bot. This page is the checklist for putting the starter app on the site's address, at `https://<the site>/apps/<team>/starter/`.
It runs from the root of your clone of this repository. Your default `kubectl` context already points at the team's apps namespace (`apps-<team>`): you may
change objects there and nowhere else. Give **each command its own call** (no `&&`, `;` or pipelines that create things) and never write a recursive delete.

Words used here: a *namespace* is a walled-off area of the cluster; a *ConfigMap* is a small set of files kept in the cluster; an *Ingress* is the rule that
publishes a Service on a web address. There is no image to build: the stock Node image runs the app's one file from a ConfigMap, because an apps namespace
allows no image builder, no root and no privileged pod. A deploy takes under a minute.

## 1. Read where you are

The first lines of your kubeconfig file are comments that name the site's address and the shape of an app's address. Read only those lines.

```sh
head -n 12 "${KUBECONFIG:-$HOME/.kube/config}" | grep '^#'
```

```sh
kubectl config view --minify -o jsonpath='{..namespace}'
```

The first command shows `# Apps are reached at https://<host>/apps/<team>/<app>/ ...`; the second prints the namespace (`apps-<team>`). Then set, once:

```sh
HOST=$(sed -n 's|^# Apps are reached at https://\([^/]*\)/apps/.*|\1|p' "${KUBECONFIG:-$HOME/.kube/config}" | head -n 1)
TEAM=$(sed -n 's|^# Apps are reached at https://[^/]*/apps/\([^/]*\)/.*|\1|p' "${KUBECONFIG:-$HOME/.kube/config}" | head -n 1)
NS=$(kubectl config view --minify -o jsonpath='{..namespace}')
SHA=$(git rev-parse HEAD)            # the commit Tester recorded as tested
TAG=$(echo "$SHA" | cut -c1-12)
echo "$HOST $TEAM $NS $TAG"
```

If `HOST` or `TEAM` is empty, the site routes apps by host name instead of by path: read the comment lines again and follow the address they give (an Ingress host
`starter--<team>.<host>`, no `traefik` annotation); say in the thread what you changed. If you cannot tell, stop and hand the card back with what you saw.

## 2. Put the source in a ConfigMap

The name carries the commit, so a new commit is a new rollout and an old one stays for a rollback.

```sh
kubectl create configmap "starter-src-$TAG" --from-file=server.mjs
```

Read the name back (`kubectl get configmap -n "$NS"`) and compare it with `starter-src-<TAG>` character by character before you go on.

## 3. Apply the objects

```sh
sed -e "s/__TAG__/$TAG/g" -e "s/__TEAM__/$TEAM/g" -e "s/__HOST__/$HOST/g" -e "s/__NAMESPACE__/$NS/g" deploy/preview/starter.yaml > ~/starter-$TAG.yaml
```

```sh
kubectl apply -f ~/starter-$TAG.yaml
```

If the cluster refuses an object, its message names the rule (for example the Ingress shape). Fix what you sent, never the rule.

## 4. Wait and check

```sh
kubectl rollout status deployment/starter --timeout=3m
```

```sh
kubectl get pods -l app=starter
```

A pod that is not Running after a minute: `kubectl describe pod -l app=starter` and read the events (an image that cannot be pulled means the node has no way out
to the internet; tell a person).

```sh
curl -fsS "https://$HOST/apps/$TEAM/starter/healthz"
```

`ok` is the answer. The page itself is at `https://$HOST/apps/$TEAM/starter/` (the site keeps the app in a sandbox, so it has no cookies and no sign-in).
Hand the address, the commit and "no accounts to sign in with" to Web smoke tester.

## 5. Change something and redo

A new commit: repeat steps 2 to 4 with the new `$SHA`. Delete the older ConfigMap only after the rollout finished: `kubectl delete configmap starter-src-<oldtag>`.

## Tear down

```sh
kubectl delete deployment,service,ingress starter
```

## What you cannot do

No other namespace, no cluster-wide object, no RBAC, no `tls` section on the Ingress, no other `traefik.*` annotation, no host other than the site's.
