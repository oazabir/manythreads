# P19-13 spike: the Codex command line

What the bridge's Codex driver (`tools/agent-bridge/src/drivers/codex.ts`, function `codexArgs`) passes to `codex`, checked against the program's own `--help` text. Each answer is marked: [help] read from the `--help` output pasted below (codex-cli 0.166.0, captured 2026-11-09 with `codex exec --help` and `codex exec resume --help` only; no sign-in file was read and no run was made), [docs] from OpenAI's published Codex documentation and not checked against a real program, [owner test] needs the real program and a real sign-in on the owner's host (PLAN P19-13 (k)-(s)).

The test `tools/agent-bridge/test/codex.test.ts` reads this page: it compares the two "Flags used" lines below with what `codexArgs` builds and checks that every flag is in the pasted help text. Change a flag in the driver and this page together, and paste fresh help text when the program is updated.

## Flags used

These two lines are read by the test. One flag per word; a value is not a flag.

```
flags-exec: --json --skip-git-repo-check -C -c -m
flags-resume: --json --skip-git-repo-check -c -m
```

- `exec` starts a new thread. `exec resume <id>` continues one. [help]
- `--json` prints events to stdout as JSON lines. [help]
- `--skip-git-repo-check` lets Codex run outside a Git repository (a bot's work folder need not be one). [help]
- `-C <dir>` sets the working root. Only `exec` has it; `exec resume` does not, so the driver starts the process in the work folder instead (`cwd`) and sends no `-C` on a resume. [help]
- `-c key=value` overrides one config value; the value is TOML. The driver sets `sandbox_mode`, `approval_policy`, `developer_instructions`, `mcp_servers.manythreads.url` and `mcp_servers.manythreads.bearer_token_env_var` this way. The same `-c` works on `exec` and `exec resume`. [help] That these key names are the ones this version reads cannot be seen from help text: [owner test].
- `-m <model>` picks the model, on both. [help]
- The prompt goes on stdin: `-` as the last argument means "read the instructions from stdin". On `resume` the thread id comes before the `-`. [help]

## Flags the driver does not use, on purpose

- `-s, --sandbox` exists on `exec` only. The driver sets the sandbox with `-c sandbox_mode=...` so a new thread and a resumed one are set the same way. [help]
- `--dangerously-bypass-approvals-and-sandbox`: never. The pod is the sandbox; the run still gets a read-only or workspace-write policy. [help]
- `--approve-for-me`, `--oss`, `--local-provider`, `--worktree`, `--add-dir`: not used. [help]
- `--ephemeral` would stop Codex saving the thread, which would break resume. Not used. [help]
- `--ignore-user-config` ("auth still uses `CODEX_HOME`") would be a way to keep a stray `config.toml` out of a pod; not used yet, because the pod writes no `config.toml` at all. [help]
- `-o, --output-last-message`, `--output-schema`, `--color`, `-i`, `-p`: not needed. [help]

## Still to be measured on the owner's host

- The exact JSON line shapes (`thread.started`, `item.*`, `turn.completed`, `turn.failed`, `error`) and the error text for a refused sign-in, for `refresh_token_reused` and for a usage limit. The bridge's failure table (`FAILURE_PATTERNS` in `tools/agent-bridge/src/signin.ts`) holds the words in one place. [owner test]
- Whether Codex writes the renewed tokens back to `auth.json` inside the pod, how often, and how the file's `last_refresh` moves. The gate assumes a renewal changes the file. [owner test]
- Whether several runs at once on one sign-in are safe. The gate lets only one run go while a renewal is due. [owner test]

## Help output: codex exec

```text
Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  fork    Fork a previous session by id into a new session
  review  Run a code review against the current repository
  help    Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]
          Initial instructions for the agent. If not provided as an argument (or if `-` is used),
          instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin
          is appended as a `<stdin>` block

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.

          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --strict-config
          Error out when config.toml contains fields that are not recognized by this version of
          Codex

  -i, --image <FILE>...
          Optional image(s) to attach to the initial prompt

  -m, --model <MODEL>
          Model the agent should use

      --oss
          Use open-source provider

      --local-provider <OSS_PROVIDER>
          Specify which local provider to use (lmstudio or ollama). If not specified with --oss,
          will use config default or show selection

  -p, --profile <CONFIG_PROFILE_V2>
          Layer $CODEX_HOME/<name>.config.toml on top of the base user config

  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands

          [possible values: read-only, workspace-write, danger-full-access]

      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox

      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY
          DANGEROUS. Intended solely for running in environments that are externally sandboxed

      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
          Intended only for automation that already vets hook sources

  -C, --cd <DIR>
          Tell the agent to use the specified directory as its working root

      --worktree
          Run the session in a new managed Git worktree

      --add-dir <DIR>
          Additional directories that should be writable alongside the primary workspace

      --thread-source <SOURCE>
          Source classification for newly created or forked threads

      --cyber-access-program <PROGRAM>
          Request an experimental Cyber access program for this turn (OpenAI provider only). Omit to
          use server defaults. Not supported with review; fork requires a prompt

          [possible values: standard, daybreak_blue, daybreak_red]

      --skip-git-repo-check
          Allow running Codex outside a Git repository

      --ephemeral
          Run without persisting session files to disk

      --ignore-user-config
          Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`

      --ignore-rules
          Do not load user or project execpolicy `.rules` files

      --output-schema <FILE>
          Path to a JSON Schema file describing the model's final response shape

      --color <COLOR>
          Specifies color settings for use in the output

          [default: auto]
          [possible values: always, never, auto]

      --json
          Print events to stdout as JSONL

  -o, --output-last-message <FILE>
          Specifies file where the last message from the agent should be written

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version
```

## Help output: codex exec resume

```text
Resume a previous session by id or pick the most recent with --last

Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]
          Conversation/session id (UUID) or thread name. UUIDs take precedence if it parses. If
          omitted, use --last to pick the most recent recorded session

  [PROMPT]
          Prompt to send after resuming the session. If `-` is used, read from stdin

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.

          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --last
          Resume the most recent recorded session (newest) without specifying an id

      --all
          Show all sessions (disables cwd filtering)

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

  -i, --image <FILE>
          Optional image(s) to attach to the prompt sent after resuming

      --strict-config
          Error out when config.toml contains fields that are not recognized by this version of
          Codex

  -m, --model <MODEL>
          Model the agent should use

      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY
          DANGEROUS. Intended solely for running in environments that are externally sandboxed

      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
          Intended only for automation that already vets hook sources

      --worktree
          Run the session in a new managed Git worktree

      --thread-source <SOURCE>
          Source classification for newly created or forked threads

      --cyber-access-program <PROGRAM>
          Request an experimental Cyber access program for this turn (OpenAI provider only). Omit to
          use server defaults. Not supported with review; fork requires a prompt

          [possible values: standard, daybreak_blue, daybreak_red]

      --skip-git-repo-check
          Allow running Codex outside a Git repository

      --ephemeral
          Run without persisting session files to disk

      --ignore-user-config
          Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`

      --ignore-rules
          Do not load user or project execpolicy `.rules` files

      --output-schema <FILE>
          Path to a JSON Schema file describing the model's final response shape

      --json
          Print events to stdout as JSONL

  -o, --output-last-message <FILE>
          Specifies file where the last message from the agent should be written

  -h, --help
          Print help (see a summary with '-h')
```
