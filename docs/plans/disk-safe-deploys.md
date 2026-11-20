# P31-05 · Deploys and test-site builds that fit the disk

Owner approved the Next ten on 2026-11-19; this task is first. Plan written from a read-only measurement, then corrected by an independent review
(binding corrections below). The deploy guard stops a deploy above 90% and an image import at 95% (owner, 2026-11-19).

## What fills the disk (measured 2026-11-19, `/` at 81%, 19 GB free; 1% ≈ 0.96 GB)
- k3s containerd: 7.7 GB of content and 23 GB of unpacked snapshots, 30 images (server 1.35 GB compressed, claude-pod 1.34, workbench 1.0, hermes-pod 0.78, asr 0.75, web 0.12).
- Docker (containerd store): 3.8 GB build cache, one 0.65 GB image. Registry volume 0.66 GB.
- **The server image is one 1.35 GB layer that every source edit rebuilds:** `server.Dockerfile` runs `COPY . .` and then `pnpm install && chown -R` in one step. A deploy
  therefore holds the build cache, Docker's image and k3s's copy of the whole thing at once: an estimated 8–10 GB, about 90% from rest.
- `ci.sh` imports with a bare `docker save | ctr import`, without the guard's watch.
- Test-site builds (`deploy/preview/build-job.yaml`, kaniko) keep finished pods and their scratch space for a day (`ttlSecondsAfterFinished: 86400`).
- The guard's k3s prune is all-or-nothing (`crictl rmi --prune`): one unused image of this deploy skips it entirely, and otherwise it deletes every unused tag
  (on 2026-11-19 it removed a server tag a later hand retag relied on).

## Design (after review)
1. **Split the server Dockerfile** instead of a separate "thin" mechanism. The server runs from source with `tsx` (no compile step after the copy), so an image is
   "dependencies layer + sources layer". A `manifests` stage keeps only `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`; the final stage installs from
   those as `node` (no `chown -R` copy of the tree), then `COPY --chown=node:node . .`. Docker and kaniko reuse the install layer exactly when the lockfile,
   a manifest or the Dockerfile changed, which is the owner's rule by construction; `ctr import` skips the blobs k3s already holds, so k3s stores only the new layer.
   Release builds use `--no-cache`. No crane, no base image, no thin label.
2. **Keep what reuse needs.** At rest the disk is above the guard's 75% prune line, so every deploy runs `docker builder prune -af` and deletes the cache a reuse
   needs. The guard prunes with a size limit instead, and the dependencies layer survives between deploys (where it lives is settled by the spike, step 0).
3. **Selective k3s prune** in `disk-guard.sh`: keep every image a pod uses or waits for (Running and Pending; matched by image id or digest from
   `.status.containerStatuses[].imageID` and the pod spec, because Postgres runs by digest and is listed as `<none>`), every `--keep` image, `registry.local:5000/platform/*`
   and `hermes:stable`; remove the rest one by one.
4. **`ci.sh` imports through `disk-guard.sh import`.**
5. **Test-site Job:** `ttlSecondsAfterFinished: 3600`; the server build gets kaniko's layer cache (`--cache=true --cache-repo=<registry>/<namespace>/cache`), so a
   source-only build pushes and pulls only the sources layer.
6. **Registry clean-up CronJob** (nightly, `concurrencyPolicy: Forbid`, skipped while a build Job runs): keep the newest two tags of each `test-manythreads/*` repo,
   the newest cache entries, any tag a pod uses, and everything under `platform/*`; delete the rest through the registry's HTTP API; then scale the registry to 0,
   run `registry garbage-collect` (never `--delete-untagged`, MISTAKES: it removed the Postgres index's child manifests) on its volume, and scale it back to 1.
   RBAC: `deployments/scale` on the registry, read jobs and pods. The registry NetworkPolicy admits the CronJob. No `kubectl set env` on a Helm-managed object.
7. **Comments match the guard:** `deploy.sh` (says 88%), `docs/engineering/devbox.md` (says the import aborts at 90%); the guard's variables are named, not numbers.

## Order
0. **Spike:** the split Dockerfile, two builds with a one-file change, disk sampled every 2 s; check the image runs (tsx resolves, files owned by `node`).
1. Split Dockerfile + guard prune with a size limit (deploys).
2. Selective k3s prune and `ci.sh` import (with tests in `tools/devbox/test/disk-guard.test.ts`).
3. Test-site Job ttl and kaniko cache.
4. Registry CronJob (helm render tests: no `--delete-untagged`, `platform/*` kept, narrow RBAC).
5. Comments and docs; MISTAKES.md entry.

## Done
Two source-only deploys and two test-site builds in a row stay under 85% with no hand step (disk logged every 5 s), the build Jobs are gone after an hour, and the
next registry clean-up leaves two tags. A full build (the first after the change, or after a lockfile change) is measured on its own: it may reach the 90% guard,
and that is stated, not hidden.

## Risks
- The kubelet evicts at 95% and Postgres goes first: the proof stops at 85%, full builds keep the watched import.
- An image a pod needs being removed: both prunes read what pods use right before acting.
- A push during the registry's clean-up fails: the CronJob skips while a build runs, and the deploy waits for a running clean-up.
- Workspace `bin` links made before the sources arrive (`packages/runner`): checked in the spike.

## Result (2026-11-20)
- Deploys: full 84%; source-only with both installs reused 83% (143 s, was ~300 s). The second source-only deploy of the proof is the next task's.
- Test-site builds: kaniko cache on; a finished Job goes after ten minutes (its kaniko containers keep ~3 GB until then, so the hour of the design stacked builds). Builds C and D in a row: both installs reused, peak 84% and 84%, no hand step. The review's doubt about kaniko's `COPY --from` key was half right: it misses only when the source stage itself came from the cache; the build writes the tree id to `.build-source` so the stage always runs.
- Registry clean-up: run live by hand (delete, collect, restart in 22 s); the first nightly run is to be read on 2026-11-21.

