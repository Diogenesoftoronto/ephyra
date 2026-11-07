// Humans at the checkpoints: inbox items, decisions bound to a revision, actions, and the audit trail.
import type { Decision, InboxItem, Trail, TrailEvent } from "@ephyra/core";
import { StaleApproval, type DecisionInput, type HttpPort } from "../http/app.ts";
import type { AuditEvent, AuditInput } from "../audit.ts";
import type { HandlerSlice, ServerContext } from "./context.ts";

export type AuditSink = { append(input: AuditInput): Promise<AuditEvent> };

const ARTEFACT: Record<"A" | "B" | "C", { path: string; summary: string }> = {
  A: { path: "hypothesis.md", summary: "Hypothesis: is this the right cause to chase?" },
  B: { path: "plan.md", summary: "Plan: reproduced; approve the fix approach" },
  C: { path: "proof/manifest.json", summary: "Proof passed: approve landing" },
};

/** Digest of the latest proof for the trail's current revision (part of an approval's bound revision). */
export function latestProofDigest(trail: Trail, events: TrailEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "proof_completed" && e.data.bundle.rev === trail.rev) return e.data.digest;
  }
  return undefined;
}

function itemFor(trail: Trail, kind: InboxItem["kind"], extra: Partial<InboxItem> & { proofDigest?: string }): InboxItem {
  const { proofDigest, ...rest } = extra;
  const ampThread = trail.mirrors.ampThread;
  return {
    // `o` in the inbox opens the trail's Amp thread when it has one.
    ...(ampThread ? { landingUrl: `https://ampcode.com/threads/${ampThread}` } : {}),
    trailId: trail.id, short: trail.short, title: trail.title, area: trail.area, risk: trail.risk,
    severity: trail.severity, state: trail.state, kind, blocking: true,
    bound: { rev: trail.rev, ...(trail.head ? { head: trail.head } : {}), ...(proofDigest ? { proofDigest } : {}) },
    artefact: { path: "trail.json", summary: trail.title }, createdAt: new Date().toISOString(),
    ...rest,
  };
}

export function humanHandlers(ctx: ServerContext): HandlerSlice {
  return {
    request_checkpoint: async (effect, trail) => {
      const proofDigest = effect.checkpoint === "C" ? latestProofDigest(trail, await ctx.trails.events(trail.id)) : undefined;
      await ctx.inbox.put({
        id: `${trail.id}:${effect.checkpoint}`,
        ...itemFor(trail, "checkpoint", {
          checkpoint: effect.checkpoint, blocking: effect.blocking, artefact: ARTEFACT[effect.checkpoint],
          ...(proofDigest ? { proofDigest } : {}),
        }),
      });
    },
    notify_inbox: async (effect, trail) => {
      await ctx.inbox.put({
        id: `${trail.id}:notice`,
        ...itemFor(trail, trail.state === "parked" ? "parked" : "notice", {
          artefact: { path: "trail.json", summary: effect.reason }, blocking: false,
        }),
      });
    },
    request_spend: async (effect, trail) => {
      await ctx.inbox.put({
        id: `${trail.id}:spend`,
        ...itemFor(trail, "spend", {
          artefact: { path: "trail.json", summary: `${effect.purpose}: up to $${(effect.microusd / 1e6).toFixed(2)}` },
        }),
      });
    },
    reply_comment: async (effect, trail) => {
      ctx.log("trail reply", { trail: trail.short, text: effect.text.slice(0, 200) });
    },
  };
}

const ACTIONS = ["comment", "claim", "release", "park", "resume", "kill", "land"] as const;

/** The HTTP port: reads go to the projection; decisions and actions go through the engine and the audit log. */
export function httpPort(ctx: ServerContext, audit: AuditSink): HttpPort {
  const human = (principal: string) => ({ kind: "human" as const, id: principal });
  const record = (principal: string, action: string, target: string, detail: unknown) =>
    audit.append({ id: ctx.ids.uuidv7(), at: new Date().toISOString(), principal, action, target, detail });

  return {
    async inbox() {
      const items = await ctx.inbox.list();
      const live: InboxItem[] = [];
      for (const item of items) {
        const trail = await ctx.trails.get(item.trailId);
        // Drop items whose trail moved on (terminal, or a notice for a trail no longer parked).
        if (!trail || trail.state === "closed" || trail.state === "abandoned") continue;
        if ((item.kind === "parked" || item.kind === "notice") && trail.state !== "parked") continue;
        if (item.kind === "checkpoint" && item.bound.rev !== trail.rev) continue;
        live.push({ ...item, state: trail.state });
      }
      return live.sort((a, b) => b.severity - a.severity);
    },
    trails: (state) => ctx.trails.list(state ? { states: [state as Trail["state"]] } : undefined),
    async trail(id) {
      const trail = await ctx.trails.get(id) ?? (await ctx.trails.list()).find((t) => t.short === id) ?? null;
      return trail ? { trail, events: await ctx.trails.events(trail.id) } : null;
    },
    // The route has already checked `path` against READABLE_FILE; unknown trails read as missing.
    async file(id, path) {
      const trail = await ctx.trails.get(id);
      return trail ? ctx.journal.readFile(trail.id, path) : null;
    },
    async decide(id: string, input: DecisionInput, principal: string) {
      const trail = await ctx.trails.get(id);
      if (!trail) throw new StaleApproval("trail not found");
      const itemId = input.checkpoint === "spend" ? `${id}:spend` : `${id}:${input.checkpoint}`;
      const item = await ctx.inbox.get(itemId);
      const digest = latestProofDigest(trail, await ctx.trails.events(id));
      const bound = item?.bound;
      if (!bound || bound.rev !== trail.rev || bound.head !== trail.head || bound.proofDigest !== digest) {
        throw new StaleApproval("the trail changed since this item was created");
      }
      const decision: Decision = {
        by: "human", who: principal, at: new Date().toISOString(), verdict: input.verdict,
        ...(input.note ? { note: input.note } : {}),
      };
      await record(principal, input.checkpoint === "spend" ? "spend.decide" : "checkpoint.decide", id,
        { checkpoint: input.checkpoint, verdict: input.verdict, bound });
      if (input.checkpoint === "spend") {
        await ctx.emit({ trail: id, actor: human(principal), type: "spend_decided", data: { decision } });
      } else {
        await ctx.emit({ trail: id, actor: human(principal), type: "checkpoint_decided",
          data: { checkpoint: input.checkpoint, decision } });
      }
      await ctx.inbox.remove(itemId);
    },
    async action(id: string, action: string, input: unknown, principal: string) {
      if (!(ACTIONS as readonly string[]).includes(action)) throw new Error(`unknown action ${action}`);
      const body = (input ?? {}) as { text?: string; reason?: string };
      await record(principal, `trail.${action}`, id, body);
      const actor = human(principal);
      switch (action as (typeof ACTIONS)[number]) {
        case "comment":
          return ctx.emit({ trail: id, actor, type: "human_comment",
            data: { text: String(body.text ?? "").slice(0, 4000), isRequest: false } });
        case "claim": return ctx.emit({ trail: id, actor, type: "claimed_by_human", data: {} });
        case "release": return ctx.emit({ trail: id, actor, type: "released_by_human", data: {} });
        case "park": return ctx.emit({ trail: id, actor, type: "parked", data: { reason: String(body.reason ?? "parked by a human") } });
        case "resume": return ctx.emit({ trail: id, actor, type: "resumed", data: {} });
        case "kill": return ctx.emit({ trail: id, actor, type: "killed", data: { reason: String(body.reason ?? "killed by a human") } });
        case "land": return ctx.emit({ trail: id, actor, type: "land_requested", data: {} });
      }
    },
  };
}
