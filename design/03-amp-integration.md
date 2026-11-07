# Ephyra × Amp: trails that run in Amp threads and orbs

Status: design, 2026-11-07. Grounded in `@ampcode/sdk` `0.1.0-20261028101623-g93a0da1` (read from the package, including
`dist/index.js` `buildCliArgs`), the Amp CLI on this machine (`amp --help`, `amp plugins show-docs`), and the Amp
"Orbs and Jellyware" episode (research/brief.md). Verified locally: the account is signed in, on Amp Megawatt with
750 a1.small orb-hours per period, and has projects `dio/keating` and `dio/twyne`.

## The idea in one paragraph

A trail is a long-running piece of work with checkpoints. An Amp thread is a long-running conversation with an agent,
and an orb is the box it runs in. So give every trail its own Amp thread running in an orb: research, repro, plan and
patch are turns in that one thread, which keeps its context across steps. The thread is Ephyra's sandbox, its agent
and its audit trail at once. Humans can watch it live, open it to multiplayer and take over, and Ephyra stays the
source of truth: the state machine, policy, proof and landing all stay in Ephyra. The orb sleeps for free while the
trail waits at a checkpoint, which is exactly the "never hold a sandbox while a human decides" rule from design/02 §3.

## What Amp gives us (confirmed)

| Amp capability | Where it fits in Ephyra |
|---|---|
| `execute({ prompt, options: { executor: "orb", project, title, labels, visibility, mode, effort } })` streams `system` / `assistant` / `result` JSON (Claude Code stream-json compatible) | `AmpAgent` runs a trail step in a cloud orb; result has `session_id`, `num_turns`, `usage`, `permission_denials` |
| `options.continue: "<thread-id>"` (`amp threads continue <id> --execute`) runs the next turn on that thread's own orb | One thread per trail: repro, plan, patch continue the research thread with full context |
| `executor: "runner"` with `runnerId` / `runnerDir` (`amp --no-tui --runner-id`) | Self-hosted alternative: the same thread model on the user's own Nix box (Ephyra's BYO tier) |
| `threads.setMultiplayer({ threadId, hours })` (orb threads, shared visibility, owner only) | Inbox "take over" opens the thread to a teammate; `claimed_by_human` maps to it |
| `threads.markdown({ threadId })` | The trail's journal stores the thread transcript as evidence (`artefacts/amp/<step>.md`) |
| Plugins in `.amp/plugins/*.ts`: `tool.call` (allow, reject-and-continue, modify, synthesize), `tool.result`, `agent.start` (append context), `agent.end` (`{action: "continue"}`), `registerTool`, `amp.ai.ask` | Ephyra policy enforced *inside* the thread: block pushes to protected refs, inject the trail contract each turn, add tools such as `ephyra_report` and `ephyra_signal_search` |
| `amp orb id-token --audience <aud>` (OIDC, 60–3600 s) | The orb authenticates back to Ephyra without any long-lived secret in the orb |
| `amp orb service start --portal` / `amp orb portal <port>` | Live preview: the patched app runs in the orb with a public URL, the inbox shows it (this is `devenv_live`, hosted) |
| `amp projects create <repo> --orb-size --ship-behavior push-to-branch --pre-setup-script-file` | One Amp project per Ephyra repo; pre-setup runs `devenv` so the orb matches dev and CI |
| `amp secrets` (orb env) | Per-project service-profile credentials, read-only by default |
| `amp oauth-clients create` (Sign in with Amp) | Optional second sign-in next to Not Organic, so a person's Amp threads and Ephyra approvals are one identity |
| `threads search` / `find_thread` tool | Evidence: earlier Amp threads that touched the same files or error |

## How a trail maps onto one Amp thread

```
signal → triage (System One, in Ephyra)
  └─ start_agent(research)  → execute({ executor: "orb", project, title: "T-7f3a2c cart total NaN", labels: ["ephyra","trail:<id>"] })
                              thread T-abc… created; trail.mirrors.ampThread = T-abc…
  checkpoint A (inbox) ← orb sleeps, no cost
  └─ start_agent(repro)     → execute({ continue: "T-abc…" })   same orb, same context
  └─ start_agent(plan)      → execute({ continue: "T-abc…" })
  checkpoint B (inbox)
  └─ start_agent(patch)     → execute({ continue: "T-abc…" })   commits carry Ephyra-Trail; pushed to refs/ephyra/trails/<id>/revisions/N
  └─ run_proof              → Ephyra's own runner (or a separate orb turn with a proof-only prompt), never the patching agent's word
  checkpoint C (inbox, with a portal link to the running fix)
  └─ land / watch / rollback stay in Ephyra
```

Every turn's `result` becomes the step's `AgentResult`: text → artefact, `usage` → budget, `num_turns`, and
`permission_denials` → evidence. The thread link is shown in the inbox (`o`) next to the portal link.

## The Ephyra plugin (runs inside every trail thread)

`.amp/plugins/ephyra.ts`, installed into the Amp project's repo (or as a workspace plugin):

- `agent.start`: append the trail contract for this step (from `renderPrompt`): what file to produce, that untrusted
  signal text is data, the commit trailer rule. `display: false`.
- `tool.call` on `shell_command` / `apply_patch`: `reject-and-continue` for `git push` to anything but
  `refs/ephyra/trails/<id>/*`, for writes outside the repo, and for reading secrets files. This is the service
  profile, enforced at the tool boundary instead of trusted to the prompt.
- `registerTool("ephyra_report")`: the agent hands back structured output (`{ step, probe?, hypothesis?, head? }`)
  instead of Ephyra parsing prose. The tool calls Ephyra with an `amp orb id-token --audience <ephyra-origin>` token.
- `registerTool("ephyra_evidence")`: search past trails, signals and `entire search` through Ephyra.
- `agent.end`: if the step contract is not met (no `ephyra_report` call), return
  `{ action: "continue", userMessage: "You have not reported …" }` once, then let it end so Ephyra records the failure.

## Identity and trust

- **Ephyra → Amp:** an Amp access token (`AMP_API_KEY`) for the workspace that owns the projects, held server-side.
  Orb runs bill to that workspace's orb-hours.
- **Orb → Ephyra:** `amp orb id-token --audience https://<ephyra>` (OIDC). Ephyra verifies it against Amp's JWKS and
  checks the thread id in the token matches `trail.mirrors.ampThread`. *To verify:* Amp's issuer and JWKS URL, and the
  exact claims. No long-lived Ephyra secret enters an orb.
- **People:** they keep signing in to Ephyra with Not Organic. An approver's Amp identity is only needed for
  multiplayer take-over (thread ownership rules apply).

## What stays out of Amp

The state machine, policy, triage, proof verdicts, landing and the watch stay in Ephyra. Amp is an executor and a
place for humans to look and step in, not the system of record. A trail can move to another executor (local, Railway
Sandbox, `runner`) at any checkpoint because the journal, not the thread, holds the state.

## Costs and limits to respect

- Orb-hours are a monthly allowance (750 a1.small here). Ephyra budgets per trail in wallclock and stops a step at the
  deadline (`AbortSignal` kills the stream; `result.subtype === "error_max_turns"` is a failure, not a success).
- Remote executors ignore local-only options (`permissions`, `enabledTools`, `skills`, `mcpConfig`,
  `dangerouslyAllowAll`); policy must therefore live in the project's plugin, not in `execute()` options.
- Multiplayer needs shared (non-private) visibility. Trail threads default to `workspace`; trails touching secrets
  areas should use `private` and give up multiplayer.

## Milestones

1. **AmpAgent (local executor first, then orb).** Implements `CodingAgent` over the SDK's stream-json, one thread per
   trail, `continue` for later steps, usage and transcript captured. Tested against a recorded stream. *(Built now.)*
2. **Orb executor + project setup.** `amp projects create` for the dogfood repo with a devenv pre-setup script; an
   Ephyra-side `AmpRunner` that reports the orb as the sandbox (no local worktree).
3. **The Ephyra plugin.** Tool gating, `ephyra_report`, OIDC back-channel; this is what makes orb runs trustworthy.
4. **Humans in the thread.** Inbox shows thread + portal links; take-over = `setMultiplayer`; comments on the trail
   become thread messages (`continue` with the comment wrapped as untrusted).
5. **Sign in with Amp** (optional), and Amp thread search as an evidence source.

## Open questions

- Amp's OIDC issuer/JWKS and token claims for `amp orb id-token` (needed for milestone 3).
- Whether a workspace token can run orb threads on projects owned by a personal account, or the projects must move to
  the workspace.
- Pricing of orb turns beyond the plan allowance, so Ephyra's budget can carry a real number instead of `null`.
