import { Hono } from "hono";
import { z } from "zod";
import type { InboxItem, Trail, TrailEvent } from "@ephyra/core";
import { auth, type AuthEnv, type SessionResolver } from "./auth.ts";

export class StaleApproval extends Error {}
/** The state machine refused the event (e.g. claiming a closed trail). */
export class InvalidTransition extends Error {}
export interface HttpPort {
  inbox(): Promise<InboxItem[]>;
  trails(state?: string): Promise<Trail[]>;
  trail(id: string): Promise<{ trail: Trail; events: TrailEvent[]; artefacts?: { path: string; content: string | null }[] } | null>;
  /** Must atomically check the bound revision, record the decision and append its audit event. */
  decide(id: string, input: DecisionInput, principal: string): Promise<void>;
  action(id: string, action: string, input: unknown, principal: string, operationKey?: string): Promise<void>;
  /** Reads the durable receipt, scoped to the authenticated person and action; null means unknown trail. */
  operationStatus?(id: string, action: string, key: string, principal: string): Promise<{ status: 'recorded' | 'not_found' } | null>;
  /** Operator view: dead-lettered jobs and effects needing reconciliation. */
  ops?(): Promise<unknown>;
  /** A file from the trail's journal tree (hypothesis.md, plan.md, …), so the inbox can show what it asks you to judge. */
  file?(id: string, path: string): Promise<Uint8Array | null>;
}

/**
 * Journal files a reader may fetch. An allow-list, not a sanitiser: anything else is refused before it reaches
 * the journal, so no path can climb out of the trail's tree. Contents are agent-written, untrusted text.
 */
const READABLE_NAMES = new Set(["hypothesis.md", "plan.md", "intent.md", "evidence/index.json", "proof/manifest.json"]);
const READABLE_ARTEFACT = /^artefacts\/[a-z][a-z_-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const READABLE_DECISION = /^decisions\/(?:[ABC]\/[a-f0-9]{64}|latest-[ABC])\.json$/;
const READABLE_EVIDENCE = /^evidence\/research\/[0-9]{4,10}\/[a-f0-9]{16}\/(?:index|source-[0-9]{2})\.json$/;
export const isReadableFile = (path: string) =>
  !path.includes("..") && (READABLE_NAMES.has(path) || READABLE_ARTEFACT.test(path)
    || READABLE_DECISION.test(path) || READABLE_EVIDENCE.test(path));
/** Largest file served, in bytes. Bigger files are refused rather than truncated, so nobody judges half a document. */
export const MAX_FILE_BYTES = 256 * 1024;
export type DecisionInput = { checkpoint: "A" | "B" | "C" | "spend"; verdict: "approve" | "revise" | "reject"; note?: string; bound?: InboxItem["bound"] };
const reviewBound = z.object({ rev: z.number().int().positive(), head: z.string().optional(), proofDigest: z.string().optional() });
const decision = z.object({
  checkpoint: z.enum(["A", "B", "C"]), verdict: z.enum(["approve", "revise", "reject"]),
  note: z.string().max(4000).optional(), bound: reviewBound.optional(),
});
const spendDecision = z.object({ verdict: z.enum(["approve", "revise", "reject"]), note: z.string().max(4000).optional(), bound: reviewBound.optional() });
const collaborationActions = new Set(['comment', 'claim', 'release']);
const operationKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const commentInput = z.object({ text: z.string().max(4000).refine((text) => text.trim().length > 0) }).strict();
const emptyInput = z.object({}).strict();

/**
 * Who may change trails. When `requireSignIn` is set (Not Organic sign-in configured), decisions and actions
 * need a signed-in account on the approver list; the service token alone can no longer approve anything.
 */
export type ApprovalPolicy = {
  requireSignIn: boolean;
  approvers: ReadonlySet<string>;
  browserOrigin?: string;
  /** Resolve current workspace authority per request; never cache shared membership in the static set. */
  resolveApprover?: (did: string) => Promise<boolean>;
};
export const isApprover = (approval: ApprovalPolicy, did: string): Promise<boolean> =>
  approval.resolveApprover ? approval.resolveApprover(did) : Promise.resolve(approval.approvers.has(did));

const PLUGIN_REPORT = /^\/v1\/runs\/[^/]+\/policy$/;

export function createApp(
  token: string, port: HttpPort, otlp = new Hono(), sessions?: SessionResolver,
  approval: ApprovalPolicy = { requireSignIn: false, approvers: new Set() },
  /** Extra /v1 routes (the console's) that inherit the same authentication and approver rules. */
  extra?: (approval: ApprovalPolicy) => Hono<AuthEnv>,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("/v1/*", auth(token, sessions, approval.browserOrigin));
  // Every mutating /v1 route is a human decision or action.
  app.use("/v1/*", async (c, next) => {
    if (c.req.method === "GET" || !approval.requireSignIn) return next();
    // The harness plugin inside an agent run reports policy decisions with the service token; that is the one write a machine may make.
    if (PLUGIN_REPORT.test(new URL(c.req.url).pathname) && c.get("principalKind") === "service") return next();
    if (c.get("principalKind") !== "human") {
      return c.json({ error: "sign in with Not Organic to change trails" }, 403);
    }
    if (!await isApprover(approval, c.get("principal"))) {
      return c.json({ error: "this Not Organic account is not an approver in this workspace" }, 403);
    }
    return next();
  });
  app.get("/v1/me", async (c) => c.json({
    principal: c.get("principal"), kind: c.get("principalKind"),
    approver: !approval.requireSignIn || (c.get("principalKind") === "human" && await isApprover(approval, c.get("principal"))),
  }));
  app.get("/v1/inbox", async (c) => { c.header('Cache-Control', 'no-store'); return c.json(await port.inbox()); });
  app.get("/v1/trails", async (c) => c.json(await port.trails(c.req.query("state"))));
  app.get("/v1/trails/:id", async (c) => {
    c.header('Cache-Control', 'no-store');
    const result = await port.trail(c.req.param("id"));
    return result ? c.json(result) : c.json({ error: "not found" }, 404);
  });
  app.get('/v1/trails/:id/operations/:action', async (c) => {
    c.header('Cache-Control', 'no-store');
    const action = c.req.param('action');
    const key = operationKeySchema.safeParse(c.req.query('key'));
    if (!collaborationActions.has(action) || !key.success) return c.json({ error: 'invalid operation lookup' }, 400);
    if (!port.operationStatus) return c.json({ error: 'operation receipts unavailable' }, 501);
    const result = await port.operationStatus(c.req.param('id'), action, key.data, c.get('principal'));
    return result ? c.json(result) : c.json({ error: 'not found' }, 404);
  });
  app.get("/v1/trails/:id/file", async (c) => {
    const path = c.req.query("path") ?? "";
    if (!isReadableFile(path)) return c.json({ error: "path not readable" }, 400);
    if (!port.file) return c.json({ error: "not supported" }, 501);
    const data = await port.file(c.req.param("id"), path);
    if (!data) return c.json({ error: "not found" }, 404);
    if (data.byteLength > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);
    const type = path.endsWith(".json") ? "application/json" : path.endsWith(".md") ? "text/markdown" : "text/plain";
    // Copy into a plain ArrayBuffer: Hono's body overloads don't accept a view over a shared or foreign buffer.
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    return c.body(bytes.buffer, 200, { "Content-Type": `${type}; charset=utf-8`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  });
  app.post("/v1/trails/:id/decide", async (c) => {
    const parsed = decision.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid decision" }, 400);
    try {
      await port.decide(c.req.param("id"), parsed.data, c.get("principal"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof StaleApproval) return c.json({ error: "approval is stale" }, 409);
      if (error instanceof InvalidTransition) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  app.post("/v1/spend/:id/decide", async (c) => {
    const parsed = spendDecision.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid decision" }, 400);
    try {
      await port.decide(c.req.param("id"), { ...parsed.data, checkpoint: "spend" }, c.get("principal"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof StaleApproval) return c.json({ error: "approval is stale" }, 409);
      if (error instanceof InvalidTransition) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  for (const action of ["comment", "claim", "release", "park", "resume", "kill", "land"]) {
    app.post(`/v1/trails/:id/${action}`, async (c) => {
      const input = await c.req.json().catch(() => null);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return c.json({ error: 'invalid action input' }, 400);
      if (action === 'comment' && !commentInput.safeParse(input).success) return c.json({ error: 'comment must contain 1 to 4000 characters' }, 400);
      if (['claim', 'release'].includes(action) && !emptyInput.safeParse(input).success) return c.json({ error: 'invalid action input' }, 400);
      const suppliedKey = c.req.header('Idempotency-Key');
      if (suppliedKey !== undefined && !operationKeySchema.safeParse(suppliedKey).success) return c.json({ error: 'invalid operation key' }, 400);
      try {
        await port.action(c.req.param("id"), action, input, c.get("principal"), collaborationActions.has(action) ? suppliedKey : undefined);
        return c.json({ ok: true });
      } catch (error) {
        if (error instanceof InvalidTransition) return c.json({ error: error.message }, 409);
        throw error;
      }
    });
  }
  app.get("/v1/ops", async (c) => c.json(port.ops ? await port.ops() : {}));
  if (extra) app.route("/", extra(approval));
  app.route("/otlp", otlp);
  return app;
}
