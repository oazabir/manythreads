# Install spike, measured (P27-00, no virtual machine)

What this page is: the numbers behind the install journey plan (`docs/plans/onboarding-journey.md`, section 3 and 6.2), measured on the devbox on 2026-11-16 in
throwaway containers. Nothing on the live cluster was changed (only read). The parts that need a fresh virtual machine or the live stack are listed at the end
as not measured.

Words: **k3s** is a small Kubernetes (the system that runs containers across machines); a **namespace** groups the pieces of one install; **cgroup** is the
Linux feature that limits a program's memory and cpu; a **digest** is the fingerprint of one exact image.

## 1. Does `get.k3s.io` install and run k3s inside a container?

Yes, with three conditions. The container is the "fresh machine" of plan section 6.2.

| Item | Result |
|---|---|
| Base | `jrei/systemd-ubuntu:24.04` (282 MB; Ubuntu 24.04 with systemd as the first process), started `--privileged`, on its own Docker network, no published ports, `--memory 3g` |
| Install | `curl -sfL https://get.k3s.io \| INSTALL_K3S_VERSION=v1.36.5+k3s1 sh -s -` (the version the live site runs): the installer itself took 9 to 12 seconds |
| Ready | node `Ready`, CoreDNS, local-path, metrics-server and Traefik all `Running` about 25 to 60 seconds after the installer returned |
| Idle cost | 683 MiB of memory for the whole container (k3s, containerd, Traefik, CoreDNS, metrics-server); 1.1 GB on disk. With cert-manager (helm, 23 s) and the CloudNativePG operator (helm, 11 s) added: 1.37 GiB of memory, 1.5 GB on disk, 102 MiB of pod working set |
| Same kernel | the container shares the devbox's kernel (6.8, cgroup v2, `/dev/kmsg` present); the host's own k3s kept running with no restart |

The three conditions, each learned by failing first:

1. **The k3s state folders must be Docker volumes** (`-v name:/var/lib/rancher/k3s -v name2:/var/lib/kubelet`). Inside the container's own overlay file system, k3s stops with
   `overlayfs snapshotter cannot be enabled ... try using fuse-overlayfs or native`: an overlay cannot be mounted over an overlay.
2. **The container needs its own cgroup namespace** (`--cgroupns=private`) with cgroup2 mounted fresh inside it. The image declares `/sys/fs/cgroup` as a volume, which hides
   the cgroup mount and makes systemd exit with no message, so the container is started with the entry command
   `umount /sys/fs/cgroup; mount -t cgroup2 none /sys/fs/cgroup; exec /sbin/init`.
3. **Never bind `/sys/fs/cgroup` from the host or use `--cgroupns=host`.** The first attempt did, and the inner kubelet then put its pods in the host's own
   cgroup root, next to the live k3s's pod groups: the inner pods were killed again and again (every pod restarted within a minute) and the two kubelets share names. No
   live container was stopped (checked: no live container finished in that window), but the way is unsafe and is recorded in `MISTAKES.md`.

Result for plan decision 9: **the automated journey runs in a privileged systemd Ubuntu container; the nested virtual machine stays only as a fallback.** The
journey container also needs the candidate images served from a throwaway registry on the same Docker network (plan 6.2 step 2), and `get.k3s.io` and the
chart repositories reachable (they were).

## 2. Image sizes (what a customer's machine pulls)

Sizes are as the devbox's k3s reports them (`k3s crictl images`, read only). The numbers are the compressed layer total; unpacked on disk an image takes up to twice that.

| Image | Size | In the minimal profile | In the full profile | Pinned today |
|---|---|---|---|---|
| `manythreads/server` | 1.13 GB | yes | yes | built per release |
| `manythreads/web` | 115 MB | yes | yes | built per release |
| Postgres 19 with pgvector (`platform/postgres-cnpg`) | 221 MB | yes | yes | by digest (private registry; the release copies it to GHCR) |
| LiteLLM `main-stable` | 420 MB | yes | yes | no: a moving tag; digest to pin: see the install profile |
| Hindsight 0.10.3 | 931 MB | yes | yes | tag only |
| CloudNativePG operator 1.30.1 | 38.5 MB | yes | yes | tag only |
| cert-manager (controller, cainjector, webhook) v1.21.3 | 57 MB | yes (Let's Encrypt, self-signed) | yes | tag only |
| k3s system images (Traefik, CoreDNS, local-path, metrics-server, klipper-lb, pause) | about 125 MB | yes | yes | by the k3s release |
| `manythreads/hermes-pod` | 1.27 GB | off | yes | built per release |
| `manythreads/workbench` | 1.01 GB | off | yes | built per release |
| `manythreads/claude-pod` (the Claude and Codex pod) | 1.34 GB on the live node (the agent-pod build measured 5.23 GB in P26-08) | off | only with 16 GB or more | built per release |
| `manythreads/asr` (speech to text) | 992 MB | off | optional | built |
| mailpit 16.9 MB, livekit 41 MB, registry 10 MB, busybox 2 MB | small | off (mailpit, registry) | optional | tag only |

Totals pulled: **about 3.1 GB for the minimal profile** (server, web, database, LiteLLM, Hindsight, the two add-ons, k3s); **about 5.4 GB** with the Hermes pod and the workbench;
**about 6.8 GB** with the agent pod at the live node's size, **about 12 GB** with the 5.2 GB agent pod build. This replaces the plan's "about 10 GB" with a split.
Anonymous pulls from the public GHCR are not measured (the owner's token is not yet there, nothing is pushed).

The three outside GHCR and Docker Hub images the plan wants pinned by digest were resolved from the registries (`docker buildx imagetools inspect`, no pull);
the install profile `deploy/helm/manythreads/values-install.yaml` carries them.

## 3. Memory and disk of the minimal and the full profile

Read from the live node with `kubectl top pods` (working set, not limits) and `df`, 2026-11-16:

| Piece | Working set |
|---|---|
| Database (CloudNativePG, 1 instance) | 330 MiB |
| Server | 316 MiB |
| Web | 9 MiB |
| LiteLLM | 828 MiB (peak 958 MiB, measured 2026-10-28) |
| Hindsight | 914 MiB |
| CloudNativePG operator, cert-manager (three pods) | 42 and 74 MiB |
| k3s itself with Traefik, CoreDNS, metrics-server, local-path | about 690 MiB (the container measurement of section 1) |
| **Minimal profile (those)** | **about 3.2 GB** |
| Hermes pod of one team | 477 MiB (peak about 520) |
| Claude pod and Codex pod, idle | 86 MiB and 65 MiB (a working run adds the agent itself: gigabytes while it builds) |
| speech-to-text, media server | 129 MiB and 24 MiB |
| **Full profile on top of the minimal one** | **about +0.8 GB idle; plan for +4 GB while a team pod builds and tests** |

So 8 GB is enough for the minimal profile with head room for one build; the plan's rule (8 to 16 GB: one team pod at a time, pods off the claude pod; 16 GB and up: everything) stands.
The limits in the install profile are the live ones.

Disk: the images of the minimal profile are about 3.1 GB compressed (about 6 GB unpacked), k3s itself 1.1 GB, the database starts at 10 Gi reserved, the repository volume 5 Gi
(`values.yaml`). The plan's "stop under 40 GB free, warn under 80 GB" stays: a team pod's work volume (20 Gi for agent pods) and builds are what fill a disk.

## 4. Not measured here (needs the virtual machine or the live stack)

- Brain answering with memory through a runner of kind `llm_gateway` on a fresh install: needs a stack with a model behind LiteLLM. Decision 7 of the plan stays a plan; its fallback is unchanged.
  (The wizard of Phase 27 proves any runner with a real test turn before it lets the admin go on, so a wrong guess shows up as a failed step, not a silent gap.)
- A sample app brought up by the Deployer in an apps namespace from a `deploy/preview/README.md` on a clean machine.
- Anonymous pull speed and rate limits of the public GHCR packages; the install time of the whole journey on a 100 GB, 8 CPU, 16 GB machine.
- The nested virtual machine: not needed, the container works.
