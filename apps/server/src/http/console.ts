// Console routes (design/05-console.md). Mounted under the same auth as the rest of /v1; every response is validated with the core
// schemas before it is sent. Mutations need an approver when sign-in is on (the shared middleware in app.ts); publishing checks again.
import { Hono } from "hono";
import { z } from "zod";
import { ActivityItem, Draft, PERSONAS, PersonaId, PolicyDoc, UsageEntry, UsageSummary, type Trail } from "@ephyra/core";
import { BadCursor, DAY_MS, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, pageEntries, summarizeUsage, type TrailInfo, type UsageFilter, type UsageStore } from "../usage.ts";
import { DraftError, type DraftService } from "../drafts.ts";
import type { PolicyDocs } from "../docs.ts";
import type { AuthEnv } from "./auth.ts";
import type { ApprovalPolicy } from "./app.ts";

export type ConsolePort = {
  usage: UsageStore;
  trails(): Promise<Trail[]>;
  activity(limit: number): Promise<unknown[]>;
  docs: PolicyDocs;
  drafts: DraftService;
  now(): Date;
};

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

  app.get("/v1/docs", async (c) => c.json(z.array(PolicyDoc).parse(await port.docs.list())));
  app.get("/v1/docs/:path{.+}", async (c) => {
    const doc = await port.docs.get(c.req.param("path"));
    return doc ? c.json(PolicyDoc.parse(doc)) : c.json({ error: "not found" }, 404);
  });

  const body = async <T extends z.ZodTypeAny>(c: { req: { json(): Promise<unknown> } }, schema: T): Promise<z.infer<T>> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new DraftError(400, "invalid request body");
    return parsed.data;
  };
  const out = (draft: unknown) => Draft.parse(draft);

  app.post("/v1/drafts", async (c) => {
    const { path } = await body(c, z.object({ path: z.string().min(1).max(200) }));
    return c.json(out(await port.drafts.create(path, c.get("principal"))), 201);
  });
  app.get("/v1/drafts", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !["open", "published", "discarded"].includes(status)) throw new BadQuery("unknown status");
    return c.json(z.array(Draft).parse(await port.drafts.list(status as Draft["status"] | undefined)));
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

  return app;
}
