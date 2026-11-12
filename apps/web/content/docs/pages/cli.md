---
title: The CLI
summary: Every command, grouped by what you are trying to do. Scriptable with --json, and the fastest way to diagnose a setup.
---

Reach for the CLI when you want an answer without opening a browser, when you are scripting, or when something does not work and you need to know why. It talks to the same API as the console, so anything you do in one appears in the other.

## Install

The CLI runs on [Bun](https://bun.sh) 1.4 from an Ephyra source checkout:

```sh
bun install
EPHYRA_MAIN="$PWD/apps/cli/src/main.ts"
unalias ephyra 2>/dev/null
ephyra() { bun "$EPHYRA_MAIN" "$@"; }
ephyra help
```

This is a shell function rather than an alias, so shell completion can call it and the definition still parses where an older `ephyra` alias exists; `unalias` removes such an alias first. To keep it, put the last three lines in your shell profile with the absolute path in place of `$PWD`. In Fish, use `function ephyra; bun /absolute/path/to/ephyra/apps/cli/src/main.ts $argv; end`.

## First five minutes

```sh
ephyra setup --interactive                   # detect this repository, connect it, follow recorded setup
ephyra login https://console.ephyra.quest   # opens your browser; approve the code it shows
ephyra doctor                                # checks the server, your sign-in and this repository
ephyra quests                                # every quest and where it stands
ephyra inbox                                 # what is waiting on you
```

`ephyra login` signs you in with Not Organic through the browser. The page shows a short code; approve the request showing the same code in your terminal. The CLI never sees your Not Organic credentials. It keeps only an Ephyra session token in `~/.config/ephyra/credentials.json`, readable by you alone.

The setup wizard signs you in when needed, suggests the repository and frameworks found locally, shows integration hints, and lets you choose self-driving or supervised operation. It can connect a public repository or use a masked access token. Browser authorization and model or telemetry configuration open the existing console forms; return to the terminal to read the saved connections. Discovery alone does not prove an integration works.

Setup progress comes from the server's recorded quest. Ctrl+C stops waiting while server work continues. Run the wizard again to follow that quest, or choose **Recheck setup** after correcting a blocked or failed setup. An interrupted write keeps an operation reference so setup is checked before another start; an unconfirmed repository connection needs operator reconciliation.

> [!TIP]
> Start every "why is this not working" with `ephyra doctor`. Each line is a check that passed, a warning, or a failure with the next step. It only reads.

## Set up

| Command | What it does |
|---|---|
| `ephyra login <server-url>` | Sign in through your browser. |
| `ephyra logout` | End the session and delete the saved token. |
| `ephyra whoami` | Show who you are on this server and whether you can approve. |
| `ephyra doctor` | Check the server, sign-in, repository, journal refs, policy files, setup and inbox. Exits non-zero if something must be fixed. |
| `ephyra init [--remote origin] [--force]` | Write `ephyra/autonomy.md`, `thresholds.yaml` and `models.yaml` in shadow mode, and add `refs/ephyra/*` to the remote's fetch and push refspecs. Existing files are kept unless `--force`. |
| `ephyra setup` | Show the recorded setup: steps, coverage and blockers, with who has to act. |
| `ephyra setup --interactive` | Discover this repository, collect missing choices, connect it and follow setup. Requires an interactive terminal. |
| `ephyra handoff [--copy]` | Print a brief for your coding agent with your server, repository and `doctor` findings filled in. No token is included. |
| `ephyra docs [topic] [--open]` | Print the address of the page for a topic or command: `ephyra docs policy`, `ephyra docs stuck`. |
| `ephyra complete <shell>` | Print shell completion for Bash, Zsh, Fish or PowerShell. |

## Shell completion

Completions use the same command definitions as `ephyra help`, including aliases, options and fixed choices. They do not need sign-in or network access. With an installed `ephyra` executable, use the line for your shell:

```sh
source <(ephyra complete bash) # Bash 4+, with bash-completion loaded
source <(ephyra complete zsh)
ephyra complete fish | source # Fish
ephyra complete powershell | Out-String | Invoke-Expression # PowerShell 7.3+
```

For a source checkout, define the `ephyra` function from [Install](#install) before sourcing completions. Completion prints a script; it does not change your shell profile. Add the appropriate line to your profile if you want to keep it.

## See

| Command | What it does |
|---|---|
| `ephyra quests [--state <state>]` | List quests. `ephyra trails` is the same command. |
| `ephyra show <quest>` | One quest: its stage, hypothesis, plan, proof and recent activity. |
| `ephyra file <quest> <path>` | Print a file from the quest's journal, such as `proof/manifest.json`. |
| `ephyra inbox` | Open the [terminal inbox](./terminal). With `--json`, print the waiting items. |
| `ephyra activity [--limit n]` | What the agents are doing now and did recently. |
| `ephyra runs [--quest <quest>] [--status <status>]` | List agent runs. Status is `running`, `done`, `failed` or `unavailable`. |
| `ephyra run <run-id> [--follow]` | Read a run's transcript. `--follow` keeps reading until it ends. |
| `ephyra usage [--days n]` | Tokens, known spend, unknown costs and each quest's budget. |

`<quest>` is a full id or the short one the lists show, such as `T-1a2b`.

## Decide

These change a quest. They need a signed-in **approver**; a read-only account or a service token is refused with a message that says so.

| Command | What it does |
|---|---|
| `ephyra decide <quest> <A\|B\|C> <approve\|revise\|reject> [-m note]` | Answer a checkpoint. Approving C lands the quest. |
| `ephyra spend <quest> <approve\|reject> [-m note]` | Answer a request to spend on a study with real respondents. |
| `ephyra comment <quest> -m <text>` | Say something on the quest. |
| `ephyra claim <quest>` | Take a checkpoint review so nobody else decides it under you. |
| `ephyra release <quest>` | Give it back. Do this before you decide. |
| `ephyra park <quest>` · `ephyra resume <quest>` | Pause a quest, or continue it from the state it was in. |
| `ephyra kill <quest> -m <reason>` | Stop a quest for good. |
| `ephyra land <quest>` | Land a ready quest whose proof was already approved. |
| `ephyra questions` | Questions an investigation is waiting on you to answer. |
| `ephyra answer <question-id> -m <text>` | Answer one with a fact. The first characters of the id are enough. |

`ephyra decide` binds your answer to the revision that is waiting in your inbox at that moment. If the quest has moved on, the server refuses the decision as stale, and you look again. `revise` sends the quest back a stage with your note; `reject` ends it.

## Operate

| Command | What it does |
|---|---|
| `ephyra status` | Server health, store mode and release revision. |
| `ephyra policy` | The policy in effect: the active receipt, and each document with its warnings. |
| `ephyra agents` · `ephyra agents revoke <id>` | Coding agents you approved, and how to end one's access. |
| `ephyra ops` | Worker ownership, dead jobs and effects that need reconciliation. |
| `ephyra open [quest]` | Open the web console, at a quest if you name one. |

## For scripts

Read commands accept `--json` and print the raw API shape on one line. Errors are JSON too, as `{"error": "..."}`. `login --json` sends browser instructions to stderr and prints a token-free sign-in result to stdout. The interactive wizard and shell completion reject `--json`. The exit code is `0` on success, `1` for a usage, configuration or API error, and `130` for clean cancellation; `doctor` and the wizard exit `1` for failed checks or blocked/failed setup. An interrupted write keeps its receipt and exits `1` because its outcome is unknown.

```sh
# Is anything blocking a quest right now?
ephyra inbox --json | jq '[.[] | select(.blocking)] | length'

# Fail a CI step when setup is not ready
ephyra setup --json | jq -e '.status == "ready"'
```

For automation without a browser, set three variables instead of logging in:

| Variable | Purpose |
|---|---|
| `EPHYRA_URL` | The server. |
| `EPHYRA_API_TOKEN` | The server's service token. |
| `EPHYRA_PRINCIPAL` | The name the audit log records for this automation. Required with the token. |

Once sign-in is configured on a server, the service token can read but cannot make a human decision. Other settings: `EPHYRA_CREDENTIALS` moves the credentials file, `EPHYRA_DOCS_URL` points `ephyra docs` at your own copy of these pages, and `NO_COLOR` turns colour off (output is also plain whenever it is not a terminal).

## When a command fails

| Message | Meaning |
|---|---|
| `Not signed in…` | No session and no service token. Run `ephyra login <server-url>`. |
| `Read-only here…` | You are signed in but not an approver in this workspace. |
| `Stale decision; refresh before retrying` | The quest changed after you looked. Run `ephyra show` again. |
| `API write outcome unknown; reconcile before retrying` | The request was sent but no answer came back. It may have been applied. Check with `ephyra show` before repeating it. |
| `API connection failed` | A read could not reach the server. Safe to repeat. |

The CLI does not retry a write by itself, because a write that timed out may have happened.

## Next

- [The terminal inbox and its keys](./terminal)
- [The HTTP API underneath](./api)
