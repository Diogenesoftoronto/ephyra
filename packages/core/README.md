# Core

The lifecycle is a pure trail transition and replay function. `rolled_back` means rollback has been requested and remains so until a `rollback_completed` event reopens research at the next revision. Effects are commands, not evidence of execution. Network integrations, actual rollback, proof execution, and delivery are unverified here. The existing effect contract has no command for voxq runs, intent probes, comment replies, or child evidence delivery; orchestration must handle those events separately.
