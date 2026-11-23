# P35-03 · Every bot pull request arrives tested, with a test site

PLAN.md row: the Tester runs the full checks on an enrolled server (P31-06); each card's branch gets its own short-lived test site built in the
cluster (the P31-05 build Job), its link on the card, removed when the card closes; a deploy to a protected environment asks a chain of people by role
(the part of P18-03 a deploy needs).

## What there is (2026-11-23)
- One standing test site per team: the Deployer builds the tested commit in the cluster (`deploy/preview/build-job.yaml`, kaniko, layer cache at
  `<ns>/cache`, the Job goes 10 minutes after it ends) and installs the chart as release `manythreads` in `test-manythreads`
  (`deploy/preview/values-preview.yaml`, host test.manythreads.kahf.to, Let's Encrypt HTTP-01, CNPG Postgres on 2Gi). The release name is fixed by the
  chart, so a namespace holds one site.
- The deploy target (`deploy/helm/manythreads/templates/deploy-targets.yaml`) makes the namespace, the `deployer` service account limited to it, its
  quota and NetworkPolicies, and an admission rule that keeps Ingress and Certificate hosts to the namespace's `manythreads.io/hosts` annotation.
  `values-live.yaml` lists one target. The server may read each target's `deployer-token`.
- A card keeps `test_site_url` (tasks 0020); the Deployer sets it with `tasks.test_site`.
- A protected environment's deploy files one approval that only team leads decide (`tasks_deploy_request`, `approvals_request_task`); the approvals
  plugin already understands `roles` and `people` in an approval's scope.
- DNS: `*.manythreads.kahf.to` resolves to the devbox (DNS-only), so any new test host gets its certificate by HTTP-01 with no owner step.
- The devbox: 15 GB, about 7 GB available while the chain runs; disk 84–88% during builds (the watchdog prunes the build cache over 88%).

## Decisions
- **A pool of two slots, not a namespace per card.** A card leases a slot (`test-manythreads` at test.manythreads.kahf.to, and a new
  `test-card-2` at test2.manythreads.kahf.to) for as long as it is open; a third card is told the slots are busy and by whom. Hosts per card
  (`card-<8>.test…`) would need a controller with cluster rights to change the admission annotation: deferred.
- **Smaller sites.** `values-card.yaml`: about 0.6 GiB requested and 2.6 GiB at the limit per site, Postgres on an emptyDir (nothing left on disk
  after a teardown), no blob or repo volumes. One build at a time across the slots (a build lock on the lease).
- **The server tears a site down,** not a bot: when the card is done (merged or completed), when its pull request is closed, after 24 hours without a
  deploy, and after 72 hours whatever happens. It deletes the release's objects with the slot's own deployer token and clears the card's link.
- **Approval chain:** an environment may name up to three role tags; a protected deploy asks them in order, one person per step, and nobody decides
  two steps of one chain. No chain keeps today's rule (one lead). Parallel steps, thresholds, delegation, escalation and email links stay in P18-03.
- **Tester on an enrolled server (P31-06):** a Postgres cluster per team user started by the bridge's root helper (socket in the team's home, its own
  superuser, never the dev database's roles), and the Chromium the installer already puts in place; the run gets `MANYTHREADS_TEST_DATABASE_URL` and
  `PLAYWRIGHT_BROWSERS_PATH`. Where the binaries come from (the distro's PostgreSQL with pgvector, or bundled) is settled when that step starts.

## Steps (one commit each, `P35-03: …`)
1. Chart: a second target `test-card-2` (host test2…); a smaller quota per target; the build Job shares one layer cache across slots. Render test.
2. `deploy/preview/values-card.yaml` and a chart flag `postgres.ephemeral` (statefulset on an emptyDir). Render test: no volume claims, every
   container capped.
3. Tasks 0021: `app.test_site_slots` (seeded from the targets), `tasks_lease_test_site` (idempotent for the card; busy names the holders; one build
   lock of 40 minutes), `tasks.test_site_lease`; `tasks.test_site` accepts only the leased slot's host. DB tests: two cards, a third is busy, races.
4. The Deployer's BOT.md and `deploy/preview/README.md` take the namespace and host from the lease; busy is said in the thread and the card goes back to
   the Engineer.
5. Teardown worker in the tasks plugin: on `tasks.task.completed`, `pull_request_closed` and a ten-minute timer; deletes by the release's labels, its
   Helm Secrets and config maps, keeps `manythreads-server-secrets`, frees the slot, clears the link, writes `test_site_removed`. Tests against the
   fake Kubernetes API; a failed delete is retried; never a namespace outside the slot table.
6. Approvals 0009 and tasks 0022: the chain on an environment, step by step, one person per step; DB tests for two steps, a denial, the same person
   twice, a person without the role, no chain.
7. P31-06: the per-team Postgres in the bridge's root helper; the run's environment; the Tester's BOT.md runs the feature's e2e spec with one worker
   and writes NOT RUN only with the helper's reason.
8. Live proof: two cards build into the two slots, a third is told it is busy, finishing a card empties its slot within a minute (no pods, no
   volume claims, the link cleared, disk back), a two-role chain decided by two people records one deploy, the Tester runs a desktop spec on the devbox.

## Risks
- Disk: every new image layer also unpacks into k3s; the second slot must not take the devbox over 90% (watch every build; prune between).
- A host deployer needs its kubeconfig copied again for the new context (`docs/deploy-preview.md`).
- A link stops working when its slot is freed: the card says the site was removed.
