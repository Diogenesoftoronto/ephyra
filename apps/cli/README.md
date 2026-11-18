# Ephyra CLI

Run `bun run src/main.ts` or install the workspace binary as `ephyra`. Sign in with `ephyra login <server-url>`, or set `EPHYRA_URL`, `EPHYRA_API_TOKEN` and `EPHYRA_PRINCIPAL` for automation. The public guide is at [docs/cli](https://ephyra.quest/docs/cli) and [docs/terminal](https://ephyra.quest/docs/terminal); this file is for people working on the package.

## Commands

`ephyra help` lists every command and `ephyra help <command>` explains one. Both read the table in `src/commands/help.ts`, which is also what the usage errors and the "did you mean" hint use, so a command cannot be added without its help.

| Group | Commands |
|---|---|
| Set up | `login`, `logout`, `whoami`, `doctor`, `init`, `setup`, `handoff`, `docs`, `complete` |
| See | `quests` (`trails`), `show`, `file`, `inbox`, `activity`, `runs`, `run`, `usage` |
| Decide | `decide`, `spend`, `comment`, `claim`, `release`, `park`, `resume`, `kill`, `land`, `questions`, `answer` |
| Operate | `status`, `policy`, `agents`, `ops`, `open` |

- **`doctor`** checks the server, the sign-in, the repository in the current directory (remote, `refs/ephyra/*` refspecs, `ephyra/` templates), the recorded setup and the inbox. Each check is ok, a warning, a failure with its next step, or skipped. A check that could not run is skipped, never passed. It exits 1 when something fails.
- **`handoff`** prints a brief for a coding agent: the server, the remote (credentials removed), the branch, what `doctor` found and the documentation links. It never contains a token. `--copy` uses `pbcopy`, `wl-copy`, `xclip` or `xsel`.
- **`docs [topic]`** prints the address of the page for a topic or command. `EPHYRA_DOCS_URL` points it at another copy of the docs. `apps/web/test/docs.test.ts` checks the topic list against the published pages.
- **`decide`** reads the inbox first and sends the waiting item's `bound`, so a quest that moved on is refused as stale. With nothing waiting at that checkpoint it sends no bound and the server decides.
- **`policy`** prints the autonomy policy as a map (`src/policy/board.ts`): one line per area with risk, a five-pip level and paths. `policy edit` drives the same map with keys and shows, for the selected area, the settings the parser really reads (which checkpoints wait for a person, landing, watch); `e` or `policy edit --raw` opens the document in `$VISUAL`/`$EDITOR`. `policy set|add|rm` change one area from flags. Every change is applied locally with `@ephyra/policy`'s `applySketches` for the preview and saved to a server draft; `diff`, `publish`, `activate` and `discard` are separate steps. A save or publish the server did not answer is reported as unknown, never as done.
- Every `<quest>` argument accepts the short id (`T-1a2b`).
- `--json` prints the raw API shape. `init --remote origin` creates shadow-mode templates and configures git refspecs; `--force` replaces templates. Comment and kill require `-m` text.

Human output for the read commands comes from pure functions in `src/commands/views.ts`, coloured only on a TTY without `NO_COLOR`. An unknown cost or token count prints as `unknown`, never as zero. Engine identities are printed whole.

## Guided setup and completion

Run `ephyra setup --interactive` from a repository. The Clack wizard reads bounded local manifests to suggest frameworks and integrations, signs in if needed, connects an HTTPS repository, lets you choose self-driving or supervised operation, and follows the server's recorded setup. It discovers the remote default branch unless you enter one. Nothing executes from local manifests, and discovery does not change local git settings. An installed SDK is only a hint, never a verified connection.

You can connect a public repository, enter a masked repository token, or open the console for GitHub App and other browser authorization flows. Model access and telemetry configuration use the console's existing connection forms; the wizard rereads their saved state before continuing. `setup` without the flag remains a read-only status command. The wizard requires both terminal streams and rejects `--json` before any I/O.

Ctrl+C detaches from server work; it does not cancel a setup quest. Resume the wizard to follow an existing run, or choose **Recheck setup** after correcting a blocked or failed setup. Polling detaches after ten minutes with the last recorded state. Blocked and failed setup return exit 1.

Each setup start has a private, credential-free operation receipt beside the credentials file, written before dispatch. Interrupted starts reconcile through the exact operation key. Repository writes have no public operation-receipt lookup, so an interrupted connection remains unresolved for operator reconciliation; an unrelated settings-version increase never clears it. Receipt operations use an exclusive local lock. A receipt or lock left by an interrupted process fails closed and identifies its file for the operator; never remove one merely to retry an unknown write.

`login` now supports cancellation and a bounded wait, including hung responses. On a terminal it shows the browser link and matching code through Clack. With `--json`, instructions go to stderr and stdout contains one token-free sign-in result. `doctor` uses bounded, cancellable requests and retains plain/JSON output for scripts. `NO_COLOR` disables color; the wizard also uses Clack's accessible text presentation in that mode.

While a request is in flight the wizard and `doctor` show the CLI's own wait indicator, not Clack's spinner: Clack's animated spinner calls `process.exit(0)` on a literal Ctrl+C byte. The indicator turns that byte back into SIGINT, so a cancelled read exits 130 and an interrupted setup write exits 1 with its receipt kept and the unconfirmed-write message; raw mode and the cursor are restored either way (verified in a PTY by `test/interrupt.test.ts`). Browser openers are launched unreferenced and never awaited or killed: an opener that stays alive with the browser does not delay sign-in polling, the next prompt or exit (`test/opener.test.ts`). Valued options accept `--name value` and `--name=value`, the form shell completion inserts.

`@bomb.sh/tab` reads `COMMANDS` and its option/argument metadata to generate completions without auth or network calls:

```sh
source <(ephyra complete bash) # Bash 4+
source <(ephyra complete zsh)
ephyra complete fish | source # fish
ephyra complete powershell | Out-String | Invoke-Expression # PowerShell 7.3+
```

Use the line for your shell. Scripts are printed only; the CLI never edits shell profiles. Completion callbacks resolve `ephyra` through PATH or a shell function. During source development, run `unalias ephyra 2>/dev/null` and then define `ephyra() { bun /absolute/path/to/ephyra/apps/cli/src/main.ts "$@"; }` on its own line before sourcing; Bash expands an existing alias inside a function definition on the same line. Completion has a shell protocol and rejects `--json`.

The completion catalog and protocol use Tab, fed from `COMMANDS`. Before Tab parses, words are read with the same option metadata `main()` uses: a valued option's next word (or its `--name=` remainder) is always its value, so notes such as `--message=--oops` or `-m '--json=abc'` never shift later positions, and completed empty words keep their place. Quoting is removed lexically and nothing is evaluated: `$(...)`, backquotes, `${...}` and `$NAME` stay literal text.

- **Bash** passes the raw line before and after the cursor and Readline's word (`$2`); the CLI decodes single, double and `$'...'` quoting and backslash escapes, and replies with exactly the text Readline replaces in the quote context open there. Inside a word, a candidate that already ends with the text after the cursor is not duplicated (`--status=fa|iled` stays `--status=failed`) and no space is added. bash-completion is not needed.
- **Fish** reads completed words with `read --tokenize` (a quoted multiline argument stays one word) and decodes the current token with `string unescape`; Fish re-quotes what it inserts.
- **Zsh** removes one level of quoting with `${(Q)...}`; **PowerShell** reads literal AST values.

Bash (real Readline in an interactive PTY, with quoted, inline, mid-word and hostile cases) and Fish (its own completion engine) are exercised for real in `test/completion.test.ts`. Zsh and PowerShell adapters are **unverified at runtime** here because neither shell is installed; their quoted-current-word and mid-word behaviour in particular is untested. Bash limitations: `COMP_POINT` follows Bash's own indexing, history expansion (`!`) is not interpreted, and a reply that would need a raw newline is omitted. This avoids the `eval` boundary in Tab 0.0.22's generated Bash/Zsh scripts.

## The inbox

`ephyra inbox` is the keyboard inbox from design/01 §6: the list of what's waiting on the left, and on the right what each item asks you to judge.

- The screen names each checkpoint by what a person decides there: the cause (A), the plan (B) and the landing (C). The letters stay in the journal, the API and `autonomy.md`.
- **Checkpoint A** shows the agent's `hypothesis.md` with the triage behind it (route, actionability, duplicates, and the decision backend's exact identity).
- **Checkpoint B** shows the failing repro and `plan.md`.
- `hypothesis.md` and `plan.md` are laid out as labelled parts (cause, evidence, steps, touches) read by `readBrief` from `@ephyra/core`; the labels are the document's own headings and no text is dropped. `f` switches to the file as written, and `ephyra file <id> hypothesis.md` prints it. `ephyra show` uses the same layout.
- **Checkpoint C** shows the proof bundle for the quest's current revision: repro before and after, tests, regression and intent probes, traffic replay, story checks, diff scope, the review agent's findings, and anything missing.
- **Spend, parked and notice items** show what's asked and the budget.
- A rail shows how far the quest has got (signal → evidence → hypothesis → repro → plan → patch → proof → land → watch) and where A, B and C sit. Below it is the quest's activity.

Keys: `j`/`k` move, `g`/`G` jump to the first or last item, `a` approve, `r` revise with a note, `x` kill with a reason, `c` comment, `t` claim a checkpoint review, `u` release one you claimed, `p` park or resume, `o` open the landing or the agent's thread, `l` land a ready quest whose proof is already approved, `e` explain (the evidence index: against a server, one row per source with its status, hits and any reason it was unavailable, read from the per-source records the index names), `J`/`K` scroll, `R` refresh now, `d` show the documentation page for the selected item, `?` lists the keys and tips, `esc` goes back, and `q` quits. Release a review before deciding. A claim does not stop an active agent.

The line above the hints carries one tip about the selected item (`tipFor` in `src/inbox/view.ts`). A tip is whole clauses or nothing, so a narrow terminal shows fewer clauses, never half of one. An error or a notice replaces it. `EPHYRA_TIPS=0` hides it. `a` and `r` send the item's `bound` with the decision. A refusal the server was clear about (401, 403, 404, 409) is shown as what it is; anything else is reported as an unknown outcome. The hint bar shows only the keys that do something for the selected item. At checkpoint C it reads `a approve and land`, because approving C is what lands the quest. While you write a note, it shows only `enter send · esc cancel`.

Colour means state and nothing else: mint is waiting on you (a blocking checkpoint, a spend, the key that answers it), amber is work that holds (stages done, proof passed, a landing), cherry is a failure or an undo. Keys, labels and the selection are neutral.

Under 60 columns the inbox goes detail-first: the selected item gets the whole screen, its title says where it sits in the list (`1 of 4`), and `j`/`k` move. From 60 to 79 columns the list stacks above the detail; from 80, they sit side by side.

The detail pane reads the quest and its journal files through `GET /v1/trails/:id` and `GET /v1/trails/:id/file?path=` (an allow-list on the server). Each is fetched once per thing to judge: the same quest at its next checkpoint is fetched again. After a change, the list refreshes from the server right away, and every 30 seconds otherwise. A stale decision shows a 409 message, and its optimistic update is rolled back.

`ephyra show <id>` prints the same quest view, full width, with the hypothesis and plan. `ephyra quests` prints a table (`ephyra trails` remains an alias). Both colour only on a TTY without `NO_COLOR`.

The screen is one pure function (`src/inbox/view.ts`) from state to styled lines. OpenTUI, the ANSI fallback (`EPHYRA_ANSI=1`), the Textbook stories, the tests and the landing page's walkthrough all render its output. Everything agent- or human-written is stripped of control and bidi characters and measured in terminal columns before it's drawn.

## Example quest

`src/inbox/demo.ts` is one example quest (a checkout total off by a cent) at every moment from triage to set, a second quest that rolled back, and a few other inbox items. It's sample data for the stories, the tests and the landing page. It's never read by the server and isn't evidence of anything: its proof describes a run that is part of the example. Every object in it parses with the core schemas, and its `autonomy.md` parses with `@ephyra/policy`.

## Textbook

Run `bun run --filter @ephyra/cli textbook` for the Textbook Canvas on `http://127.0.0.1:8008`; `devenv up` also starts it. The stories render the example quest through the real view: every checkpoint, explain, keys, notes (revise, comment, kill), spend, parked, shadow, stale, errors, and `ephyra show` for a landed and a rolled-back quest. They are not connected to an Ephyra server.

## Verified

- **Guided CLI offline tests:** account/workspace binding, default-branch choice, mode selection, recorded progress, browser connection refresh, explicit recheck, cancel/detach, unknown-write receipts, private/exclusive receipt storage, bounded discovery with symlink/secret exclusion, token-free login output and completion metadata. Tests use injected transport and temporary repositories; they do not prove hosted setup or provider access.
- **Guided CLI terminal checks (12 November 2026):** the actual CLI ran in a 120-column PTY against a local HTTP fixture. Repository connection and setup used the expected account/workspace headers, queued/running/blocked progress came from that fixture, Ctrl+C before confirmation made no writes, Ctrl+C after start detached, login cancellation preserved credentials, JSON login kept tokens out of both streams, diagnostics rendered, and `NO_COLOR` emitted no color codes. The browser opener was a local stub; these are terminal checks, not hosted-account evidence.
- **Shell integration:** real Bash Readline (PTY) and Fish resolve command flags, enum values, quoted words, flag-like option values and mid-word edits. Bash and Fish tests preserve hostile words as literal text without executing them. Zsh and PowerShell scripts are inspected and generated in tests, but not runtime-verified locally.
- **Offline tests:** fake-fetch client, reducer and property checks, and template/refspec idempotence in a temporary git repository.
- **Commands (`test/help.test.ts`):** every entry in the help table is accepted by `main()`, and help needs no network. Against a fake API: each read command calls its route, a decision carries the inbox item's bound, short ids resolve, an answer carries its workspace, revoking an agent is a `DELETE`, 403 and 409 are explained, and a write with no answer is reported as unknown. `doctor` is checked for healthy, absent, degraded and unreachable servers and against a real temporary git repository. `handoff` and `repoFacts` never print a remote's password (property test). The views contain no control or bidi characters with hostile text.
- **Real server:** `help`, `doctor`, `status`, `quests`, `usage`, `policy`, `setup` and `handoff` were run against a local `apps/server` in memory mode on 11 November 2026.
- **Policy board (`test/policy.test.ts`, 17 November 2026):** the map lines, every board key, refusal of Auto-land on a critical area, and a property test that any run of keys leaves a document that parses without warnings in a frame of exactly the screen size. Against a fake API: `set`/`add`/`rm` continue one draft, `publish` and `activate` send the expected commit and digest, a 403 or 409 is said as a refusal, and an unanswered save is reported as unknown. The board was also driven in a 104×26 PTY against a local HTTP stand-in that renders the map with `@ephyra/policy`: move, change level and risk, edit in `$EDITOR`, save and publish reached it as one `POST /v1/drafts`, one `PUT …/content` and one `POST …/publish`.
- **Snapshot:** 80×24 text.
- **Property tests:** every screen line is exactly the terminal's width at sizes from 40×10 to 160×60, even with hostile text (bidi overrides, escape codes, wide and combining characters).
- **Quest story:** derived from events. A proof for an older revision never shows as the current proof, and any state with any prefix of events lands on a valid stage.
- **Detail loading against a fake API:** a fetch per thing to judge, then cached, with the evidence index loaded on `e`. A failing API shows its status code, never a response body.
- **Rendering:** OpenTUI's native test renderer draws the styled frames and every Textbook story.
- **Real terminal:** the real CLI (`bun run src/main.ts inbox`) was driven in tmux at 120×34 against the server's own `createApp` serving the example quest. A, B and C were approved in turn, a comment was posted, and `e`, `?`, `j`/`k` and `q` were used. Each decision reached the API as the right request.

Built on Bun 1.4.4, OpenTUI 0.5.17 and Textbook 0.2.0.

## Unverified

- The policy commands have not been run against a real `apps/server`: drafts, publishing to a policy ref and activation were exercised only against fakes that mirror the routes.
- Hosted wizard setup and real browser login/provider consent. Integration credentials still use the console; local discovery is bounded and may miss deeply nested or unsupported frameworks.
- A real deployment with real quests: the terminal test used the example data.
- The new inbox keys (`g`, `G`, `R`, `u`, `d`) in a real terminal: they are covered by the reducer and view tests only.
- `runs`, `run --follow`, `questions`, `answer`, `agents` and `spend` against a server that has runs, questions or agents: the local server had none, so these were exercised against the fake API.
- `handoff --copy` and `docs --open`: they shell out to the system clipboard and opener.
- Terminals other than tmux.
- `o`: opening links with the system opener.
- Mouse input.

Ambiguous writes are reported without automatic retry; the server must implement the Idempotency-Key contract for durable reconciliation. Sapling synchronization is not implemented.

Exit codes: 0 for success, 1 for usage, configuration, blocked/failed setup or API errors, 130 for clean cancellation. An interrupted write reports uncertainty (1) while retaining its receipt.
