// Humans at the checkpoints: inbox items, decisions bound to a revision, actions, and the audit trail.
import type { Decision, InboxItem, Trail, TrailEvent } from "@ephyra/core";
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { InvalidTransition, StaleApproval, type DecisionInput, type HttpPort } from "../http/app.ts";
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
    reply_comment: async (_effect, trail) => {
      ctx.log("trail comment recorded", { trail: trail.short });
    },
  };
}

const ACTIONS = ["comment", "claim", "release", "park", "resume", "kill", "land"] as const;

/** UUIDv8 namespace for a collaboration intent, independent of delivery time and later trail state. */
export function collaborationEventId(trail: string, principal: string, action: string, key: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['ephyra:collaboration:v1', trail, principal, action, key])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

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
      const projected = await ctx.trails.get(id) ?? (await ctx.trails.list()).find((t) => t.short === id) ?? null;
      const durableId = projected?.id ?? (z.uuid().safeParse(id).success ? id : null);
      const durable = durableId ? await ctx.journal.read(durableId) : null;
      const trail = durable?.trail ?? projected;
      if (!trail) return null;
      const events = durable?.events ?? await ctx.trails.events(trail.id);
      // Only journal-owned review documents. Never accept arbitrary application paths from the browser.
      const paths = ["hypothesis.md", "plan.md", "evidence/index.json", "decisions/latest-A.json", "decisions/latest-B.json", "decisions/latest-C.json"];
      const before = await ctx.journal.read(trail.id);
      const artefacts = await Promise.all(paths.map(async (path) => {
        const bytes = before?.trail.rev === trail.rev ? await ctx.journal.readFile(trail.id, path) : null;
        return { path, content: bytes && bytes.length <= 500_000 ? new TextDecoder().decode(bytes) : null };
      }));
      const after = await ctx.journal.read(trail.id);
      // A moved journal cannot supply the text for the reviewed revision. The caller can reload.
      if (before?.head !== after?.head) for (const a of artefacts) a.content = null;
      return { trail, events, artefacts: artefacts.filter((a) => a.path === "hypothesis.md" || a.path === "plan.md" || a.content !== null) };
    },
    async operationStatus(id, action, key, principal) {
      if (!z.uuid().safeParse(id).success) return null;
      const durable = await ctx.journal.read(id);
      if (!durable) return null;
      const eventId = collaborationEventId(id, principal, action, key);
      return { status: durable.events.some((event) => event.id === eventId) ? 'recorded' : 'not_found' };
    },
    // The route has already checked `path` with isReadableFile; unknown trails read as missing.
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
      if (input.bound && (input.bound.rev !== bound.rev || input.bound.head !== bound.head
        || input.bound.proofDigest !== bound.proofDigest)) {
        throw new StaleApproval("the reviewed item was replaced; reload before deciding");
      }
      const decision: Decision = {
        by: "human", who: principal, at: new Date().toISOString(), verdict: input.verdict,
        ...(input.note ? { note: input.note } : {}),
      };
      await record(principal, input.checkpoint === "spend" ? "spend.decide.requested" : "checkpoint.decide.requested", id,
        { checkpoint: input.checkpoint, verdict: input.verdict, bound });
      if (input.checkpoint === "spend") {
        await ctx.emit({ trail: id, actor: human(principal), type: "spend_decided", data: { decision }, expectedBound: bound });
      } else {
        await ctx.emit({ trail: id, actor: human(principal), type: "checkpoint_decided",
          data: { checkpoint: input.checkpoint, decision }, expectedBound: bound });
      }
      await ctx.inbox.remove(itemId);
    },
    async action(id: string, action: string, input: unknown, principal: string, operationKey?: string) {
      if (!(ACTIONS as readonly string[]).includes(action)) throw new Error(`unknown action ${action}`);
      const body = (input ?? {}) as { text?: string; reason?: string };
      if (action === 'comment' && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000)) {
        throw new InvalidTransition('Comment must contain 1 to 4000 characters');
      }
      // The audit records a request attempt. Only the journal event is evidence that a change was applied.
      await record(principal, `trail.${action}.requested`, id, action === 'comment' ? { characters: body.text!.length } : body);
      const actor = human(principal);
      const keyed = operationKey ? { eventId: collaborationEventId(id, principal, action, operationKey) } : {};
      switch (action as (typeof ACTIONS)[number]) {
        case "comment":
          return ctx.emit({ trail: id, actor, type: "human_comment", ...keyed, data: { text: body.text!, isRequest: false } });
        case "claim": return ctx.emit({ trail: id, actor, type: "claimed_by_human", ...keyed, data: {} });
        case "release": return ctx.emit({ trail: id, actor, type: "released_by_human", ...keyed, data: {} });
        case "park": return ctx.emit({ trail: id, actor, type: "parked", data: { reason: String(body.reason ?? "parked by a human") } });
        case "resume": return ctx.emit({ trail: id, actor, type: "resumed", data: {} });
        case "kill": return ctx.emit({ trail: id, actor, type: "killed", data: { reason: String(body.reason ?? "killed by a human") } });
        case "land": return ctx.emit({ trail: id, actor, type: "land_requested", data: {} });
      }
    },
  };
}
