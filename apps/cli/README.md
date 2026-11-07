# Ephyra CLI

Run `bun run src/main.ts` or install the workspace binary as `ephyra`. Sign in with `ephyra login <server-url>`, or set `EPHYRA_URL`, `EPHYRA_API_TOKEN` and `EPHYRA_PRINCIPAL` for automation. `init --remote origin` creates shadow-mode templates and configures git refspecs; `--force` replaces templates. `--json` emits the raw API shape. Comment and kill require `-m` text.

## The inbox

`ephyra inbox` is the keyboard inbox from design/01 §6: the list of what's waiting on the left, and on the right what each item asks you to judge.

- **Checkpoint A** shows the agent's `hypothesis.md` with the triage behind it (route, actionability, duplicates, and the decision backend's exact identity).
- **Checkpoint B** shows the failing repro and `plan.md`.
- **Checkpoint C** shows the proof bundle for the trail's current revision: repro before and after, tests, regression and intent probes, traffic replay, story checks, diff scope, the review agent's findings, and anything missing.
- **Spend, parked and notice items** show what's asked and the budget.
- A rail shows how far the trail has got (signal → evidence → hypothesis → repro → plan → patch → proof → land → watch) and where A, B and C sit. Below it is the trail's activity.

Keys: `j`/`k` move, `a` approve, `r` revise with a note, `x` kill with a reason, `c` comment, `t` take over, `p` park or resume, `o` open the landing or the agent's thread, `l` land a ready trail whose proof is already approved, `e` explain (the evidence index), `J`/`K` scroll, `?` lists the keys, `esc` goes back, and `q` quits. The hint bar shows only the keys that do something for the selected item. At checkpoint C it reads `a approve and land`, because approving C is what lands the trail. While you write a note, it shows only `enter send · esc cancel`.

Colour means state and nothing else: mint is waiting on you (a blocking checkpoint, a spend, the key that answers it), amber is work that holds (stages done, proof passed, a landing), cherry is a failure or an undo. Keys, labels and the selection are neutral.

Under 60 columns the inbox goes detail-first: the selected item gets the whole screen, its title says where it sits in the list (`1 of 4`), and `j`/`k` move. From 60 to 79 columns the list stacks above the detail; from 80, they sit side by side.

The detail pane reads the trail and its journal files through `GET /v1/trails/:id` and `GET /v1/trails/:id/file?path=` (an allow-list on the server). Each is fetched once per thing to judge: the same trail at its next checkpoint is fetched again. After a change, the list refreshes from the server right away, and every 30 seconds otherwise. A stale decision shows a 409 message, and its optimistic update is rolled back.

`ephyra show <id>` prints the same trail view, full width, with the hypothesis and plan. `ephyra trails` prints a table. Both colour only on a TTY without `NO_COLOR`.

The screen is one pure function (`src/inbox/view.ts`) from state to styled lines. OpenTUI, the ANSI fallback (`EPHYRA_ANSI=1`), the Textbook stories, the tests and the landing page's walkthrough all render its output. Everything agent- or human-written is stripped of control and bidi characters and measured in terminal columns before it's drawn.

## Example trail

`src/inbox/demo.ts` is one example trail (a checkout total off by a cent) at every moment from triage to set, a second trail that rolled back, and a few other inbox items. It's sample data for the stories, the tests and the landing page. It's never read by the server and isn't evidence of anything: its proof describes a run that is part of the example. Every object in it parses with the core schemas, and its `autonomy.md` parses with `@ephyra/policy`.

## Textbook

Run `bun run --filter @ephyra/cli textbook` for the Textbook Canvas on `http://127.0.0.1:8008`; `devenv up` also starts it. The stories render the example trail through the real view: every checkpoint, explain, keys, notes (revise, comment, kill), spend, parked, shadow, stale, errors, and `ephyra show` for a landed and a rolled-back trail. They are not connected to an Ephyra server.

## Verified

- **Offline tests:** fake-fetch client, reducer and property checks, and template/refspec idempotence in a temporary git repository.
- **Snapshot:** 80×24 text.
- **Property tests:** every screen line is exactly the terminal's width at sizes from 40×10 to 160×60, even with hostile text (bidi overrides, escape codes, wide and combining characters).
- **Trail story:** derived from events. A proof for an older revision never shows as the current proof, and any state with any prefix of events lands on a valid stage.
- **Detail loading against a fake API:** a fetch per thing to judge, then cached, with the evidence index loaded on `e`. A failing API shows its status code, never a response body.
- **Rendering:** OpenTUI's native test renderer draws the styled frames and every Textbook story.
- **Real terminal:** the real CLI (`bun run src/main.ts inbox`) was driven in tmux at 120×34 against the server's own `createApp` serving the example trail. A, B and C were approved in turn, a comment was posted, and `e`, `?`, `j`/`k` and `q` were used. Each decision reached the API as the right request.

Built on Bun 1.4.4, OpenTUI 0.5.17 and Textbook 0.2.0.

## Unverified

- A real deployment with real trails: the terminal test used the example data.
- Terminals other than tmux.
- `o`: opening links with the system opener.
- Mouse input.

Ambiguous writes are reported without automatic retry; the server must implement the Idempotency-Key contract for durable reconciliation. Sapling synchronization is not implemented.

Exit codes: 0 for success, 1 for usage, configuration, or API errors.
