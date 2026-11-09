# Install on one machine with Docker Compose

This page takes one Linux machine with Docker to a running manythreads: a first administrator who can sign in, a team, and the workspace Brain answering questions through the Hermes container. It is the short path for a trial or a small team. For more than one machine, or for the project's own production, use [self-host.md](self-host.md) (Kubernetes).

**This page is tested.** `tools/compose-test/run.sh` builds the images from a clean copy of the repository, starts the five containers, runs the same `admin init` command as below, asks Brain a question and checks the answer, then removes everything. It runs every night on the project's build machine (`.github/workflows/compose.yml`). The test uses a stand-in model provider and fixed passwords (`deploy/compose/docker-compose.test.yml`, `tools/compose-test/test.env`); the install below has neither. See "What the test proves" at the end.

## What you get

Five containers, started by `deploy/compose/docker-compose.yml`:

| Container | What it does |
|---|---|
| `postgres` | The database. The application, the model gateway and team memory each have their own database in it. |
| `litellm` | The model gateway. Every model call of the install goes through it, and it holds the provider keys you add in the app. |
| `hindsight` | Team memory. Only Postgres, the model gateway and the manythreads container can reach it. |
| `manythreads` | The server **and** the web client. It serves the app's pages itself, so there is no separate web server. |
| `hermes` | The agent runtime the bots run on. It shares a volume of bot profiles with the manythreads container. |

Only the web port is published, and by default only on this machine (`127.0.0.1:3000`). Put a reverse proxy with HTTPS in front of it for real use (see "Open it to other people").

## What you need

- One x86-64 Linux machine with [Docker](https://docs.docker.com/engine/install/) and the Compose plugin (`docker compose version` works), `git` and `openssl`.
- Free disk and memory: see "Measured" at the end. Plan for about 15 GB of disk for the images and 6 GB of free memory while it starts.
- Internet access while you build. The builds download base images, packages and (for the web client) the speech model files. Without internet, see [air-gapped.md](air-gapped.md).
- A model provider (an API key for OpenAI, Anthropic or another service, or the address of one you run). The install starts without one, but Brain cannot answer until you add one in step 4.

## Step 1. Get the code and make the settings

```sh
git clone https://github.com/manythreads/manythreads.git
cd manythreads
sh deploy/compose/make-env.sh http://localhost:3000
```

`make-env.sh` writes `deploy/compose/.env` with every password and key generated (mode 0600) and prints only the file's name. Use the address people will open in the browser instead of `http://localhost:3000`. Nothing in the repository or the images has a default for a password: if a value is missing, `docker compose up` stops and names it. [.env.example](../../deploy/compose/.env.example) lists them all.

**Keep a copy of `.env` somewhere private.** The database passwords are fixed the first time the database volume is made, and `MANYTHREADS_KMS_KEY` unlocks every secret the install stores (provider keys, tokens). Lose it and they are gone.

## Step 2. Build and start

```sh
docker compose -f deploy/compose/docker-compose.yml up -d --build --wait
```

The first run builds three images (the database with pgvector, the server with the web client, and Hermes) and pulls two (LiteLLM and Hindsight). That takes several minutes. `--wait` returns when all five containers report healthy. Check with:

```sh
docker compose -f deploy/compose/docker-compose.yml ps
```

## Step 3. Make the first administrator

```sh
docker compose -f deploy/compose/docker-compose.yml exec manythreads manythreads-admin init --email you@example.org --name "Your Name" --workspace "Your Workspace" --team General
```

With no password on standard input, the command makes one up and prints it once at the end: keep it. To choose your own, pipe it in (it is read from standard input, never from the command line):

```sh
printf '%s' 'a long password' | docker compose -f deploy/compose/docker-compose.yml exec -T manythreads manythreads-admin init --email you@example.org
```

It does four things, and it is safe to run again:

1. Makes the workspace and its owner (the same first-run step the browser offers, with the same password rules). If a workspace exists, it signs in with the email and password you give.
2. Makes the first team, unless one exists.
3. Registers the Hermes container as the workspace's default bot runner, and makes the model keys the Hermes container and team memory use.
4. Writes the Brain's profile into the volume the Hermes container shares, and waits until Hermes answers for it.

`admin brain-profile --email ...` does only the last step (for example after you restore a backup). Open the address from step 1 and sign in.

## Step 4. Add a model provider

In the app: Workspace, then LLM. Add your provider and bind the aliases `smart`, `fast` and `code` to its models. Brain asks for `smart`; team memory asks for `fast`. Then open the team, open Brain in the bots list and ask it something.

## Open it to other people

- Put a reverse proxy (Caddy, nginx, Traefik) in front of port 3000 with HTTPS, and set `MANYTHREADS_PUBLIC_URL` to the public address and `MANYTHREADS_TRUST_PROXY=1` in `.env`. Then `docker compose ... up -d` again.
- Publish the port on every interface only if you have no proxy: set `MANYTHREADS_BIND=0.0.0.0` in `.env`.
- For invitation and password-reset mail set `MANYTHREADS_SMTP_URL` and `MANYTHREADS_MAIL_FROM`. Without them the server logs that mail was not sent.

## Look after it

- **Logs:** `docker compose -f deploy/compose/docker-compose.yml logs -f manythreads` (or `hermes`, `litellm`, ...).
- **Update:** `git pull`, then step 2 again. The server runs its database migrations at start.
- **Back up:** the data is in three named volumes (`pgdata`, `data`, `hermes_profiles`) and in `.env`. For the database: `docker compose ... exec -T postgres pg_dump -U manythreads_owner -Fc manythreads > manythreads.dump`, the same for the `hindsight` database, and copy the `data` volume (attachments and team repositories). [backup.md](backup.md) describes what a complete set holds; the scripts there are for Kubernetes.
- **Stop:** `docker compose ... down` keeps the data. `docker compose ... down -v` removes the volumes too: everything is gone.

## What is different from the Kubernetes install

- One machine, one copy of each container, no failover. A restart of the machine brings it back (the containers restart unless stopped).
- The bot containers of the Kubernetes install (Claude and Codex pods) are not part of this file. Bots run on the Hermes container.
- No monitoring, no automatic backups, no network policy beyond the `memory` network.

## What the test proves

`tools/compose-test/run.sh`, from a clean copy of the commit:

1. `docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build --wait` brings the five containers and the stand-in model provider (`fake-llm`) to healthy.
2. `manythreads-admin init` makes the administrator, the team, the runner and the Brain profile, and the runner test passes; running it again changes nothing.
3. The web client is served at `/` and at a deep link.
4. A provider and the aliases are set through the API, a question is posted to Brain in its conversation, and Brain's reply, which went through the Hermes container, LiteLLM and the stand-in, comes back with the seeded fact.
5. `docker compose down -v` leaves no container, volume or network of the project, and the test removes the images it built.

The test cannot tell you that your own model provider works, that HTTPS and your proxy are right, or that mail is delivered.

## Measured

From the test on the devbox (a clean copy of the commit, 2026-11-09):

- Build and start to healthy: about 6.5 minutes (392 s). The whole test, with the Brain question and the clean-up, took about 8.5 minutes (516 s).
- Memory: the six containers together peaked at about 2.3 GB. The whole machine was using about 9.6 GB at the peak, with other work running.
- Disk: about 15 GB for the images and the build cache while it runs. The test removes the images it built.
- An earlier run with a warm build cache took 369 s to build and start. A start without any rebuild was not measured.

These are one machine's numbers. Hindsight is the biggest user of memory; keep 6 GB free while it starts.
