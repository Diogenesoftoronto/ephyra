# Ingest

Normalizes OTLP/HTTP JSON and binary Protobuf logs and traces into redacted signals, groups failures by fingerprint, and offers an in-memory signal store and Hono routes. Resource attributes retain mobile OS and app-version context alongside trace/span identifiers.

## Transport

Send exports to `POST /v1/logs` or `POST /v1/traces` with `application/json` or `application/x-protobuf`. Both accept `Content-Encoding: gzip`; the configured `maxBodyBytes` applies independently to compressed and expanded payloads. Binary requests receive binary OTLP Export responses (including partial success) and `google.rpc.Status` errors. Unsupported encodings return 415; malformed payloads return 400; oversized payloads return 413. No metrics or gRPC receiver is provided.

The bounded wire decoder follows the consumed fields in [opentelemetry-proto v1.5.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.5.0/opentelemetry/proto), skips unknown fields, preserves 64-bit timestamps as decimal strings, and emits hexadecimal trace/span IDs. Depth and field-count ceilings prevent recursive or excessive object expansion. Application signals use millisecond timestamps. Only error logs, exception events and error spans become investigation signals; unrelated telemetry is accepted without creating a quest.

Standard mobile OpenTelemetry exporters, including Embrace's OTLP export, can use this transport via an authenticated collector. The mobile SDK must already capture the required telemetry; accepting OTLP does not create crash capture, symbolication, source maps or release mapping. Do not embed privileged Ephyra credentials into distributed apps. Configure the collector's OTLP/HTTP exporter with the workspace-bound ingress credentials instead.

## Verification and limits

Offline tests exercise independent binary wire fixtures, JSON compatibility, gzip, compressed/expanded limits, malformed fields, unknown fields, recursion/field ceilings, trace extraction, resource redaction, partial responses and process-local duplicate requests. Property tests check string transport and full unsigned 64-bit timestamp preservation. Run `bun test packages/ingest` and `bun run --filter @ephyra/ingest typecheck`.

The memory store, request deduplication and notification suppression are process-local and do not survive restart or coordinate replicas; they are not durable delivery guarantees. Coverage gaps, real collector delivery and live iOS/Android/Embrace telemetry remain **Unverified**. The caller must authenticate requests, provide quota enforcement and bind telemetry to the correct repository before production use. `service.name` is untrusted telemetry, not repository authorization. Receipt of no errors does not prove application health or a successful repair.
