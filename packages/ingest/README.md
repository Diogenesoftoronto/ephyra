# Ingest

Normalizes OTLP/HTTP JSON logs and traces into redacted signals, groups failures by fingerprint, and offers an in-memory signal store and Hono routes. The package tests exercise sample logs, span errors, stack parsing, redaction and in-process duplicate requests.

Protobuf ingestion is planned and returns 415. The memory store, request deduplication and notification suppression are process-local and do not survive restart or coordinate replicas; they are not durable delivery guarantees. Coverage gaps and real collector integration remain unverified. The caller must authenticate requests, provide quota enforcement and bind telemetry to the correct repository before production use.
