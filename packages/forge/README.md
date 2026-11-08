# Forge adapters

Plain Git uses conditional ref updates, a post-receive JSONL spool, and temporary worktrees for revert. A process-local ledger is the default; inject a durable `OperationLedger` for recovery across restarts. Optional lockfiles serialize processes sharing a lock directory; stale lockfiles require manual recovery. Pending or ambiguous operations require reconciliation.

| Surface | Evidence |
| --- | --- |
| Plain Git landing, hook, revert | Local Git tests; not production integration verification |
| Tangled trail ref | Local bare Git remote test; knot deployment unverified |
| Tangled pull and events | Unverified; throw `Unverified` |
| Radicle | COB list/show snapshot ingestion and command builders; adapter remains unverified and does not write |
| Radicle list, show, comments and event ingestion | COB snapshot fixture from upstream; comment parser uses a synthetic test, no live verification |

Radicle references: [user guide](https://radicle.dev/guides/user), [quick start](https://radicle.dev/guides/quick-start), [patch manual](https://github.com/radicle-dev/heartwood/blob/master/rad-patch.1.adoc), [protocol guide](https://radicle.dev/guides/protocol), and [CI broker](https://radicle-ci-broker.liw.fi/userguide.html). The documented CLI lists and shows patches with `rad patch` and `rad patch show`; JSON support has not been verified. Comments use `rad patch comment <revision-id> --message <text>`.

## Repository onboarding

`parseRepositoryAddress` normalizes GitHub, GitLab and known Forgejo repository pages/clone URLs, arbitrary HTTPS Git
URLs, `rad:<rid>`, Radicle app repository links, and exact Tangled repository addresses. GitLab subgroup paths remain
intact. Repository subpages, embedded credentials, control characters and ambiguous encoded path delimiters are refused.
`radicleCloneArguments` constructs the fixed native clone argv without a shell. These exports do not perform I/O.

The server's `ForgeRepositoryConnector` resolves identities before account workspace selection. Current Tangled resolution
checks the handle's DID in both directions, the owner's `org.tangled.repo.declaration/<slug>`, and the repository DID's
`org.tangled.repo.manifest/self`; both claims must agree. Its DID document identifies the HTTPS knot, and the durable
connection uses the repository DID rather than a mutable handle. Metadata uses pinned public HTTPS with no credentials,
redirects or private destinations. The existing bounded HTTPS Git connector transfers objects and detects SHA-1/SHA-256
from the selected advertised ref before initializing its bare mirror. A private token must be bound explicitly to the
resolved clone host, or supplied by an account-bound credential provider.

The old bare `org.tangled.repo` collection is not a current published record schema. Exact AT URIs using it are never
rewritten to `sh.tangled.repo`; an unsupported schema returns `tangled_schema_unverified`. Use a current repository page,
declaration AT URI or manifest AT URI. This boundary follows the current [record reference](https://tangled.org/docs/reference/records/)
and [identity/clone URL reference](https://tangled.org/docs/reference/identifiers/).

Native Radicle onboarding creates a fresh profile under an isolated `RAD_HOME`, starts a managed foreground node, invokes
`rad clone --bare` with a bounded timeout and optional exact seed NIDs, reads the identity's default branch, and imports
only the selected branch into a separate bare workspace. No operator profile, SSH agent, proxy or deployment signing key
is inherited. Private access requires an injected account-specific profile provisioner; generic Git tokens cannot authorize
a native identity. The node is stopped and staging removed on success or failure; cleanup failures return an explicit error
and receipt. Time, combined output and repository disk size are bounded; hooks, submodules and object alternates are disabled
or refused. Current CLI contracts are in [clone arguments](https://github.com/radicle-dev/heartwood/blob/master/crates/radicle-cli/src/commands/clone/args.rs),
[auth](https://github.com/radicle-dev/heartwood/blob/master/crates/radicle-cli/src/commands/auth.rs), and
[node control](https://github.com/radicle-dev/heartwood/blob/master/crates/radicle-cli/src/commands/node/args.rs).

Verified: parser properties, exact identity fixtures, SSRF/credential boundaries, native argv/environment/cleanup contracts,
and real local Git branch imports in SHA-1 and SHA-256 repositories. Radicle commands themselves are substituted in tests;
no live native node, private identity, Tangled PDS/knot, push or landing operation was run. Live native interoperability
remains **Unverified** and does not upgrade the existing forge adapters' write capabilities.
