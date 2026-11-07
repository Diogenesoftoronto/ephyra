# Ephyra: self-driving software you can host yourself

*Working name. An ephyra is the juvenile, free-swimming stage of a jellyfish, the first step toward jellyware.*

Ephyra is a design for an open-source system that keeps a running application healthy by itself. It turns production errors, failed intent probes, regressions and its own bug-hunting into **trails**: durable units of work that go from evidence to repro to patch to proof to landing. Each trail is stored in git, needs no pull request, and can live on any forge. The system runs on Railway or entirely on your own Nix hardware. Its cheap always-on triage uses System One models (Clairic, Jev, Clef). LLM agents run only where code has to be written. Humans approve work from a keyboard-driven inbox at HumanLayer-style checkpoints.

| Doc | Owner | What's in it |
|---|---|---|
| [research/brief.md](research/brief.md) | Opus (lead) | The ask, everything researched, sources, unknowns |
| [design/01-product-and-loop.md](design/01-product-and-loop.md) | Fable | Trail state machine, sensing, intents, System One triage schemas, autonomy policy, proof bundles, event→action table, MVP |
| [design/02-platform.md](design/02-platform.md) | Astra (Codex) | Forge adapters (Radicle / Tangled / plain git), git ref layout, DBOS durable execution, telemetry, sandboxes, model/account registry, Railway + self-host service maps, security |

## Where it sits

What you described as "sort of like trails" turns out to be **Entire Trails**, which launched on Oct 26 2026 to replace PRs. A trail can start from a bug report or an agent. Review agents score every push, and Gates enforce human approval. But Entire Trails needs a repo hosted on Entire or mirrored from GitHub. Ephyra is the self-hostable, forge-agnostic version, and it starts from production:

| | Macroscope Murmur | PostHog self-driving | Entire Trails | **Ephyra** |
|---|---|---|---|---|
| Unit of work | GitHub PR | GitHub PR | Trail (Entire forge) | Trail (git refs, any forge) |
| Triggered by | Tasks, review/CI events | Signals inbox | Bug reports, agents, pushes | Prod signals, hunters, regressions, intent drift |
| Forge | GitHub only | GitHub | Entire / GitHub mirror | Radicle, Tangled, plain git (GitHub/Forgejo as adapters) |
| Self-host | Control plane "soon" | No | No | Yes: Railway template or one `devenv up` |
| Triage cost tier | LLM | LLM | LLM review agents | System One (≈$0.49 per 10k signals) |

Ephyra still uses Entire's open-source CLI. Its checkpoints are plain git refs, so `entire search` works as an evidence source on any forge. Both products call their unit of work a "trail". The two concepts match, but when Entire Trails comes up in these docs it is named in full.

## The loop

```
 prod OTel ─┐                                   ┌─ human inbox (a/r/x/t/o) at checkpoints A/B/C
 hunters ───┤                                   │
 regressions┼─▶ Signal ─▶ System One triage ─▶ Trail ─▶ evidence ─▶ hypothesis ─▶ repro ─▶ patch ─▶ proof bundle
 intent ────┤    (fingerprint)   Clairic: extract   │      entire search, traces,           (devenv sandbox:
 forge evts ┘                    Jev/Clef: dedupe,  │      past trails, code graph,          Railway Sandbox or
                                 severity, route,   │      [voxq slot]                       Firecracker on BYO host)
                                 in-flight conflict │
                                                    └─▶ landing: trail ref · Radicle patch · Tangled pull · live into devenv
                                                         └─▶ post-landing watch ─▶ auto-revert on recurrence ─▶ closed trail becomes a regression probe
```

## Key decisions

| Area | Decision | Why |
|---|---|---|
| Source of truth | Git journal at `refs/ephyra/trails/<id>/journal`, with `revisions/NNNN` and `proofs/NNNN` beside it; forge objects only mirror | Forge-agnostic, portable, outlives any workflow engine |
| Hot state | Postgres + **DBOS** embedded in the worker. A transition counts as durable only after the git outbox acknowledges it | Smallest footprint: no Temporal cluster, no Redis |
| Provenance | Commit trailers `Ephyra-Trail`, `Ephyra-Proof`, plus Entire's own `Entire-Checkpoint` (never synthesized) | `entire search` and `entire blame` work per trail |
| Triage | Clairic → Jev, six questions per signal: actionable, duplicate_of, regression_of, conflicts_with, severity, route | Fixes PostHog's duplicate-PR problem by design; LLM spend goes only to trails that survive triage |
| Intent | `intents/*.md`: prose plus YAML probes (`http`, `trace`, `script`, `agent`), with a drift score | You write it; machines check it |
| Autonomy | `ephyra/autonomy.md`: plain-English areas bound to globs, `shadow` before `enforce`, risk tied to blast radius | Jellyware: humans harden the core, the edges stay loose |
| Sandboxes | Railway Sandboxes (GA since Sep 18 2026, disk checkpoints) or Firecracker on your own KVM hosts | Railway offers no nested KVM guarantee |
| Telemetry | OTel Collector → single-node OpenObserve | Logs, traces and UI in one service |
| Stack | **TypeScript** (confirmed), Bun | Fast iteration; same stack as Not Organic (Bun/Hono/Zod); DBOS, Railway Sandbox SDK and System One SDKs are all TS-first |

## Changes I made while merging

- **Trail storage.** The two designers disagreed. Fable used a single ref with `events.jsonl`; Astra used a journal ref with per-event files. I adopted Astra's layout because per-event files never conflict on append. I also aligned IDs on UUIDv7 and clarified that the Postgres projection is the hot path while git holds the durable copy.
- **Tangled namespace.** The lexicons are now `org.tangled.*`, not `sh.tangled.*`. The brief has been corrected.
- **Forge order (recommendation).** Fable's MVP lands only on plain git and leaves forges to M3. Radicle *is* git and its CI broker is stable, so I'd move **Radicle patch landing into M1**. Tangled's write and auth contracts changed in the Oct 30 relaunch and aren't pinned yet, so Tangled stays in M3.

## MVP (from 01 §11, with the Radicle change)

1. **MVP:** OTel errors → fingerprint → Clairic + Jev triage → trail in git → research using traces and code → repro in devenv → patch → `low`-risk proof → land as a trail ref plus live into devenv → terminal inbox → watch with auto-revert. Success means a real production error becomes a landed, watched fix and the only thing a human types is `a`.
2. **M1, memory and Radicle:** closed trails become regression probes, intents and drift scoring arrive, `entire search` joins the evidence sources, and trails land as Radicle patches via a `cib` adapter.
3. **M2, hunting and autonomy:** traffic replay, property tests and tracer-bullet hunters; `autonomy.md` evaluated by Jev; auto-land for `low` areas; Clef as the self-hosted decision backend.
4. **M3, Tangled and multiplayer:** Tangled pull landing, multiplayer claims, agent intent probes.

## Open questions for you

1. **"notorganic"** and **"voxq"**: I couldn't identify either. Both are disabled placeholder slots, one in the provider registry and one in the evidence sources. What are they?
2. **Hosted Jev**: is it OK for the always-on tier to depend on hosted Jev, with Clef as the self-hosted fallback? Or must triage be fully self-hostable from day one? (Jev's weights aren't public, and Clairic's are only "promised".)
3. **Default landing for medium-risk changes**: should it be live into your running devenv, with the forge object as a mirror, or the other way round?

## Not yet verified

These items are flagged in 02 §8: Tangled pull/issue write payloads and service-auth NSIDs; whether Radicle and Tangled replicate custom `refs/ephyra/*`; whether Nix builds work inside Railway Sandboxes; DBOS behavior when external writes have ambiguous outcomes. No costs or cold-start times were measured. Everything above is design, not running code.
