# Runner

Runner adapters implement the core port. `selectRunner` checks capabilities; `runnerRejections` explains mismatches. `ArtifactStore` stores SHA-256-addressed bytes and verifies them when read.

| Capability | Verification |
| --- | --- |
| Trusted local process runner | Tested against a temporary git repository: worktrees, sanitized environment, process-group timeout, path rejection, snapshots, artifacts, teardown and expiry. It is not a security sandbox and does not enforce network or resource limits. It advertises only unrestricted egress. Devenv wrapping requires explicit `allowDevenv` and was not exercised against Nix. |
| Railway | The pinned `railway@3.16.0` SDK is wired for creation, exec, file I/O, disk checkpoints, restore and destroy. Offline SDK tests cover receipts, replay, isolation of configured account/environment, bounded output/files and ambiguous outcomes; a real local Git bundle exercises the checkout commands. Live provisioning, VM isolation, billing, browser dependencies and Nix are **Unverified**. |
| Not Organic | Script request and polling tested with fake authenticated fetch. Live gateway, billing, cancellation and execution are **Unverified**. It accepts a `.py` or `.ts` script written through the port, with command `["python", "file.py"]` or `["typescript", "file.ts"]`. It does not clone repositories or provide a shell. |
| CAS | Local digest, round-trip and corruption detection tested. |

Railway documents its `railway` TypeScript SDK and sandbox lifecycle in the [sandbox docs](https://docs.railway.com/sandboxes) and [code execution guide](https://docs.railway.com/guides/code-execution-sandboxes). ISOLATED allows internet egress; it does not satisfy `none` or an egress allowlist. PRIVATE joins the private network. Checkpoints preserve disk only.

Local runner handles/snapshots and Not Organic adapter receipts remain process-local. The local runner is only for trusted repositories: `trusted: true` is mandatory. Checkpoint archives and local artifacts can contain repository data and must be stored accordingly. Expired handles may still be destroyed for cleanup.

## Railway configuration and durability

Create a client with `createRailwaySandboxClient({ token, environmentId, image: { kind: "default" }, idleTimeoutMinutes: 1 })`.
Alternatively select an operator-prepared, credential-free base with `image: { kind: "checkpoint", name }`. Arbitrary Docker images are not supported by this SDK. The adapter passes explicit identity, public API endpoints, auth type and disabled SDK logging; it never inherits Railway identity or endpoints from the host environment. Only public recovery metadata enters the sandbox environment. The standard provider image includes Git; toolchain availability is otherwise verified by execution.

Construct `RailwaySandboxRunner(cas, client, { ledger, leaseStore, scope, repositoryBundle, onLease })`:

- `ledger` implements the core `OperationLedger` and must be durable in production. Allocation keys bind the authenticated owner/workspace scope, provider environment/base, trail revision, attempt and complete profile. Changed plans cannot reuse a key. The default memory ledger is for offline development.
- `leaseStore` is a durable inventory, such as `new FileRailwayLeaseStore(directory)`. Its directory must live on durable storage alongside the ledger. The default inventory is in memory.
- `scope` identifies the authenticated DID and workspace, never a mutable alias. Use separate scopes for separate owners.
- `repositoryBundle({repoUrl, commit})` supplies `{bytes, ref, shallow?}` from the host's authenticated mirror. The adapter uploads this credential-free bundle, initializes Git, fetches the named ref and verifies the exact full commit. It does not clone host paths, install a credential helper, or configure a remote. It does not automatically fetch LFS objects or submodules.
- `onLease(handle)` can schedule durable cleanup using `handle.id` as the idempotency key. It may be called repeatedly with the same immutable handle. Run `reapExpired()` at startup and on a bounded schedule; it uses the persisted real resource IDs, including resources whose readiness or checkout failed.

CPU and decimal-memory-MB ceilings map to SDK resource options. `diskMb: 0` explicitly selects provider-managed disk with **no enforced quota**; positive disk limits are rejected. `none`, egress allowlists and credential mediation are rejected. Browser capability is false until an image-specific implementation verifies it. Network `private` permits both private networking and internet egress.

The immutable lease rejects new work after expiry and clamps command deadlines. It is **not a provider absolute TTL**. Railway's separate, finite idle timeout does not destroy a sandbox while active work keeps it alive, so durable scheduled cleanup is required. Commands use ephemeral sessions to avoid silent gaps in the provider's durable log retention; a dropped or unconfirmed command outcome is `ReconciliationRequired`, never a synthesized exit code. The command is not automatically repeated. Captured output defaults to 1 MiB total; exceeding it throws `Unverified`. Files default to 64 MiB and use bounded streams. File writes use the SDK's one-shot upload form to disable automatic retries. Paths are lexically restricted to `/workspace`; shell access deliberately permits the entire isolated VM and is not a per-file security boundary.

Creation, checkpoint and destroy claims survive process restart with a durable ledger. The SDK create response is observed to persist the real resource ID before readiness polling. If the provider accepted a create but its response was never observed, Ephyra cannot determine the resource ID: the operation remains blocked for reconciliation rather than creating another billable sandbox. A known resource can be reconciled with a status read; a checkpoint uses a unique stable name; uncertain teardown only completes after an authoritative destroyed/not-found result. Checkpoints are disk-only. Calling `checkpoint(handle)` reuses one immutable checkpoint per handle; a caller that needs another capture must pass a distinct explicit second operation key. Checkpoints remain provider resources until an operator removes them.

Verified against the [official sandbox contract](https://docs.railway.com/sandboxes#typescript-sdk) and the [SDK source](https://github.com/railwayapp/railway-ts-sdk). Tests make no provider calls and incur no cloud charges.

Repository bundles may include `shallow` boundary OIDs. Only boundaries reachable from the selected code commit are
exported; the receiver validates their count/object format and installs them before fetch. Native Git bundles alone
do not preserve shallow history. Actual local SHA-1/SHA-256 shallow checkout and patch return paths are tested.


Cancellation now kills and joins active local process groups before removing their worktrees; concurrent destruction
shares one receipt. Railway bundle requests may include an additional exact `base` tip. Hosted transport includes
only the selected head and refreshed base histories, retaining reachable shallow boundaries for both; this permits
a real isolated divergent rebase without exporting private journal history. Offline SHA-1/SHA-256 tests exercise both
tips and prove unrelated journal objects are excluded. Provider billing and live teardown remain Unverified.
