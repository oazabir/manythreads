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
| `--insecure-release-url` | allow a release URL that starts with `http://` (a test network only; `https://` and a local file are the only forms accepted otherwise; also `manythreads upgrade` and `uninstall`) |
| `--public-ip ADDR` | when the lookup of the public address is not possible |
| `--calls` | turn calls on where the installer would ask first (behind Cloudflare) |
| `--no-calls` | leave calls out of this install |
| `--calls-network KIND` | `public`, `nat` or `local`: say what kind of network the machine is on instead of letting the installer test it (default `auto`) |
| `--no-firewall` | do not open the call ports in this machine's firewall; the exact lines are printed instead |
| `--kubeconfig FILE` | use an existing cluster; k3s is not installed |
| `--upgrade`, `--uninstall`, `--yes`, `--print-plan` | see `--help` |

## HTTPS

`auto` decides: a domain gives Let's Encrypt; no domain with a public address gives the `sslip.io` name with Let's Encrypt; neither gives a self-signed certificate on the
local address. Let's Encrypt is tried on the staging server first, then production; when staging fails the install falls back to self-signed and says so.

**Self-signed.** Browsers warn once. Machines that join as agent servers must trust that one certificate: the *Add a server* command then carries the certificate's
SHA-256, `curl -fsSLk --pinnedpubkey 'sha256//…' <site>/install/bridge.sh | sudo bash -s -- --enrol <code> --ca-sha256 <hex>`. `bridge.sh` reads the certificate the address shows,
refuses it unless the hash matches, keeps it as the only extra certificate the machine trusts for the site (`/etc/manythreads-bridge/site-ca.pem`, handed to the bridge as
`NODE_EXTRA_CA_CERTS`), and installs nothing when it differs. The certificate is valid ten years; after a new one, run `bridge.sh --update --ca-sha256 <new hash>` on each server
(the *Add a server* dialog always shows the command with the current hash).

**Do not rotate the certificate on its own.** The pin is the certificate's own key (the leaf), so every server enrolled with the old hash stops trusting the site the moment the certificate
changes, and `manythreads set-domain` or a re-install that makes a new self-signed certificate does that too. Before replacing it, list the enrolled servers (*Add a server*), make the new
certificate, then run `bridge.sh --update --ca-sha256 <new hash>` on each of them (the command the dialog shows has the new hash) before the old certificate is removed. A site with a
Let's Encrypt or Cloudflare certificate has no pin and nothing to re-enrol. The chart mounts the certificate into the server pod (`MANYTHREADS_SITE_CERT_FILE`) so the page can show the hashes.

## The `manythreads` command

Installed at `/usr/local/bin/manythreads` (checked against `hostCommandSha256` of the release):

| Command | What it does |
|---|---|
| `status`, `url`, `version` | what runs, the address, the version |
| `admin-password` | the first administrator's password, while it is still the one in use |
| `reset-admin-password [EMAIL]` | a new made-up password, printed once; the person chooses their own at the next sign-in |
| `backup-key` | the key that encrypts stored secrets and backups (keep a copy away from this machine) |
| `doctor` | checks the machine, the cluster and the site and says what is wrong |
| `logs [server\|web\|litellm\|hindsight\|db]`, `support-bundle` | logs; a bundle for a bug report (no secret in it) |
| `set-domain NAME` | change the address: asks for a certificate for the new one; the old name keeps working only when it is a name (a bare address has no certificate of its own and warns in the browser) |
| `allow-git-host URL` | let team pods clone from one more git host |
| `calls enable [--calls] [--calls-network KIND] [--public-ip ADDR] [--no-firewall]` | turn calls and TURN on for an install that has none, or move the call address after the machine's address changed; the same detection as a new install; downloads the installer of the release and checks it like `upgrade`; safe to run again |
| `calls check` | call health, one `PASS:` or `FAIL:` line each, exit code 1 when one fails; prints no key or token (see "Checking calls") |
| `upgrade [--version X.Y.Z]` | a backup first, then the new release over the old one; a lower version is refused; the installer it downloads is checked against `installSha256` of the release |
| `uninstall` | removes manythreads (asks for the word `delete`); downloads the installer of the release it was installed from and checks it the same way; removes only the namespaces the installer labelled as its own (`app.kubernetes.io/part-of=manythreads`), never by name |

State: `/etc/manythreads/install.env` (what was chosen), `values.yaml` (read on every upgrade), `calls.yaml` (written by `calls enable`), `domain.yaml`, `git-hosts.yaml`; the chart used is kept in `/var/lib/manythreads/chart`.
The log is `/var/log/manythreads-install.log`; no password is ever written there.

## Calls

A new install turns on voice and video calls with their TURN relay when the machine can carry them. The choice is written into the install's own `/etc/manythreads/values.yaml`
(never into the chart's `values-install.yaml`: every upgrade applies that file, and an install that has no call address would fail to upgrade). **An upgrade never changes
calls on an install that exists**; `sudo manythreads calls enable` is how an older install gets them. The install prints what it found and why, and `--calls-network` overrides it.

What is written for a machine that gets calls: `media.enabled: true`, `media.ingressPath: /livekit` (the signalling goes through the site's own address, `wss://<address>/livekit`),
`media.nodeIp` (the address browsers send audio to), `media.useExternalIp: false`, and TURN on over UDP 3478 without TLS (`media.turn.tlsPort: 0`).

| Machine | How it is recognised | What is added to the call address |
|---|---|---|
| (a) a public address | the public address is on the machine itself, or the machine can reach itself by it (a router that loops back) | the public address only |
| (b) behind a router that cannot reach itself by its public address | a public address was found, the machine's own address is private, and a test connection to the public address failed (or could not be run) | the public address, plus the private address (`media.advertiseInternalIp: true`), and the relay may reach it (`media.turn.allowRestrictedPeerCidrs: [<private address>/32]`) |
| (c) a local network only | no public address was found | the machine's private address, and the relay may reach it (`allowRestrictedPeerCidrs` with that /32); calls work for people on the same network |
| (d) plain HTTP (`--tls none`) | | **calls stay off**: browsers block the camera and the microphone on a page without HTTPS. The install says so; use HTTPS and run `calls enable` |
| (e) behind Cloudflare (`--tls cloudflare`, or the name points at Cloudflare) | | **asked first**: the audio goes straight to this machine, so a call tells everyone in it the server's real address. With no keyboard (a pipe, or `--yes`) calls stay off unless `--calls` is given |

The "can the machine reach itself" test connects to the machine's own public address on port 443 (during a first install it answers on that port for a few seconds itself). When it
cannot be run the machine is treated as (b), which also works where a router does loop back.

**Ports** (on the machine, and on a provider's network firewall or security group if there is one):

| Port | What |
|---|---|
| UDP 3478 | TURN |
| UDP 50000-50100 | audio |
| UDP 50101-50300 | TURN's relay |
| TCP 7881 | audio over TCP when UDP is blocked |
| TCP 7880 | LiveKit's signalling: **not opened to anyone**; it is reached only through the site's `/livekit` path (the pods may reach it from the pod network, 10.42.0.0/16 on k3s) |

The installer looks at the firewall first and acts only on one that is active: `ufw`, then `firewalld`, then `iptables` rules. A port that is open already is left alone. With no
active firewall no call port is opened (nothing here blocks them), and 7880 is closed to outsiders with one `iptables` rule that lets only the pods and the machine itself
in (it is lost at a restart unless your system saves iptables; `calls enable` puts it back, and `calls check` says when it is missing). With `--no-firewall` nothing is changed and
the exact lines for your tool are printed. A provider's network firewall cannot be seen from the machine: open the ports there yourself.

### Checking calls

`sudo manythreads calls check` prints one line each, `PASS:` or `FAIL:`, and exits with 1 when any fails: the media pod is ready; the signalling answers at `wss://<address>/livekit`
through the ingress; TURN answers on UDP 3478; each firewall port above is open; TCP 7880 is not open to outsiders; the configured call address is still the machine's address;
the server has the call address and key and reaches the media pod. It prints no key or token. It tests from the machine itself: a call between two different networks is the real
test, and from another machine `nc -zv <address> 7880` must fail.

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
