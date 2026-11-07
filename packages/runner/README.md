# Runner

Runner adapters implement the core port. `selectRunner` checks capabilities; `runnerRejections` explains mismatches. `ArtifactStore` stores SHA-256-addressed bytes and verifies them when read.

| Capability | Verification |
| --- | --- |
| Trusted local process runner | Tested against a temporary git repository: worktrees, sanitized environment, process-group timeout, path rejection, snapshots, artifacts, teardown and expiry. It is not a security sandbox and does not enforce network or resource limits. It advertises only unrestricted egress. Devenv wrapping requires explicit `allowDevenv` and was not exercised against Nix. |
| Railway | Network mapping, checkpoint and lifecycle tested with an injected fake. Real SDK integration, filesystem operations, isolation, browser dependencies and Nix are **Unverified**; default client throws `Unverified`. |
| Not Organic | Script request and polling tested with fake authenticated fetch. Live gateway, billing, cancellation and execution are **Unverified**. It accepts a `.py` or `.ts` script written through the port, with command `["python", "file.py"]` or `["typescript", "file.ts"]`. It does not clone repositories or provide a shell. |
| CAS | Local digest, round-trip and corruption detection tested. |

Railway documents its `railway` TypeScript SDK and sandbox lifecycle in the [sandbox docs](https://docs.railway.com/sandboxes) and [code execution guide](https://docs.railway.com/guides/code-execution-sandboxes). ISOLATED allows internet egress; it does not satisfy `none` or an egress allowlist. PRIVATE joins the private network. Checkpoints preserve disk only.

Local handles, snapshot metadata, remote handle mappings and destruction receipts are process-local. The local runner is only for trusted repositories: `trusted: true` is mandatory. Checkpoint archives and local artifacts can contain repository data and must be stored accordingly. Expired handles may still be destroyed for cleanup.
