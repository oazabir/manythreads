# Add a server

A **server** is a machine of your own (a build box, a workstation, a cloud machine) where Claude Code, Codex or Hermes can do the work of your bots. You paste one
command on it. The machine connects **out** to manythreads, so you open no port and give no address. This page is for the workspace admin.

## Before you start

- A Linux machine with systemd (x64 or arm64) and a user who may use `sudo`. About 3 GB of free disk.
- The agents you want. The installer adds Claude Code, Codex and a browser for checks. It installs Hermes only if the machine already has it.
- A login for each paid agent (see `runner-signin-files.md` for which login to use). You sign in from this site later, so nothing is typed on the machine.

## Steps

1. Workspace settings, **Runners**, scroll to **Servers**, press **Add a server**.
2. Give it a display name and a short name (lower case; the short name cannot change). Press **Make the command**.
3. Copy the command and run it on the machine. The code in it works once and for 15 minutes.
   - To keep the code out of your shell history, use the second command in the dialog; the script asks for the code on the keyboard.
   - To read the script first, use "The careful way": download it, read it, check the hash, run it.
4. The dialog says "Waiting for <name> to connect…" and then lists the machine and the agents it found.
5. Press **Sign-in** next to each agent and follow the steps. The agent signs in to a folder of its own on the server; your own account on that machine is not touched.
6. The agents are now runners named `<name>-claude`, `<name>-codex` and `<name>-hermes` on the Runners page. Share them with teams and place bots on them like any runner.

## What the installer changes on the machine

It creates two users and two services: `manythreads-bridge` (runs the bots) and `manythreads-publisher` (pushes a bot's finished branch and opens the pull request, so the
bots never hold the push token), and the folders `/opt/manythreads-bridge`, `/etc/manythreads-bridge` and `/var/lib/manythreads-bridge`. Nothing else is touched. Install `git` and `jq`
first (`apt-get install git jq` on Debian or Ubuntu): the installer warns when they are missing, and the team's repositories are copied to the machine with them. Run the same command with `--update` for a new version, and `--uninstall` (with `--purge` to also delete the work
folders) to take it away.

## What a bot does there
A bot on a server works like a bot in a pod: it gets a working folder per team and bot, the team's repositories (copied to the machine; each commit is also saved to a repository of record
with `mt-git`), the same "Where you run" text, and, if its definition lets it publish, the `mt-publish` command. The team's deployer bot also gets the team's deploy login for that run only. Hermes
uses the site's model gateway, so the server needs no model key.

## Safety

- A bot on a server can reach everything the user `manythreads-bridge` can reach on that machine: its folders, its network and the key it uses to talk to this site.
  Put only teams you trust together on one server, and do not put a server on a network that holds things the bots must not see.
- Codex can be given full access (no sandbox) only when you start the installer with `--allow-full-access` **and** switch it on for one team on the Runners page.
- Several teams may share one server and its runners today. They share one Unix user too, so there is no isolation between them on the machine yet (separate users and pods per team are planned): put only teams that trust each other on one server.
- **Rotate key** gives the server a new key over its open connection (one at a time: wait until the server has taken the key, or 15 minutes). **Remove server** ends the connection, refuses the key and deletes its runners; move bots off
  them first.

## If it does not connect

- "Waiting" for more than a minute: the machine cannot reach the site over https. Check its clock, its proxy and its firewall for outgoing connections.
- "Not connected" after it worked: the service stopped or the machine is off. `journalctl -u manythreads-bridge` shows why.
- The code expired: press **New code** and run the command again.
