# Install manythreads with one command

For a fresh Linux machine (x86-64, systemd, 8 GB of memory or more, 40 GB of free disk or more, ports 80 and 443 free). One command installs k3s, helm, the database
operator, a certificate manager and manythreads, makes the first administrator, and prints the address and a first password once.

```sh
curl -fsSL https://<site>/install.sh | sudo bash -s -- --release-url <address of release.json>
```

`<site>` is any running manythreads (it serves `/install.sh` and `/install.sh.sha256`), or download `install.sh` from a GitHub release and check it against
`SHA256SUMS`. The default address of `release.json` is empty until the project's download address is decided; until then `--release-url` is required (an https address or a
file path). `release.json` names every image by digest, the chart, and the hash of `install.sh` and of the `manythreads` command; the installer checks all of them.

Read the script before you run it; the first lines say what it changes. It does nothing until every check on the machine has passed, and `--print-plan` prints every
step and choice without root and without changing anything.

## Options

| Option | Meaning |
|---|---|
| `--domain NAME` | the name people use; its DNS must point at this machine. Without it the machine's public address becomes `<a-b-c-d>.sslip.io` |
| `--admin-email ADDR` | the first administrator (default `admin@<address>`) |
| `--workspace NAME` | the organization's name |
| `--tls MODE` | `auto` (default), `letsencrypt`, `selfsigned`, `cloudflare`, `none` |
| `--origin-cert FILE --origin-key FILE` | with `--tls cloudflare` |
| `--release-url URL`, `--version X.Y.Z`, `--chart REF` | which release, which chart |
| `--public-ip ADDR` | when the lookup of the public address is not possible |
| `--kubeconfig FILE` | use an existing cluster; k3s is not installed |
| `--upgrade`, `--uninstall`, `--yes`, `--print-plan` | see `--help` |

## HTTPS

`auto` decides: a domain gives Let's Encrypt; no domain with a public address gives the `sslip.io` name with Let's Encrypt; neither gives a self-signed certificate on the
local address. Let's Encrypt is tried on the staging server first, then production; when staging fails the install falls back to self-signed and says so.

**Self-signed.** Browsers warn once. Machines that join as agent servers must trust that one certificate: the *Add a server* command then carries the certificate's
SHA-256, `curl -fsSLk --pinnedpubkey 'sha256//…' <site>/install/bridge.sh | sudo bash -s -- --enrol <code> --ca-sha256 <hex>`. `bridge.sh` reads the certificate the address shows,
refuses it unless the hash matches, keeps it as the only extra certificate the machine trusts for the site (`/etc/manythreads-bridge/site-ca.pem`, handed to the bridge as
`NODE_EXTRA_CA_CERTS`), and installs nothing when it differs. The certificate is valid ten years; after a new one, run `bridge.sh --update --ca-sha256 <new hash>` on each server
(the server prints the hash on the page, and `sudo manythreads url` / `sudo manythreads status` show the mode). The chart mounts the certificate into the server pod (`MANYTHREADS_SITE_CERT_FILE`) so the page can show the hashes.

## The `manythreads` command

Installed at `/usr/local/bin/manythreads` (checked against `hostCommandSha256` of the release):

| Command | What it does |
|---|---|
| `status`, `url`, `version` | what runs, the address, the version |
| `admin-password` | the first administrator's password, while it is still the one in use |
| `reset-admin-password [EMAIL]` | a new made-up password, printed once; the person chooses their own at the next sign-in |
| `backup-key` | the key that encrypts stored secrets and backups (keep a copy away from this machine) |
| `doctor` | checks the machine, the cluster and the site and says what is wrong |
| `logs [server\|web\|db]`, `support-bundle` | logs; a bundle for a bug report (no secret in it) |
| `set-domain NAME` | change the address: keeps the old one working, asks for a certificate for the new one |
| `allow-git-host URL` | let team pods clone from one more git host |
| `upgrade [--version X.Y.Z]` | a backup first, then the new release over the old one; a lower version is refused |
| `uninstall` | removes manythreads (asks for the word `delete`) |

State: `/etc/manythreads/install.env` (what was chosen), `values.yaml` (read on every upgrade), `domain.yaml`, `git-hosts.yaml`; the chart used is kept in `/var/lib/manythreads/chart`.
The log is `/var/log/manythreads-install.log`; no password is ever written there.

## The first password

The made-up password is 24 characters and is marked *must change*: the first sign-in asks for a new one before anything else. `sudo manythreads admin-password` shows it again
until it is changed.

## Memory classes

Under 7400 MB: stops. Under 15000 MB: *small* (agent pods off; they can be turned on later). Otherwise *full*. Disk under 40 GB stops, under 80 GB warns.

## Testing it

`tools/deploy-test/install-fresh.sh --release-json FILE --chart DIR` runs the whole install in a throwaway systemd container, checks the result and removes everything
(`--print-steps` lists the steps). The images in the release must be reachable, so run it for a release that is already pushed. Release tooling: `tools/devbox/release-images.sh`
(`plan`, `push`, `chart`, `manifest`; `push` needs `MANYTHREADS_GHCR_USER` and `MANYTHREADS_GHCR_TOKEN` and is never run by a test or by CI), and
`node tools/devbox/release-manifest.mjs check release.json`.
