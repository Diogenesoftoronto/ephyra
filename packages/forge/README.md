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
