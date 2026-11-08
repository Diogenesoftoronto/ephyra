import { z } from "zod";
import { TrailDetailSchema, type TrailDetail } from "../api.ts";

export const WALKTHROUGH_STEPS = ["triaged", "hypothesis", "explain", "revise", "plan", "proof", "watching", "set", "rollback"] as const;
export type WalkthroughStep = (typeof WALKTHROUGH_STEPS)[number];
export type WalkthroughSelection = { step: WalkthroughStep; detail: TrailDetail; key: string };
const Message = z.object({
  type: z.literal("ephyra.walkthrough.select"), step: z.enum(WALKTHROUGH_STEPS),
  detail: TrailDetailSchema.extend({
    events: TrailDetailSchema.shape.events.max(250),
    artefacts: z.array(z.object({ path: z.string().min(1).max(500), content: z.string().max(30_000).nullable() }).strict()).max(30).optional(),
  }).strict(),
}).strict();

export function walkthroughRequested(search: string): boolean {
  const parameters = new URLSearchParams(search);
  return parameters.get("demo") === "1" && parameters.get("walkthrough") === "1";
}

/** Parent selection is explicit and bounded. Invalid embed URLs never fall through to a live account connection. */
export function walkthroughParentOrigin(search: string): string | null {
  if (!walkthroughRequested(search)) return null;
  const raw = new URLSearchParams(search).get("parentOrigin");
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return raw === url.origin && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && loopback)
      ? url.origin : null;
  } catch { return null; }
}

export function readWalkthroughSelection(
  event: { source: unknown; origin: string; data: unknown }, expectedOrigin: string, parent: unknown,
): WalkthroughSelection | null {
  if (event.source !== parent || event.origin !== expectedOrigin) return null;
  try {
    const encoded = JSON.stringify(event.data);
    if (typeof encoded !== "string" || new TextEncoder().encode(encoded).length > 250_000) return null;
    const parsed = Message.safeParse(event.data);
    if (!parsed.success) return null;
    const { step, detail } = parsed.data;
    if (detail.events.some(item => item.trail !== detail.trail.id || item.rev > detail.trail.rev)) return null;
    return { step, detail, key: JSON.stringify([step, detail]) };
  } catch { return null; }
}

/** Embedded demo links can move around the actual console, but cannot sign in or navigate to a live destination. */
export function walkthroughNavigationAllowed(href: string, currentHref: string): boolean {
  try {
    const current = new URL(currentHref);
    const target = new URL(href, current);
    return target.origin === current.origin && target.pathname === current.pathname && target.search === current.search;
  } catch { return false; }
}
