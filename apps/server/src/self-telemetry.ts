// Ephyra watching Ephyra, without a vendor: the server reports its own unexpected errors as OTLP log records,
// and a workspace can receive OTLP from any service at its own authenticated intake.
//
// Errors the design expects (Unverified, ReconciliationRequired, a client's 4xx) are outcomes, not faults, and are
// never reported. Reports are deduplicated, rate limited, redacted, and never reported about themselves.
import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "eot_";
const RECEIPT = "otlp-intake.json";
/** OTLP received within this window counts as live telemetry for setup. */
export const INTAKE_FRESH_MS = 24 * 60 * 60 * 1000;

/** Record that the workspace intake accepted a batch: time only, never content. */
export async function recordIntake(directory: string, at = new Date()): Promise<void> {
  await Bun.write(`${directory}/${RECEIPT}`, JSON.stringify({ schema: 1, lastAcceptedAt: at.toISOString() }));
}

/** Whether the workspace intake accepted OTLP recently. Missing or unreadable means no. */
export async function intakeFresh(directory: string, now = Date.now()): Promise<boolean> {
  try {
    const at = Date.parse((await Bun.file(`${directory}/${RECEIPT}`).json()).lastAcceptedAt);
    return Number.isFinite(at) && at <= now + 60_000 && now - at < INTAKE_FRESH_MS;
  } catch { return false; }
}

/** The bearer token for one workspace's OTLP intake. Derived, not stored: it changes when the session key does. */
export function workspaceIngestToken(sessionKey: string, workspaceId: string): string {
  return TOKEN_PREFIX + createHmac("sha256", sessionKey).update(`otlp-ingest:v1:${workspaceId}`).digest("base64url");
}

export function verifyWorkspaceIngestToken(sessionKey: string, workspaceId: string, authorization: string | undefined): boolean {
  const presented = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!presented) return false;
  const expected = Buffer.from(workspaceIngestToken(sessionKey, workspaceId));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Designed outcomes: a check that could not be verified, a write awaiting reconciliation, lost work ownership. */
const EXPECTED = new Set(["Unverified", "ReconciliationRequired", "WorkerOwnershipLost", "AccountError", "DraftError", "InvalidTransition"]);

export type SelfReport = { error: unknown; source: string; route?: string };

export type SelfReporterOptions = {
  /** Full OTLP/HTTP JSON logs URL, for example https://host/otlp/workspaces/ws_…/v1/logs. */
  endpoint: string;
  token: string;
  service: string;
  environment: string;
  version: string;
  /** Absolute directory the code runs from; stripped so frames are repository paths that match policy areas. */
  sourceRoot: string;
  secrets: string[];
  fetch?: typeof fetch;
  now?: () => number;
  /** The same error is reported at most once per window. */
  dedupeMs?: number;
  maxPerMinute?: number;
};

export class SelfReporter {
  private readonly seen = new Map<string, number>();
  private window = { start: 0, count: 0 };
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: SelfReporterOptions) {
    const url = new URL(options.endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("EPHYRA_SELF_OTLP_ENDPOINT must be an HTTP(S) URL without credentials");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("A remote self-telemetry endpoint requires HTTPS");
  }

  /** Whether this report would be sent. Pure apart from the dedupe and rate state it updates. */
  admit(report: SelfReport): boolean {
    const error = report.error;
    const name = error instanceof Error ? error.name || error.constructor.name : typeof error;
    if (EXPECTED.has(name) || EXPECTED.has(error instanceof Error ? error.constructor.name : "")) return false;
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status < 500) return false;
    // A failure while ingesting telemetry would otherwise report itself forever.
    if (report.route?.startsWith("/otlp")) return false;
    const now = this.now();
    const key = `${name}\n${this.redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n${report.source}`;
    const last = this.seen.get(key);
    if (last !== undefined && now - last < (this.options.dedupeMs ?? 10 * 60_000)) return false;
    if (now - this.window.start >= 60_000) this.window = { start: now, count: 0 };
    if (this.window.count >= (this.options.maxPerMinute ?? 20)) return false;
    this.window.count++;
    this.seen.set(key, now);
    if (this.seen.size > 1000) for (const [k, at] of this.seen) if (now - at >= (this.options.dedupeMs ?? 10 * 60_000)) this.seen.delete(k);
    return true;
  }

  report(report: SelfReport): void {
    if (!this.admit(report)) return;
    const task = this.send(this.payload(report)).catch(() => {
      // Never report a failed report: the intake may be the thing that is down.
    }).finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** Waits for reports in flight. Tests and shutdown use it. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /** The OTLP JSON body for one error. Secrets are redacted and frames made repository-relative. */
  payload(report: SelfReport): unknown {
    const error = report.error;
    const name = error instanceof Error ? error.name || "Error" : "NonError";
    const message = this.redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const stack = this.redact(this.relative(error instanceof Error ? error.stack ?? "" : "")).slice(0, 16_000);
    const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const attributes = [
      attribute("exception.type", name),
      attribute("exception.message", message),
      attribute("exception.stacktrace", stack),
      attribute("ephyra.source", report.source),
      ...(report.route ? [attribute("http.route", report.route)] : []),
    ];
    return {
      resourceLogs: [{
        resource: { attributes: [
          attribute("service.name", this.options.service),
          attribute("service.version", this.options.version),
          attribute("deployment.environment.name", this.options.environment),
        ] },
        scopeLogs: [{
          scope: { name: "ephyra.self-telemetry" },
          logRecords: [{
            timeUnixNano: String(BigInt(this.now()) * 1_000_000n),
            severityNumber: 17,
            severityText: "ERROR",
            body: { stringValue: message || name },
            attributes,
          }],
        }],
      }],
    };
  }

  private async send(body: unknown): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
  }

  private relative(stack: string): string {
    const root = this.options.sourceRoot.replace(/\/+$/, "");
    return root ? stack.split(`file://${root}/`).join("").split(`${root}/`).join("") : stack;
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of [...this.options.secrets, this.options.token]) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
    return out;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

let installed: SelfReporter | null = null;

/** Sets the process-wide reporter. Without one, reporting is a no-op. */
export function installSelfReporter(reporter: SelfReporter | null): void {
  installed = reporter;
}

export function reportSelfError(error: unknown, source: string, route?: string): void {
  try { installed?.report({ error, source, route }); } catch { /* reporting never breaks the caller */ }
}
