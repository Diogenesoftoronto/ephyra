# Forge adapters

PlainGitAdapter supports local conditional ref writes and post-receive spool reading. Tests exercise local ref updates and replay in one adapter instance. Idempotency and locks are process-local, not durable or cross-process; callers must not use them as a durable retry guarantee. Hook installation refuses to overwrite an existing hook.

Revert, plan preparation, Radicle operations and Tangled writes and events are Unverified. No live forge has been tested. Spool events do not contain a source timestamp; their observation time is recorded.
