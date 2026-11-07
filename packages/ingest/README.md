# @ephyra/ingest

Pure redaction, stack parsing, fingerprinting and signal normalization plus an in-memory SignalStore. The store is process-local and does not provide durable idempotency or coverage accounting. No OTLP receiver is available yet; transport, quotas, partial success, and production ingestion remain Unverified. Redaction is best effort and must not be treated as a complete secret detector.
