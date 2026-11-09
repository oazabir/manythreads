# Install on a fresh k3s, command by command

This page takes one empty Linux machine to a running manythreads with a first administrator who can sign in. It is the short path: no HTTPS, no model provider, no mail. When it works, go on with [self-host.md](self-host.md) for those.

**Every command in the blocks marked `k3s-test` is run by a test, as written.** `tools/deploy-test/k3s-fresh.sh` starts a new k3s in a container on the project's build machine, takes these blocks out of this file (the fence says `sh k3s-test`) and runs them in order, then checks that `/readyz` answers 200 and that the first administrator can sign in. A command that stops working breaks the test, so this page cannot drift from what works. The k3s install in step 1 is the one thing the test replaces: it starts k3s in a container instead.

## What you need

- One x86-64 Linux machine with root access, [Docker](https://docs.docker.com/engine/install/), [Helm](https://helm.sh/docs/intro/install/) and `kubectl`, and a copy of this repository.
- About 8 GB of free disk for the images and 6 GB of free memory while it starts. (Estimates, not limits: the three images are about 3 GB, and the cluster uses about 2 GB of memory with the database, the server and the web pod.)
- Access to the internet while you build and install. The builds download base images and packages. Without internet, read [air-gapped.md](air-gapped.md).

## Step 1. Install k3s

k3s is a small Kubernetes. Its installer also puts in Traefik (it routes web traffic into the cluster) and the `local-path` storage class. The chart uses both.

```sh k3s-install
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

Wait until the node has registered and is ready (the first seconds after the install, `kubectl get nodes` lists nothing):

```sh k3s-test
until [ -n "$(kubectl get nodes -o name 2>/dev/null)" ]; do sleep 2; done
kubectl wait --for=condition=Ready node --all --timeout=300s
kubectl get nodes
```

## Step 2. Build the three images and load them into k3s

There is no image registry. You build on the machine and import into k3s's own container store. The chart's `imagePullPolicy` is `IfNotPresent`, so it uses what you imported.

```sh k3s-test
export TAG=$(git rev-parse --short HEAD)
docker build -f deploy/docker/server.Dockerfile -t manythreads/server:$TAG .
docker build -f deploy/docker/web.Dockerfile    -t manythreads/web:$TAG .
docker build -f deploy/postgres/cnpg.Dockerfile -t manythreads/postgres-cnpg:19beta4-202609281634-u999 deploy/postgres

for IMG in manythreads/server:$TAG manythreads/web:$TAG manythreads/postgres-cnpg:19beta4-202609281634-u999; do
  docker save "$IMG" | k3s ctr -n k8s.io images import -
done
```

The database image is CloudNativePG's Postgres 19 build with pgvector added. The build clones pgvector from GitHub, which is why it needs the internet. The chart's default database image lives in the project's own registry, which you do not have, so step 4 overrides it.

## Step 3. Install the database operator

The database runs under CloudNativePG, a Kubernetes add-on. `--wait` returns when the operator is ready to accept a database.

```sh k3s-test
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait --timeout 10m
```

cert-manager (Let's Encrypt certificates) is not needed for this page. [self-host.md](self-host.md) has it for HTTPS.

## Step 4. Install manythreads

This file keeps your choices, so that every later upgrade repeats them. Change the host name to yours. `seed.demo: false` is required: with the default the chart makes a demo workspace and no first-administrator link appears. `publicUrl` starts with `http://` because this page has no HTTPS; without that, the server sets cookies that a browser drops over plain HTTP.

```sh k3s-test
cat > my-values.yaml <<EOF
imageTag: "$TAG"
domain: manythreads.example.com
publicUrl: http://manythreads.example.com
seed:
  demo: false
mailpit:
  enabled: false
litellm:
  enabled: false
hindsight:
  enabled: false
hermesPods:
  enabled: false
postgres:
  image: manythreads/postgres-cnpg:19beta4-202609281634-u999
EOF

helm upgrade --install manythreads ./deploy/helm/manythreads -n manythreads --create-namespace -f my-values.yaml
```

`litellm`, `hindsight` and `hermesPods` are off here to keep the first install small: no model answers and no bots yet. Turn them on in step 8 of [self-host.md](self-host.md) once you can sign in.

The first start takes a few minutes: the database comes first, then the server, which applies its migrations. Wait for both:

```sh k3s-test
kubectl -n manythreads rollout status deploy/manythreads-server --timeout=900s
kubectl -n manythreads rollout status deploy/manythreads-web --timeout=300s
kubectl -n manythreads get pods
```

> **Save the encryption key now.** The chart made a key that encrypts stored provider keys and tokens. It is **not** in the database backups, and a restored database cannot be read without it. Print it and keep it in your password manager; never commit it.
>
> ```sh
> kubectl -n manythreads get secret manythreads-server-secrets -o jsonpath='{.data.kms-key}' | base64 -d
> ```

## Step 5. Check that it is healthy

The cluster has no public name yet, so reach the web pod through a port-forward on this machine. Leave it running for the next step.

```sh k3s-test
kubectl -n manythreads port-forward svc/manythreads-web 8080:80 >/dev/null 2>&1 &
for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:8080/readyz && break; sleep 2; done
curl -fsS http://127.0.0.1:8080/healthz; echo
curl -fsS http://127.0.0.1:8080/readyz; echo
```

`/healthz` answers `{"status":"ok", ...}` and `/readyz` answers `{"status":"ready", ...}`. A 503 from `/readyz` says "Migrations pending" while the server is still starting.

## Step 6. Create the first administrator and sign in

While the database holds no workspace, every server start writes one log line with a single-use setup link. The token is the last part of it.

In a browser you would open that link and fill in the form. The same thing from a terminal, with a password of your own choice (at least 8 characters):

```sh k3s-test
TOKEN=$(kubectl -n manythreads logs deploy/manythreads-server | sed -n 's|.*first-admin setup: open [^ ]*/bootstrap/\([^ ]*\) to create.*|\1|p' | tail -n 1)
test -n "$TOKEN"
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD='a-long-password-of-your-own'
curl -fsS -X POST "http://127.0.0.1:8080/api/bootstrap/$TOKEN" -H 'content-type: application/json' \
  -d "{\"workspaceName\":\"My team\",\"name\":\"First Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" -o /dev/null -w 'workspace created: HTTP %{http_code}\n'
```

The link works once. Now sign in as that person from a clean start, and ask who the session belongs to:

```sh k3s-test
JAR=$(mktemp)
curl -fsS -c "$JAR" -X POST http://127.0.0.1:8080/api/auth/password/sign-in -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" -o /dev/null -w 'signed in: HTTP %{http_code}\n'
curl -fsS -b "$JAR" http://127.0.0.1:8080/api/session | grep -q "$ADMIN_EMAIL" && echo "the session belongs to $ADMIN_EMAIL"
rm -f "$JAR"
```

If you lose the link before using it, restart the server (`kubectl -n manythreads rollout restart deploy/manythreads-server`) and read the log again: the old link is discarded and a new one is written.

## What to do next

- HTTPS, mail, a model provider, memory and bots: [self-host.md](self-host.md).
- Backups, copying them off the machine and the restore drill: [backup.md](backup.md).
- Metrics, alerts and traces: [monitoring.md](monitoring.md).
- A machine with no internet: [air-gapped.md](air-gapped.md).

## Run the test yourself

On a machine with Docker, Helm, kubectl and this repository (the test starts its own k3s in a container, which needs `--privileged`):

```sh
flock /tmp/manythreads-test.lock tools/deploy-test/k3s-fresh.sh
```

It refuses to start when the disk is more than 80 % full, when a CI run or a stage is up, or when another copy is running. It takes about 10 minutes and 3 GB of disk, and it removes its container, network, volume and images when it ends, whatever the outcome. Its log goes to `/tmp/k3s-fresh.log` (set `K3S_FRESH_LOG` to move it).
