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
  trail(id: string): Promise<{ trail: Trail; events: TrailEvent[] } | null>;
  /** Must atomically check the bound revision, record the decision and append its audit event. */
  decide(id: string, input: DecisionInput, principal: string): Promise<void>;
  action(id: string, action: string, input: unknown, principal: string): Promise<void>;
  /** Operator view: dead-lettered jobs and effects needing reconciliation. */
  ops?(): Promise<unknown>;
}
export type DecisionInput = { checkpoint: "A" | "B" | "C" | "spend"; verdict: "approve" | "revise" | "reject"; note?: string };
const decision = z.object({ checkpoint: z.enum(["A", "B", "C"]), verdict: z.enum(["approve", "revise", "reject"]), note: z.string().max(4000).optional() });
const spendDecision = z.object({ verdict: z.enum(["approve", "revise", "reject"]), note: z.string().max(4000).optional() });

/**
 * Who may change trails. When `requireSignIn` is set (Not Organic sign-in configured), decisions and actions
 * need a signed-in account on the approver list; the service token alone can no longer approve anything.
 */
export type ApprovalPolicy = { requireSignIn: boolean; approvers: ReadonlySet<string> };

const PLUGIN_REPORT = /^\/v1\/runs\/[^/]+\/policy$/;

export function createApp(
  token: string, port: HttpPort, otlp = new Hono(), sessions?: SessionResolver,
  approval: ApprovalPolicy = { requireSignIn: false, approvers: new Set() },
  /** Extra /v1 routes (the console's) that inherit the same authentication and approver rules. */
  extra?: (approval: ApprovalPolicy) => Hono<AuthEnv>,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("/v1/*", auth(token, sessions));
  // Every mutating /v1 route is a human decision or action.
  app.use("/v1/*", async (c, next) => {
    if (c.req.method === "GET" || !approval.requireSignIn) return next();
    // The harness plugin inside an agent run reports policy decisions with the service token; that is the one write a machine may make.
    if (PLUGIN_REPORT.test(new URL(c.req.url).pathname) && c.get("principalKind") === "service") return next();
    if (c.get("principalKind") !== "human") {
      return c.json({ error: "sign in with Not Organic (`ephyra login`) to change trails" }, 403);
    }
    if (!approval.approvers.has(c.get("principal"))) {
      return c.json({ error: "this Not Organic account is not an approver on this deployment" }, 403);
    }
    return next();
  });
  app.get("/v1/inbox", async (c) => c.json(await port.inbox()));
  app.get("/v1/trails", async (c) => c.json(await port.trails(c.req.query("state"))));
  app.get("/v1/trails/:id", async (c) => {
    const result = await port.trail(c.req.param("id"));
    return result ? c.json(result) : c.json({ error: "not found" }, 404);
  });
  app.post("/v1/trails/:id/decide", async (c) => {
    const parsed = decision.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid decision" }, 400);
    try {
      await port.decide(c.req.param("id"), parsed.data, c.get("principal"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof StaleApproval) return c.json({ error: "approval is stale" }, 409);
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
      throw error;
    }
  });
  for (const action of ["comment", "claim", "release", "park", "resume", "kill", "land"]) {
    app.post(`/v1/trails/:id/${action}`, async (c) => {
      const input = await c.req.json().catch(() => ({}));
      try {
        await port.action(c.req.param("id"), action, input, c.get("principal"));
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
