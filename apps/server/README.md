# Control plane

The local orchestration foundation accepts injected transitions, policy context and effect handlers. It deduplicates events and effects in memory and publishes an outbox through the journal CAS interface. Memory state is not durable; this is not a production control plane. A failed effect is held for reconciliation rather than retried.

Unverified and not yet implemented: Postgres, DBOS recovery, HTTP/auth, approvals, and real adapter composition. Journal durability depends on the injected adapter; no live integration has been verified.
