import { Hono } from "hono";
import { z } from "zod";
import type { InboxItem, Trail, TrailEvent } from "@ephyra/core";
import { auth, type AuthEnv } from "./auth.ts";

export class StaleApproval extends Error {}
export interface HttpPort {
  inbox(): Promise<InboxItem[]>;
  trails(state?: string): Promise<Trail[]>;
  trail(id: string): Promise<{ trail: Trail; events: TrailEvent[] } | null>;
  /** Must atomically check the bound revision, record the decision and append its audit event. */
  decide(id: string, input: DecisionInput, principal: string): Promise<void>;
  action(id: string, action: string, input: unknown, principal: string): Promise<void>;
}
export type DecisionInput = { checkpoint: "A" | "B" | "C" | "spend"; verdict: "approve" | "revise" | "reject"; note?: string };
const decision = z.object({ checkpoint: z.enum(["A", "B", "C"]), verdict: z.enum(["approve", "revise", "reject"]), note: z.string().max(4000).optional() });
const spendDecision = z.object({ verdict: z.enum(["approve", "revise", "reject"]), note: z.string().max(4000).optional() });

export function createApp(token: string, port: HttpPort, otlp = new Hono()): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("/v1/*", auth(token));
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
      await port.action(c.req.param("id"), action, input, c.get("principal"));
      return c.json({ ok: true });
    });
  }
  app.route("/otlp", otlp);
  return app;
}
