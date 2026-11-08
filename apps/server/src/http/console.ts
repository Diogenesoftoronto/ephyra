// Console routes (design/05-console.md). Mounted under the same auth as the rest of /v1; every response is validated with the core
// schemas before it is sent. Mutations need an approver when sign-in is on (the shared middleware in app.ts); publishing checks again.
import { Hono } from "hono";
import { z } from "zod";
import { ActivityItem, AgentRun, AgentRunEvent, AreaSketch, Draft, PERSONAS, PersonaId, PolicyDoc, UsageEntry, UsageSummary, type Trail } from "@ephyra/core";
import { BadCursor, DAY_MS, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, pageEntries, summarizeUsage, type TrailInfo, type UsageFilter,
  type UsageStore } from "../usage.ts";
import { DraftError, type DraftService } from "../drafts.ts";
import type { PolicyDocs } from "../docs.ts";
import type { RunBroker, RunStore } from "../runs.ts";
import type { AuthEnv } from "./auth.ts";
import type { ApprovalPolicy } from "./app.ts";
import { PolicyActivationError, type PolicyActivation } from "../policy-activation.ts";
import { PolicyActivationReceipt } from "@ephyra/core";

export type ConsolePort = {
  usage: UsageStore;
  trails(): Promise<Trail[]>;
  activity(limit: number): Promise<unknown[]>;
  docs: PolicyDocs;
  drafts: DraftService;
  runs: RunStore;
  broker: RunBroker;
  now(): Date;
  activation?: PolicyActivation;
};

/** Responses carry the application map as an additive field next to the core shapes. */
const DocOut = PolicyDoc.extend({ sketches: z.array(AreaSketch).optional() });
const DraftOut = Draft.extend({ sketches: z.array(AreaSketch).optional() });
const PolicyReport = z.object({
  decision: z.enum(["allow", "reject", "modify"]), rule: z.string().min(1).max(120), reason: z.string().max(500),
  tool: z.string().min(1).max(100).optional(), callId: z.string().min(1).max(100).optional(),
});
const RUN_STATUSES = ["running", "done", "failed", "unavailable"] as const;
const SSE_POLL_MS = 1000;
const SSE_HEARTBEAT_MS = 15_000;
const PAGE = 500;

class BadQuery extends Error {}

function trailInfo(trails: Trail[]): Map<string, TrailInfo> {
  return new Map(trails.map((t) => [t.id, { id: t.id, short: t.short, title: t.title, budget: {
    spendMicrousdUsed: t.budget.spendMicrousdUsed, spendMicrousdMax: t.budget.spendMicrousdMax, tokensUsed: t.budget.tokensUsed, tokensMax: t.budget.tokensMax,
  } }]));
}

function filterFrom(q: (name: string) => string | undefined, now: Date): UsageFilter {
  const time = (name: string): Date | undefined => {
    const raw = q(name);
    if (raw === undefined) return undefined;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new BadQuery(`${name} is not a valid time`);
    return d;
  };
  const to = time("to") ?? now;
  const from = time("from") ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (from > to) throw new BadQuery("from is after to");
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) throw new BadQuery(`the window can be at most ${MAX_WINDOW_DAYS} days`);
  const persona = q("persona");
  if (persona !== undefined && persona !== "unattributed" && !PersonaId.safeParse(persona).success) throw new BadQuery("unknown persona");
  const engine = q("engine");
  const trail = q("trail");
  return {
    from, to, ...(persona ? { persona: persona as UsageFilter["persona"] } : {}), ...(engine ? { engine } : {}), ...(trail ? { trail } : {}),
  };
}

const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadQuery(`expected an integer from ${min} to ${max}`);
  return n;
};

const MessageBody = z.object({
  text: z.string(),
  quotes: z.array(z.object({ source: z.enum(["signal", "comment"]), text: z.string().max(20000) })).max(5).optional(),
});
const ContentBody = z.object({ content: z.string(), baseDigest: z.string().min(1) });

export function consoleRoutes(port: ConsolePort, approval: ApprovalPolicy): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.onError((error, c) => {
    if (error instanceof BadQuery || error instanceof BadCursor) return c.json({ error: error.message }, 400);
    if (error instanceof DraftError) return c.json({ error: error.message }, error.status);
    if (error instanceof PolicyActivationError) return c.json({ error: error.message }, error.status);
    throw error;
  });

  app.get("/v1/personas", (c) => c.json(PERSONAS));

  app.get("/v1/usage", async (c) => {
    const filter = filterFrom((n) => c.req.query(n), port.now());
    const [entries, trails] = await Promise.all([port.usage.list(), port.trails()]);
    return c.json(UsageSummary.parse(summarizeUsage(entries, filter, trailInfo(trails))));
  });

  app.get("/v1/usage/entries", async (c) => {
    const filter = filterFrom((n) => c.req.query(n), port.now());
    const limit = int(c.req.query("limit"), 50, 1, 200);
    const cursor = c.req.query("cursor");
    const page = pageEntries(await port.usage.list(), filter, { limit, ...(cursor ? { cursor } : {}) });
    return c.json({ entries: z.array(UsageEntry).parse(page.entries), ...(page.cursor ? { cursor: page.cursor } : {}) });
  });

  app.get("/v1/activity", async (c) => c.json(z.array(ActivityItem).parse(await port.activity(int(c.req.query("limit"), 50, 1, 200)))));

  app.get("/v1/docs", async (c) => c.json(z.array(DocOut).parse(await port.docs.list())));
  app.get("/v1/policy/active", async (c) => {
    const current = await port.activation?.restore() ?? null;
    return c.json(current ? PolicyActivationReceipt.parse(current) : null);
  });
  app.get("/v1/docs/:path{.+}", async (c) => {
    const doc = await port.docs.get(c.req.param("path"));
    return doc ? c.json(DocOut.parse(doc)) : c.json({ error: "not found" }, 404);
  });

  // ── Agent runs ──
  app.get("/v1/runs", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !(RUN_STATUSES as readonly string[]).includes(status)) throw new BadQuery("unknown status");
    const trail = c.req.query("trail");
    const runs = await port.runs.list({ limit: int(c.req.query("limit"), 50, 1, 200), ...(trail ? { trail } : {}),
      ...(status ? { status: status as AgentRun["status"] } : {}) });
    return c.json(z.array(AgentRun).parse(runs));
  });
  app.get("/v1/runs/:id", async (c) => {
    const run = await port.runs.get(c.req.param("id"));
    return run ? c.json(AgentRun.parse(run)) : c.json({ error: "not found" }, 404);
  });
  app.get("/v1/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const run = await port.runs.get(id);
    if (!run) return c.json({ error: "not found" }, 404);
    // EventSource reconnects send Last-Event-ID; ?after wins when both are given.
    const afterRaw = c.req.query("after") ?? c.req.header("Last-Event-ID");
    const after = afterRaw === undefined || afterRaw === "" ? undefined : int(afterRaw, -1, -1, Number.MAX_SAFE_INTEGER);
    const cursor = after === undefined || after < 0 ? undefined : after;
    if (!(c.req.header("Accept") ?? "").includes("text/event-stream")) {
      return c.json(z.array(AgentRunEvent).parse(await port.runs.events(id, cursor, PAGE)));
    }
    return sse(port, id, cursor, c.req.raw.signal);
  });
  // The Ephyra harness plugin reports its tool-call decisions here. Only a decision the plugin actually made becomes a policy event.
  app.post("/v1/runs/:id/policy", async (c) => {
    const parsed = PolicyReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid policy report" }, 400);
    const run = await port.runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    if (run.status !== "running") return c.json({ error: "the run has ended" }, 409);
    const r = parsed.data;
    const [stored] = await port.runs.append(run.id, [{
      at: port.now().toISOString(), type: "policy", policy: { decision: r.decision, rule: r.rule, reason: r.reason },
      ...(r.tool ? { tool: { callId: r.callId ?? "", name: r.tool } } : {}),
    }]);
    port.broker.notify(run.id);
    return c.json(AgentRunEvent.parse(stored), 201);
  });

  const body = async <T extends z.ZodTypeAny>(c: { req: { json(): Promise<unknown> } }, schema: T): Promise<z.infer<T>> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new DraftError(400, "invalid request body");
    return parsed.data;
  };
  const out = (draft: unknown) => DraftOut.parse(port.drafts.view(Draft.parse(draft)));

  app.post("/v1/drafts", async (c) => {
    const { path } = await body(c, z.object({ path: z.string().min(1).max(200) }));
    return c.json(out(await port.drafts.create(path, c.get("principal"))));
  });
  app.get("/v1/drafts", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !["open", "published", "discarded"].includes(status)) throw new BadQuery("unknown status");
    return c.json(z.array(DraftOut).parse((await port.drafts.list(status as Draft["status"] | undefined)).map((d) => port.drafts.view(d))));
  });
  app.get("/v1/drafts/:id", async (c) => c.json(out(await port.drafts.get(c.req.param("id")))));
  app.post("/v1/drafts/:id/messages", async (c) => {
    const input = await body(c, MessageBody);
    const key = c.req.header("Idempotency-Key");
    return c.json(out(await port.drafts.message(c.req.param("id"), {
      text: input.text, ...(input.quotes ? { quotes: input.quotes } : {}), principal: c.get("principal"), ...(key ? { key } : {}),
    })));
  });
  app.put("/v1/drafts/:id/content", async (c) => c.json(out(await port.drafts.setContent(c.req.param("id"), await body(c, ContentBody)))));
  app.put("/v1/drafts/:id/sketches", async (c) => {
    const input = await body(c, z.object({ sketches: z.array(AreaSketch).max(100), baseDigest: z.string().min(1) }));
    return c.json(out(await port.drafts.setSketches(c.req.param("id"), input)));
  });
  app.post("/v1/drafts/:id/apply", async (c) => {
    const { messageId } = await body(c, z.object({ messageId: z.string().min(1) }));
    return c.json(out(await port.drafts.apply(c.req.param("id"), messageId)));
  });
  app.post("/v1/drafts/:id/publish", async (c) => {
    // Publishing is for approvers. With approvers configured the caller must be a signed-in one (a service token's principal header is
    // caller-supplied, so it cannot stand in); with none configured (development) the shared auth is all there is.
    const principal = c.get("principal");
    if ((approval.requireSignIn || approval.approvers.size > 0) && (c.get("principalKind") !== "human" || !approval.approvers.has(principal))) {
      return c.json({ error: "only an approver can publish a draft" }, 403);
    }
    return c.json(out(await port.drafts.publish(c.req.param("id"), principal)));
  });
  app.post("/v1/drafts/:id/discard", async (c) => c.json(out(await port.drafts.discard(c.req.param("id")))));
  app.post("/v1/drafts/:id/activate", async (c) => {
    const principal = c.get("principal");
    if ((approval.requireSignIn || approval.approvers.size > 0)
      && (c.get("principalKind") !== "human" || !approval.approvers.has(principal)))
      return c.json({ error: "only an approver can activate a policy" }, 403);
    const key = c.req.header("Idempotency-Key");
    if (!key) return c.json({ error: "An activation operation key is required." }, 400);
    const request = await body(c, z.object({ expectedCommit: z.string(), expectedDigest: z.string(), expectedActive: z.string().nullable() }).strict());
    return c.json(PolicyActivationReceipt.parse(await port.drafts.activate(c.req.param("id"), { ...request, key, principal })));
  });

  return app;
}

/** A server-sent-events stream of a run's events from `after`, ending when the run has closed and everything it wrote has been sent. */
function sse(port: ConsolePort, runId: string, after: number | undefined, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let last = after;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(enc.encode(text));
      let sentAt = Date.now();
      try {
        send("retry: 2000\n\n");
        while (!signal.aborted) {
          // Read the run's state first: if it had already closed, one more read of the events cannot miss anything.
          const closed = (await port.runs.get(runId))?.status !== "running";
          const events = await port.runs.events(runId, last, PAGE);
          for (const e of events) {
            send(`id: ${e.seq}\nevent: run_event\ndata: ${JSON.stringify(AgentRunEvent.parse(e))}\n\n`);
            last = e.seq;
          }
          if (events.length) sentAt = Date.now();
          if (events.length === PAGE) continue;
          if (closed) {
            send(`event: end\ndata: ${JSON.stringify({ status: (await port.runs.get(runId))?.status ?? "failed" })}\n\n`);
            break;
          }
          if (Date.now() - sentAt >= SSE_HEARTBEAT_MS) { send(": ping\n\n"); sentAt = Date.now(); }
          await port.broker.wait(runId, SSE_POLL_MS, signal);
        }
      } catch {
        // The client went away or the store failed; the client resumes with Last-Event-ID.
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
