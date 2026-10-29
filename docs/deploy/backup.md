# Backups and restore

How a manythreads install on Kubernetes protects its data, how to get that data back, and how to prove the restore works before you need it. The tools live in `tools/backup/`, the nightly job in the Helm chart (`deploy/helm/manythreads/templates/backup.yaml`).

## What is backed up

One **set** is written per run, as a folder named by its UTC time (for example `20261029T021700Z`):

| File | What it is |
|---|---|
| `db-manythreads.dump` | the application database (people, channels, messages, tasks, the event log, and so on), `pg_dump` custom format |
| `db-hindsight.dump` | the memory engine's database (only when listed under `backup.databases`; the live site lists it) |
| `db-<name>.settings.sql` | the per-database role settings (`search_path`) that a dump does not carry |
| `blobs.tar` | the attachment store: uploaded files and the originals dropped into inboxes. Only with the local store (see "Object storage" below) |
| `repos.tar` | the team repositories: pages, bot definitions, memory files |
| `manifest.txt` | when it was taken, the app version, the size and SHA-256 of every file, and row counts of the key tables; ends with `complete=yes` |
| `sha256sums.txt` | the same checksums in the format `sha256sum -c` reads |

The database is dumped first, inside one snapshot, so the row counts in the manifest describe exactly what the dump holds. The two tars are taken afterwards: an extra file is harmless, a row pointing at a missing file is not.

**Not in a set, on purpose:**
- Kubernetes Secrets. The one that matters is `manythreads-server-secrets` (key `kms-key`): it unlocks the provider keys stored in the database. Without it the database restores but those keys cannot be read and must be typed in again. Save it separately with `tools/backup/pull.sh --with-secrets` and keep it somewhere more private than the backups.
- Container images, the volumes of team bot pods, and mail caught by the demo mail catcher.

## Schedule, retention, where it lives

The chart's `backup:` values control it. It is **off** in `values.yaml` and **on** in `values-live.yaml`.

| Value | Default | Meaning |
|---|---|---|
| `backup.enabled` | `false` | turn the nightly job on |
| `backup.schedule` | `17 2 * * *` | cron expression, UTC |
| `backup.retention` | `7` | how many sets to keep; the oldest are deleted after each good run |
| `backup.databases` | `[manythreads]` | databases to dump |
| `backup.storage.size` | `10Gi` | size of the backups volume; allow `retention` + 1 times (dump + used blob space + used repository space): the new set is written before the oldest is removed |

Enable on any install: `helm upgrade manythreads deploy/helm/manythreads --reuse-values --set backup.enabled=true`. The job writes into the volume `manythreads-backups` (kept when the release is uninstalled). A run that fails leaves no half set and deletes nothing; look at it with `kubectl -n manythreads get jobs` and `kubectl -n manythreads logs job/<name>`. Run one now: `kubectl -n manythreads create job --from=cronjob/manythreads-backup backup-now`.

The volume is bound by the first run (the cluster's storage class waits for a pod to use it), so `helm upgrade --wait` shows it as Pending the first time backups are switched on: roll out that first time without `--wait`, or accept the wait running out; the next upgrade after a first run is clean.

The dump connects as `manythreads_owner`, the only login that can read every row (the application and system roles are limited by row-level security, the database's per-row visibility rules). Its password is read from the existing Secret and is mounted in that one pod only.

## Copy sets off the box

A set on the same disk as the data is protection against a mistake, not against losing the machine. Copy sets to somewhere else:

```
tools/backup/pull.sh --dest /srv/manythreads-backups --with-secrets
```

Run it from a different machine that has `kubectl` access to the cluster (a laptop, a second server). It copies the newest set, checks every checksum on arrival, refuses to overwrite a set it already has, and with `--with-secrets` also saves the key Secret as `secrets-<namespace>.yaml` (mode 600). Schedule it from that machine (cron, a systemd timer), then let that machine's own backup, or `rclone sync` / `aws s3 sync` to a bucket, carry the folder further. Delete old copies there yourself; `pull.sh` never deletes.

## Object storage (`server.storage.type=s3`)

With the S3 store the attachment bytes live in your bucket, so `blobs.tar` is not made (the manifest says `blobs=not-included`). Protect the bucket itself: turn on versioning and, for a disaster copy, replication to another bucket or region. A database set only helps if the bucket still holds the objects its rows point at. Never point the garbage collector (`server.blobGc.mode=on`) at a restored database before the bucket is the one it describes.

## Restore, step by step

Use a **new namespace first** (a rehearsal) and the live one only when you mean it. Assumes `kubectl` can reach the cluster that holds the backups volume (for a rebuilt machine, copy a pulled set back first; see step 5).

1. Install the chart into the namespace you restore into, as for a normal install (`helm install ...`). Before that, for a total rebuild, apply the saved key Secret: `kubectl -n <ns> apply -f secrets-<namespace>.yaml` (the chart keeps an existing Secret). Wait until the database pod is ready.
2. See what would happen, changing nothing: `tools/backup/restore.sh --set latest --target-ns <ns> --check-only`. This verifies the set's checksums.
3. Restore: `tools/backup/restore.sh --set 20261029T021700Z --target-ns <ns>` (or `--set latest`). It stops the server, restores each database from its dump into a scratch database and, only when that finished, swaps it in for the current one (a damaged dump leaves the current database untouched), replaces the contents of the blob and repository volumes, and starts the server again. It asks you to type the namespace name first (`--yes` skips that). If it stops half way it leaves the server stopped on purpose; fix the cause and run it again.
4. Check: `/readyz` answers, you can sign in, an attachment opens, a team's Files screen shows its pages.
5. Restoring into the **live** namespace needs `--force-live`; the script refuses without it. To restore on a rebuilt machine whose backups volume is empty, put the pulled set where the script can read it: install the chart with `backup.enabled=true`, copy the set folder into the volume with `kubectl cp` through a pod that mounts `manythreads-backups`, then run the steps above with `--source-ns` naming that namespace.

After restoring an old set, the garbage collector for attachments compares the store's marker with the database's and refuses to delete when they differ. A restore of a matching set and store keeps them equal; if you restore only the database into an older bucket, set `server.blobGc.adoptMarker=true` once (see the values file comment).

The restore runs from your machine and streams the files through `kubectl exec`, staging each in the helper pod's scratch disk first: keep free disk equal to the largest file of the set on the node.

## Run the drill

The drill restores the newest set into a throwaway namespace with its own scratch Postgres, **without touching the live install**, checks the result, and deletes the namespace:

```
tools/backup/drill.sh                  # newest set
tools/backup/drill.sh --set 20261029T021700Z --keep   # keep the scratch namespace to look around
```

It checks that every row count in the manifest matches the restored database, that every attachment file is back and one reads back byte for byte, and that every team repository is back with a `HEAD`. It prints `PASS` or `FAIL` (exit code 0 only on PASS) and:

- **RPO** (recovery point objective: how much recent work you can lose): the age of the set. Worst case is one schedule interval plus the run time, so about 24 hours and a few minutes with the default schedule. Run the job more often (`backup.schedule: "17 */6 * * *"`) to shrink it; the volume must then hold more or `retention` must grow.
- **RTO** (recovery time objective: how long until you are working again): seconds from the start of the restore to a verified database and volumes. It excludes provisioning a machine or cluster and installing the chart. It grows roughly with the size of the set; record the number from your own install after the first drill and run the drill after every upgrade of Postgres or the chart, and at least monthly.

A passing drill proves the set is whole and restorable by this procedure, not that your off-box copy exists: check that separately.

## Limits

- The set is one consistent snapshot of the database but the volumes are copied a little later; a restore may find a file or repository commit the database does not mention yet. The server tolerates both (unreferenced files are collected later, a repository index heals itself from git).
- A dump restores into the same Postgres major version or a later one. The image is pinned in `postgres.image`; do not change it without a drill.
- The restore replaces the database, volumes and server replica count of the target namespace; other pods (team bots, the memory engine) keep running and reconnect.
