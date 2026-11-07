# Ephyra platform: portable Trails, replaceable execution

Design proposal, 6 November 2026. Companion to `01-product-and-loop.md`. Product references and model availability come from `research/brief.md`; linked infrastructure sources were checked for this document. Proposed interfaces are not claims of implemented integrations.

**Decision:** git owns the durable Trail record; Not Organic owns default account authority; Postgres owns scheduling, account projections, and execution leases; runners are disposable. No pull request, hosted model, GitHub account, or Railway account is required for the local configuration.

## 1. Forge boundary

A **Signal** is anything observed: production error, OTel anomaly, failed Intent probe, regression replay failure, user report, or forge event. A **Trail** follows Signal → evidence → hypothesis → repro → patch → proof → Landing → post-landing watch. Forge objects mirror a Trail; they never define its identity.

```ts
type ForgeEvent = {
  workspace: string; repo: string; adapter: string;
  sourceId: string; cursor: string; occurredAt: string;
  kind: "push" | "proposal.opened" | "proposal.updated" |
        "review.comment" | "review.decision" | "ci.status" | "issue";
  objectId?: string; revision?: string; commit?: string;
  actor: string; payloadDigest: string;
};
interface ForgeAdapter {
  capabilities(repo): Promise<Capabilities>;
  events(cursor): AsyncIterable<ForgeEvent>;
  reconcile(repo, cursor): Promise<Reconciliation>;
  readObject(id, revision): Promise<ForgeObject>;
  prepareLanding(trail, expectedBase): Promise<LandingPlan>;
  land(plan, authorization, idempotencyKey): Promise<LandingReceipt>;
  mirror(trailManifest, expectedRevision): Promise<MirrorReceipt>;
}
```

Capabilities advertise events, conditional writes, allowed refs, proposals, CI, and signing. Normalize immutable repository IDs, not display names. Persist raw event digests and ingestion cursors transactionally; deduplicate `(adapter, repo, sourceId, revision)`. Reconcile after gaps and reconnects. Delivery is at least once; ordering across forges is not guaranteed.

| Adapter | Events in | Landing out |
|---|---|---|
| Radicle | Node ref changes; `xyz.radicle.patch` revisions, reviews/comments; issue COB changes; CI broker results/job COBs | Signed branch/ref publication or Radicle patch revision; authorized integration by a delegate |
| Tangled | Knot2 signed repo records via AT Protocol firehose; git push events; spindle pipeline status; bobbin for read-side hydration | Branch push; optional Tangled pull; knot mutation plus required attestation, subject to negotiated schema |
| Plain git | Bare repository `post-receive` spool: old/new OID, ref, authenticated principal; external CI callback; Ephyra API for issues/reviews | Conditional branch update; optional signed tag; local live-apply through runner |
| GitHub / Forgejo | Webhook/API translation of the same event kinds | Branch or optional native proposal; no core workflow changes |

**Radicle:** implement a `cib` subprocess adapter that submits an Ephyra job, reports its actual result, and links its Proof bundle. The broker already filters default-branch and patch-created/updated events; `.radicle/native.yaml` belongs to its native executor, not Ephyra's protocol. Node trust filters are mandatory. Job COB publication is configurable. These surfaces are documented in the [broker guide](https://radicle-ci-broker.liw.fi/userguide.html) and [CI overview](https://radicle-ci-broker.liw.fi/overview.html). Issue/review ingestion requires a separate COB reconciler; do not assume the CI broker delivers every collaboration event.

Defer a custom `dev.ephyra.trail` COB. Define its proposed operations as `link`, `appendEvidence`, `recordDecision`, and `recordLanding`, each referencing a Trail manifest OID. First ship native patch/issue links plus git storage. Custom COB schema support, replication acceptance, and UI rendering remain unverified; a new type must never be required to resume work.

**Tangled:** the October migration replaced `sh.tangled.*` with `org.tangled.*`. Knot2 holds repo-owned issues, pulls, and comments; bobbin is read-only; author attestations live on the author's PDS. This corrects the older spindle vocabulary in the brief. [Architecture announcement](https://tangled.org/blog/forge/)

The published lexicon change identifies `org.tangled.repo.track.ticket` and `org.tangled.repo.review.unspecced.round`; the latter binds a review to a commit. Treat these as versioned schema evidence, not a complete stable pull-write contract. [Ticket schema](https://tangled.org/tangled.org/core/commit/48babb4c8b9f09400b6d29db70e46fbdf7d2e734), [review schema](https://tangled.org/tangled.org/core/commit/0f7507c373d76521f6e16ba1bede3bf3190585cf)

Current generated API listings expose `org.tangled.event.notifyEvent`, push/pull-request event types, and `org.tangled.ci` operations including `getPipeline`, `queryPipelines`, `subscribePipelineLogs`, workflow-definition reads, retry, and approval. Consume existing spindle results first; correlate by repository, commit, and pipeline ID. A custom spindle is a later runner bridge, not a prerequisite. Pin generated bindings to a tested revision; reject unknown schemas instead of replacing namespace prefixes mechanically. Exact pull/issue write payloads, current status transport, and auth method names still require integration verification. [API source listing](https://tangled.org/tangled.org/core/tree/master/api/org_tangled), [bobbin API](https://tangled.org/docs/api/bobbin/)

All Landing modes return `{mode, oldOid, newOid, externalId, authorizationId, proofDigest}`. Live-apply additionally records working-tree hashes, process handles, and an undo patch. Require an explicit human session lease and clean target tree; a preview is not a production deployment. If the target base changes, invalidate approval and rebuild proof. Serialize integration per target branch; never blindly repeat a timed-out write.

## 2. Trail storage and Entire

Use a dedicated metadata history, separate from application commits:

```text
refs/ephyra/trails/<uuid>/journal          append-only metadata commits
refs/ephyra/trails/<uuid>/revisions/0001   immutable patch tip
refs/ephyra/trails/<uuid>/proofs/0001      immutable proof-manifest commit
refs/heads/ephyra/<uuid>                  optional ordinary branch mirror
```

Each journal tree contains `trail.json`, `events/<event-id>.json`, `proofs/<digest>.json`, and session pointers. Events have schema version, actor, timestamp, parent event, and content digest. One lease-holding writer advances the journal by compare-and-swap. Offline actors submit separately signed events for reconciliation; conflicting decisions remain visible.

```json
{
  "schema": 1, "trail": "uuid", "repo": "stable-repo-id",
  "signals": ["signal-id"], "intentVersion": "git-oid",
  "base": "git-oid", "patch": "git-oid", "stage": "proof",
  "profileDigest": "sha256:...", "proofDigest": "sha256:...",
  "sessions": [{"provider": "entire", "checkpoint": "actual-id"}]
}
```

A **Proof bundle** manifest records before/after commands, exit codes, environment/lock hashes, exact commits, trace IDs, timestamps, test scope, and artifact digests. Large recordings and sanitized logs live in content-addressed blob storage; manifests distinguish unavailable, expired, failed, and passed evidence. An acceptance decision binds base, patch, Intent version, profile, and proof digest. Metadata alone cannot turn an incomplete run into proof.

Patch commits carry:

```text
Ephyra-Trail: <uuid>
Ephyra-Proof: sha256:<manifest-digest>
Entire-Checkpoint: <id-written-by-Entire>
```

Let Entire own `refs/entire/checkpoints/*` or its installed-version `entire/checkpoints/v1` branch and its attribution trailers. Never synthesize checkpoint IDs. Include `Ephyra-Trail: <uuid>` in agent-session context, preserve Entire trailers through supported commits, and index the exact checkpoint/session mapping in the journal. `entire search` can discover that marker; Ephyra filters results against recorded checkpoint IDs rather than assuming a nonexistent Trail-specific search flag. Entire behavior here follows the brief and needs a pinned-version acceptance test.

Ordinary clones do not fetch arbitrary refs. Ship explicit Ephyra/Entire refspec configuration and export/import bundles. Probe each remote's ref acceptance and replication; when unsupported, store metadata in a companion bare git repository with a normal branch, retaining canonical Trail IDs. Keep sensitive session refs on private remotes. Git history survives workflow-engine replacement, but operational recovery additionally needs database backups and external-operation reconciliation.

### Optional Sapling draft stacks

A Trail patch may be a Sapling draft stack; plain git remains the fallback. Prefer **`.git` mode** (`git clone/init`); `.sl` mode (`sl clone/init`) speaks Git protocols but excludes ordinary Git working-directory commands. Mutations live in `.git/sl`. [Git support modes](https://sapling-scm.com/docs/git/git_support_modes/)

| Trail operation | Sapling mapping |
|---|---|
| Revision `refs/ephyra/trails/<id>/revisions/NNNN` | Immutable stack tip; journal records base, ordered commit OIDs, prior revision, and predecessor→successor edges |
| Amend/restack/split | New revision and fresh proof; capture mutation operation, actor and timestamp, including one-to-many mappings; never move an old revision ref |
| Take over | Human `sl goto` plus amend under the Trail lease; invalidate approval when bound OIDs change |
| Journal/proof storage | Ephyra refs remain separate metadata histories; Sapling owns its metadata. Serialize writers; never edit `.git/sl` directly |

Mutation/obsolescence survives locally; Sapling servers can share it. Ordinary Git push/clone does **not** carry `.git/sl`. Journal edges preserve portable history, without promising native metadata reconstruction. [Mutation internals](https://sapling-scm.com/docs/dev/internals/visibility-and-mutation/)

Git-backed push/pull invoke Git subprocesses. Git supports remote helpers; **inference**, `git-remote-rad` can participate. Sapling/Radicle authentication, refs and push options remain unverified. [Sapling transport source](https://github.com/facebook/sapling/blob/main/eden/scm/sapling/git.py), [Git remote helpers](https://git-scm.com/docs/gitremote-helpers)

| Landing target | Stack publication and integration |
|---|---|
| Radicle | Git + `git-remote-rad` publishes tip/optional patch revision; delegate integrates. Use ordinary Git staging clone until Sapling transport passes acceptance |
| Tangled | Knot Git branch push, optional pull/attestation; integrate authorized tip. Sapling/knot round trip unverified |
| Plain git | Conditional update to approved tip preserving stack; squash/rebase needs fresh proof/approval |

Retain journal refspecs/companion-git fallback. ISL needs commit→Trail mapping, stage/proof/approval badges, evidence links, stale-status refresh and authenticated takeover/Landing. Its `CodeReviewProvider` interface supports summaries, links and landing; upstream/fork integration is plausible, but a stable plugin API is **unverified**. [ISL provider interface](https://github.com/facebook/sapling/blob/main/addons/isl-server/src/CodeReviewProvider.ts)

## 3. Durable execution and telemetry

| Candidate | Small-install tradeoff | Decision |
|---|---|---|
| Temporal | Separate production orchestration service; strong workflow ecosystem, larger operational surface | Larger deployments later |
| Restate | Single runtime binary with its own durable state | Credible alternative; another stateful system |
| Hatchet | Lite packages engine/UI for low-volume use with Postgres | Useful ready-made operations UI |
| DBOS | Workflow library and Postgres; no separate orchestration server | **Default** |
| Plain queue tables | Few dependencies, but we must implement timers, recovery, versioning, cancellation | Inbox/outbox only |

This is an architectural fit assessment, not a benchmark. Sources: [Temporal deployment](https://docs.temporal.io/production-deployment), [Restate runtime](https://restate.dev/), [Hatchet Lite](https://docs.hatchet.run/self-hosting/hatchet-lite), [DBOS architecture](https://docs.dbos.dev/architecture).

Embed DBOS in the worker. Begin with one active worker and restart recovery, no mandatory hosted Conductor. Pin workflow code versions until active Trails drain. Persist approvals and waits; do not keep sandboxes alive while waiting for people. Before adding replicas, validate recovery ownership and fencing under simultaneous crashes.

Maintain `event_inbox`, `trail_projection`, `operation_ledger`, `outbox`, `runner_leases`, `approvals`, `usage_ledger`, and `audit_events`. Store external request IDs before waiting. Every effect uses a stable operation key; ambiguous provider/forge outcomes become `reconciliation_required`. Workflow durability does not make external side effects exactly once. Use a journal outbox: pending transitions become visible as durable Trail transitions only after git publication is acknowledged.

**Telemetry recommendation:** OTel Collector → single-node OpenObserve, with Postgres holding Signal summaries and search metadata. OpenObserve supplies log/metric/trace ingestion and exploration without building a bespoke telemetry UI. [OpenObserve documentation](https://openobserve.ai/docs/)

Compared with a ClickHouse/SigNoz installation, this selects a smaller initial service inventory; compared with Postgres/Timescale telemetry, it keeps bulk ingest away from workflow transactions. These are deployment preferences, not measured resource savings. Apply redaction, bounded queues, sampling, and per-workspace quotas at the collector. Start with seven-day raw retention; pin evidence exports separately. Propagate `TRACEPARENT` through devenv and attach Trail, run, commit, and Intent IDs. Missing/dropped telemetry produces a coverage gap, never a successful probe.

## 4. Runner contract and devenv isolation

```ts
interface Runner {
  allocate({trail, attempt, commit, lockHash, profile, lease}): Handle;
  exec(handle, command, deadline): AsyncIterable<Output>;
  checkpoint(handle): Snapshot; // declares disk-only or memory capability
  restore(snapshot, freshLease): Handle;
  exportEvidence(handle): ArtifactManifest;
  destroy(handle): DestructionReceipt;
}
```

Build from pinned `devenv.nix`, `devenv.yaml`, and lockfiles. Cache by platform, locks, and Service profile digest; share read-only Nix closures, never writable workspaces or credentials. Reproduce base and candidate with the same sanitized fixture snapshot. Give each attempt unique ports, CPU/memory/disk limits, timeout, process handles, and heartbeat fencing. Treat evaluating repository Nix expressions as untrusted execution.

### Not Organic runners and UI proof

| Backend | Trail steps and limits |
|---|---|
| Not Organic `/v1/sandbox/runs` | Small Python/TypeScript repros/transforms/checks; 30 s CPU cap, no egress/auto-install, 256 KiB output; no shell/browser/checkpoints |
| Planned Not Organic Fly Sprite CI | Builds, regression replay, eventual UI proof. Client/dispatcher exist; provisioning/verified bridge pending. Missing runner: `runner_unavailable`; unfinished R2 export: `artifact_sink_unavailable` |

Spindle triggers Tangled-backed projects only, not Radicle. Gateway owns settlement; unattended reconciliation needs verification. Sources: Not Organic `docs/sandbox-execution-graph.md`, `packages/contracts/src/{sandbox,project-execution,ci}.ts`, `apps/gateway/src/{fly-sprites,spindle-ci}.ts`.

Run **Storybook** (web) and **Textbook** (terminal) before/after inside the Trail sandbox. Images/devenv need browser dependencies/fonts for Storybook; Bun, Zig, npm `textbook-sh`, PTY/capture tooling for Textbook. Pin commits, viewport/theme/fixtures; export interactions/screenshots/terminal recordings into the Proof bundle. Requires accepted Railway/BYO or future Sprite images, not the bounded CPU runner.

### Railway tier

Railway now documents managed isolated Linux sandbox VMs and a TypeScript SDK, including create, exec, checkpoint, restore, and destroy. Checkpoints preserve disk, not running processes. `ISOLATED` excludes private-network access but permits internet egress; `PRIVATE` joins the environment network. Idle timeout destroys instances. Running memory remains billable. Prefer this managed primitive to nested containers. [Sandbox contract](https://docs.railway.com/sandboxes)

Use a separate sandbox environment without control-plane databases. Prepare a secret-free Nix/devenv template, restore it per attempt, then issue fresh scoped credentials. Checkpoint sanitized work, export proof, and destroy for application-level sleep; resume by restarting devenv processes. Do not promise free storage or suspended agent RAM. Verify destruction rather than assuming a disconnected exec means shutdown.

| Constraint | Verification and design consequence |
|---|---|
| Nested KVM / privileged containers | No authoritative support contract established in this review. Never require `/dev/kvm`, privileged Docker, or a host socket inside Railway services. Managed VMs do not imply nested virtualization. |
| Nix in containers | Nix publishes an official container image; this does not verify Railway's Nix build-sandbox/user-namespace behavior. Bake closures outside Railway; smoke-test devenv evaluation, process control, and builds before enabling this runner. [Nix manual](https://nix.dev/manual/nix/latest/installation/installing-docker) |
| Ephemeral services | Public API documents service creation/deletion; Ephyra could provision disposable image services, but must own TTL/reconciliation and staged deployment handling. Prefer sandbox API. [Service API](https://docs.railway.com/integrations/api/manage-services) |
| Volumes | One volume per service, no replicas with volumes, redeployment downtime; unsuitable as a shared runner filesystem. [Volume limits](https://docs.railway.com/volumes/reference) |

If a Service profile requires enforceable destination-only egress, do not claim Railway's network mode satisfies it. Require demonstrated enforcement or dispatch to the BYO tier.

### Bring-your-own Nix hosts

Prefer Firecracker microVMs on Linux/KVM hosts for untrusted repositories; host preparation installs the privileged supervisor, networking, cgroups, and jailer. Rootless containers or systemd-nspawn are optional same-trust workspace backends, explicitly sharing the host kernel. A local unsandboxed process runner is opt-in for trusted code only.

Use per-VM writable overlays, read-only closure cache, host-enforced egress, and no host secret mounts. Disk checkpoint/restart is the portable baseline. Memory snapshots are optional, host/kernel-version-dependent, and invalid after credential expiry or profile changes. Remote runners connect outbound with mTLS and lease-scoped capabilities; the control plane never needs inbound SSH to every host.

## 5. Models, accounts, and evidence sources

**Not Organic is the default account, identity and model gateway.** Bind each workspace to its account/org and ATProto DID principals. Reuse memberships, live access and isolated org/product contexts. Assertions (≤60 s) exchange for DPoP capability tokens (≤300 s) with cost ceilings. Ephyra stores bindings/repository policy; verified tokens select account authority.

| Ephyra need | Existing Not Organic capability / surface |
|---|---|
| System One decisions | `judgement:evaluate`, `POST /v1/judgement`; named `noul`, `choice`, `score` questions |
| Typed extraction | `extraction:run`, `POST /v1/extraction`; Clairic values, spans, nullability, confidence and intervals |
| Research/patch generation | `infer:<alias>` through Responses/chat; enabled routes only |
| Small execution / CI status | `sandbox:run/read/cancel`; `projects:read/configure`, `ci:read` |
| Account evolution | `evolution:read/write/execute`: content-addressed prompt/policy/skill/source/runtime/evaluation artifacts, jobs, evidence and active-pointer CAS; journal references these IDs, never moves account authority into runners |
| Spending | Existing wallet reservations, settlement/reconciliation, org budgets, `wallet:read`, `usage:read` |

Supply stable idempotency keys/ceilings. Not Organic reserves/settles hosted costs; Ephyra projects request IDs/receipts (unknown cost `null`). Trail policy bounds dispatch/concurrency; reconcile timeouts without duplicate charges. Sources: Not Organic `README.md`, `PRODUCT.md`, `apps/docs/api.html`, `packages/contracts/src/{catalog,judgement,extraction,account-evolution}.ts`.

All three registry kinds are first-class; the **System One tier** is user-routed, not a fixed model pair:

| Kind | Backends / accounting |
|---|---|
| `notorganic` | Hosted, wallet-metered Jev, Luna, pplx and vision judgement routes; Clairic extraction; inference aliases. `judgement-vision` selects a configured image backend, not a distinct model identity |
| `byok:<vendor>` | Direct TypeSafe (Jev), Workers AI (Clairic/Clef), OpenAI-/Anthropic-compatible LLMs; user's keys stay server-side, usage/cost metered locally in Ephyra. BYOK is the application's responsibility by design (the same pattern as the user's other apps): Ephyra calls the vendor directly and never routes BYOK traffic through Not Organic |
| `selfhosted:<endpoint>` | Liquid AI d1 open weights (`d1-2B`, `d1-omni-2B`, `d1-omni-600M`, LFM Open License), Clef (Apache-2.0), pplx-decider; local accounting, pinned weights/license/runtime |

Target System One `POST /v1/systemone` per Not Organic's `infra/runpod/pplx-decider/deploy.md`: state/questions, typed answers/probabilities, backend identity. d1/Clef may need adapters. Extraction declares supported fields, preserving nulls, spans, intervals and truncation without invented confidence.

Registry records endpoint, credentials reference, backend/version, schema, capabilities, retention/pricing. Users select **per decision and extraction purpose**. Version thresholds by purpose/schema/backend identity, as the API requires. Never switch silently: default `allow_fallback:false`; authorized alternatives need separate thresholds/provenance. Unexpected identity blocks evaluation.

**Asks of Not Organic — verified gaps, not Ephyra reimplementations:**

- Register `ephyra` and scoped product credentials/entitlements: absent from `catalog.ts` product IDs.
- Optional d1 judgement backend: absent from `judgement.ts` backend/route list.
- Migrate Tangled AT-URI validation: `project-execution.ts` still requires `sh.tangled.repo` and `sh.tangled.spindle`; negotiate `org.tangled.*` schemas, not string replacement.
- Complete long-running Sprite execution, artifact export and cleanup/reconciliation. The 30 s sandbox is insufficient; evolution budgets do not prove runner availability.

### Evidence adapters

Keep git, OTel/OpenObserve, replay artifacts and `entire search` search/fetch adapters. Add **voxq** study operations alongside retrieval:

| Stage | Actual surface |
|---|---|
| Create/simulate | `voxq mcp` / `voxq http-mcp`: `create_survey`, `run_survey`, `get_results`, `get_analysis`; or `voxq serve`: `POST /surveys`, `/:id/estimate`, `/:id/run` |
| Real respondents, optional | REST `POST /surveys/:id/publish`; first-click, preference and chat-task studies; share/embedded interviews or panel recruitment |
| Evidence | REST `/surveys/:id/export`, results and interview analysis; retain study/instrument revision, stimulus/commit digests, cohort, model identity, collection cutoff, sample coverage, costs and caveats |

MCP lacks publishing and has documented type/context limitations: use REST/readback for structured studies. Hosted Bun `/api/surveys` enforces ownership; standalone Rust stays private. Bind voxq's Not Organic connection for wallet-paid inference; bare MCP/REST does not inherit it. Panels own respondent payment. Configure an enabled model: `persona` remains unavailable. Demo fixtures are not model evidence.

**Simulated answers are hypotheses, not measurements**; agreement proves neither accuracy nor representativeness. Separate synthetic/human evidence. Close collection/finish simulations before fixed-cutoff export; redact personal data/session capabilities. Sources: voxq `README.md`, `RADICLE.md`, `dev-docs/index.html`, `src/models/question.rs`.

Index sanitized evidence metadata in Postgres; optional embeddings retain source, revision and access scope. Retrieval never grants execution authority.

## 6. Deployable service map

| Railway template service | Responsibility | Persistent data / exposure |
|---|---|---|
| `api` | Control API, account/policy checks, web UI; TUI uses same API | Public HTTPS; private DB connection |
| `ingestor` | Forge streams/hooks, Signal normalization, reconciliation | Cursors in Postgres; authenticated webhook ingress |
| `worker` | DBOS workflows, Intent schedules, index updates | Private; workflow state in Postgres |
| `runner-gateway` | Allocation, credentials, lease enforcement, cleanup | Private control API; authenticated outbound-runner endpoint |
| `postgres` | Workflow/account-projection/index/audit databases | Dedicated volume; private only |
| `git-store` | Trail journals and repository mirrors | Dedicated volume; authenticated API/SSH |
| `artifact-store` | Content-addressed evidence | Volume-backed blob API initially; optional S3 backend |
| `otel-collector` | Redaction, buffering, sampling | Private OTLP; authenticated external ingress if needed |
| `openobserve` | Telemetry storage/query | Dedicated volume; private query API |
| `maintenance` | Short scheduled reconciliation/retention trigger | Cron; idempotent enqueue only |

No Redis is required. Images come from any accessible OCI registry, or local source upload; Railway deployment does not require GitHub. Use private service DNS, while retaining application authentication: network proximity is not authorization. [Railway services](https://docs.railway.com/services), [private networking](https://docs.railway.com/networking/private-networking)

Template inputs include bootstrap identity, encryption key reference, artifact backend, runner mode, and optional provider connections. Keep scheduled Intent probes in durable workflows; cron merely repairs missed scheduling. Back up Postgres, git, and blobs with a common manifest watermark and perform restore drills. This volume-based starter is single-instance, not HA.

The self-host edition runs the same binaries with one `devenv up`, local Postgres/OpenObserve, filesystem artifact storage, and loopback APIs. First-time host provisioning supplies KVM permissions and secrets; devenv does not silently escalate privileges. An explicit offline account adapter plus plain git and local d1/Clef/LLM/extractors eliminates hosted dependencies; it does not impersonate Not Organic accounts or wallet grants. Radicle node or Tangled knot/PDS/bobbin/spindle are optional separately configured forge components, not prerequisites for local Trails.

## 7. Security and audit

A **Service profile** binds image/lock digest, network boundary, credential scopes, policy, resource limits, and retention. Production investigation is read-only by default: log/query gateways with bounded queries and sanitized exports, never broad database credentials in an agent shell. Landing uses a distinct short-lived identity after authorization. Policy changes require a new profile digest and renewed approval.

Keep root/provider/forge signing keys outside sandboxes; issue short-lived tokens through the gateway. Encrypt secrets at rest with an externally supplied master key or optional OpenBao. Redact before logs, checkpoints, and model dispatch; snapshots may contain secrets despite environment-variable handling. Never publish secrets in git or AT Protocol records.

Tangled's documented spindle design sends secrets directly using DID-based service auth, rather than public records. Validate audience, expiry, method scope, and repository permissions; verify current method NSIDs against the pinned release. [Spindle security design](https://blog.tangled.org/ci/) Radicle signing authority remains in the adapter, not the patch-writing process. Plain-git hooks must bind pushes to authenticated principals.

Append audit events for access, model requests, wallet receipt references, approvals, credential issuance, Landing, and destruction receipts. Include actor, Trail, input/output hashes, policy revision, and external operation IDs. Hash-chain and periodically sign audit batches to an independent backup; a database administrator can otherwise rewrite local history. Prompt injection cannot grant capabilities. Approval is invalid after any bound revision changes.

## 8. Open questions and release risks

- Complete Not Organic product registration and live account/org isolation tests; contracts are not deployment proof. Verify voxq wallet connection, structured study round trips and export provenance.
- Pin Tangled schemas, mutation/attestation flow, service-auth NSIDs, and spindle stream behavior; test replay and missed-event recovery.
- Verify Sapling/Radicle and knot round trips, metadata recovery and ISL integration; custom-ref replication and Entire search/export remain acceptance tests. Retain plain-git/companion-git fallback.
- Prove Nix/devenv compatibility and network enforcement on Railway; no nested-KVM or privileged-container guarantee was established.
- Test DBOS crash recovery, ambiguous external writes, wallet-receipt reconciliation, and stale-lease rejection before enabling unattended Landing.
- Benchmark telemetry retention and runner cold starts; no resource sizing or cost savings were measured here.
- Validate backend-specific thresholds and local extraction coverage; never silently call hosted models. Sprite provisioning, artifact export and Storybook/Textbook images remain release gates.
