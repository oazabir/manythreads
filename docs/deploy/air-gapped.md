# Air-gapped install

An air-gapped site has no route to the internet. This page says what the install needs from outside, how to bring it in, and what the project has and has not shown.

**Shown:** the list of images below is checked by a test against the files that decide it; a stage with a deny-all-outbound network policy still answers Brain (see "The drill"). **Not shown:** a real mirror. The project has no machine without internet, so carrying the images in, the k3s registry mirror setting and the speech models are written from the tools' own documentation and have not been run end to end here. Report any step that fails.

## What needs the internet, and when

| When | What | How to avoid it |
|---|---|---|
| Building the images | base images, npm packages (`pnpm install`), `apt` packages, pgvector from GitHub, the Hermes installer, the speech models (huggingface.co, cdn.jsdelivr.net) | Build on a machine that has internet and carry the finished images in (below). |
| Installing the add-ons | the database operator's chart and images | Carry the chart file and its images in. |
| Running | model providers, mail, git hosts, the apps your teams use | Bind the `local` alias to a model inside your network and use the `air-gapped` preset (below). The running site contacts nothing else by itself. |

## The images

Everything the install builds or pulls. A test (`tools/deploy-test/test/images.test.ts`) reads `tools/devbox/deploy.sh`, the Dockerfiles it builds from and the chart's `values.yaml`, and fails when a line is missing here or has a different tag. Lines marked `built` are made by `docker build` and have a tag of your choosing (the server and web take the commit); the others are pulled and listed with the exact tag the repository pins.

```text images
manythreads/server                  # built: deploy/docker/server.Dockerfile
manythreads/web                     # built: deploy/docker/web.Dockerfile
manythreads/hermes                  # built: deploy/docker/hermes.Dockerfile (Hermes Agent, the upstream installer)
manythreads/hermes-pod              # built: deploy/images/hermes-pod, the Hermes container of a team's pod
manythreads/workbench               # built: deploy/images/workbench, the bots' shell
manythreads/claude-pod              # built: deploy/images/claude-pod, a Claude Code or Codex runner
manythreads/claude-pod-fake         # built: deploy/images/claude-pod-fake, the test stand-in of the runner
manythreads/asr                     # built: deploy/images/asr, speech to text (only with asr.enabled)
manythreads/postgres                # built: deploy/postgres, the plain Postgres of the development compose file
manythreads/server-demo             # built: the demo stand-ins on top of the server image (demo and test installs only)
manythreads/demo-fakes              # built: the same, as a second image (demo and test installs only)
platform/postgres-cnpg:19beta4-202609281634-u999@sha256:bbbca16250b87aec1e6fe9c078d0dc0f0b10d6bbe563d0bef92e909a55da77d4    # built: deploy/postgres/cnpg.Dockerfile, kept in the in-cluster registry
node:22-slim                        # base of the server, web build, Hermes and Claude pod images
nginx:alpine                        # base of the web image
ghcr.io/speaches-ai/speaches:0.8.3-cpu@sha256:21e3df06d842fb7802ab470dd77c25f0e8c0d22950e8d8c6ae886e851af53ef8
mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a
postgres:19beta4@sha256:946fd10fdac8a0e72ee1fd40c1ef074b5c8bcdddfb94bfd1597524c664243f64
ghcr.io/cloudnative-pg/postgresql:19beta4-202609281634-standard-trixie@sha256:9ad505e94fa41c39b5d679987401ecf5b05dd15c8621068ce6101b4036acaca2
axllent/mailpit:v1.31
ghcr.io/berriai/litellm:main-stable
ghcr.io/vectorize-io/hindsight:0.10.3
livekit/livekit-server:v1.13.11
registry:2.8.3
```

Not in the list because they belong to the cluster, not to this repository: the images of k3s itself (listed by `k3s ctr images ls` on a working node, or in the k3s release notes for the version you install), Traefik, the database operator (`helm template cnpg cnpg/cloudnative-pg | grep 'image:'`) and, for HTTPS by Let's Encrypt, cert-manager (which cannot get a certificate without internet anyway; use your own certificate, `tls.mode: cloudflare` shows the shape).

`main-stable` is a moving tag: pull it once, then record its digest (`docker image inspect --format '{{index .RepoDigests 0}}'`) and use the digest from then on.

## Bringing the images in

On a machine with internet:

```sh
docker pull <image>                         # for every pulled image above
docker build ...                            # for every built image: the commands of self-host.md step 3 and 9
docker save -o manythreads-images.tar <image> <image> ...
```

Carry the file in (the chart and the operator's chart too: `helm pull cnpg/cloudnative-pg`), and on the k3s machine:

```sh
k3s ctr -n k8s.io images import manythreads-images.tar
```

The chart's `imagePullPolicy` is `IfNotPresent`, so an imported image is used and nothing is pulled. If your site has a registry of its own, point k3s at it instead with `/etc/rancher/k3s/registries.yaml` (a `mirrors:` entry per registry: `docker.io`, `ghcr.io`, `mcr.microsoft.com`; see the k3s page "Private Registry Configuration") and set `postgres.image` to the address you pushed the database image to.

## Models

- **Language models.** Run one inside your network (an OpenAI-compatible server such as vLLM or Ollama), add it under Workspace, LLM, Model providers with the box "Runs inside this deployment" ticked, and bind the alias `local` to it. Choose the guard preset `air-gapped`: it lets only the `local` alias through, and only while that alias really is local ([gateway-llm.md](../plugins/gateway-llm.md)). `smart` and `fast` stay unbound or are bound to local models too; the `embed` alias, which the memory engine uses, needs a local embedding model in the same way.
- **Speech to text in the browser.** The web image carries the Whisper and voice-activity files, listed with their SHA-256 in `clients/web/models.lock.json` and downloaded while the image is built ([deploy.md](../deploy.md), "Speech model files"). The running site serves them from itself and contacts nobody. `deploy/docker/web.Dockerfile` has no build argument for a mirror address today, so build the web image on a machine that can reach huggingface.co and cdn.jsdelivr.net and carry it in.
- **Speech to text on the server.** `manythreads/asr` carries its model inside the image (built with `deploy/images/asr`, which downloads it once); the running pod downloads nothing.

## Other things that reach out

Mail goes to your own relay. Git hosts, calendars and the other apps your teams connect are outside by definition: leave them unconnected. The `air-gapped` preset and a team's egress rule stop bots from sending anything else out; the deny-all policy below proves the pods themselves do not.

## The drill: a stage with no way out

`STAGE_PROFILE=airgap` on `tools/devbox/stage.sh` starts the stage with `deploy/helm/manythreads/values-stage-airgap.yaml`. Then:

```sh
tools/deploy-test/stage-profile.sh airgap up      # the NetworkPolicy: the stage's pods reach each other, the name service and the Kubernetes API, nothing else
tools/deploy-test/stage-profile.sh airgap check   # https://example.com fails from the server pod; the web pod still answers
```

Then ask Brain a question in the stage: the model calls go to the in-cluster stand-in, so it answers with the policy on. `airgap down` removes the policy.

This shows that the install runs without any outside address once the images are in. It does not show that every image can be mirrored, or that your model server meets the `air-gapped` preset: check those on your own network.
