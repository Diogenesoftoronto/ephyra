import { referenceKey, type VelumReference, type VelumResolvedReference, type VoiceContext } from "@ephyra/core";
import type { ConsolePort } from "./http/console.ts";
import type { HttpPort } from "./http/app.ts";
import { DAY_MS, summarizeUsage } from "./usage.ts";
import { VoiceError } from "./voice-provider.ts";
import type { VoiceSnapshot } from "./voice.ts";

/** Reads the selected resource on the server. A client cannot supply fabricated proof as the current application's state. */
export function voiceContext(console: ConsolePort, port: HttpPort) {
  return async (context: VoiceContext): Promise<VoiceSnapshot> => {
    switch (context.kind) {
      case "trail": {
        const detail = await port.trail(context.id);
        if (!detail) throw new VoiceError(404, "This trail is no longer available.");
        return { label: `${detail.trail.short}, revision ${detail.trail.rev}: ${detail.trail.title}`, data: detail };
      }
      case "run": {
        const run = await console.runs.get(context.id);
        if (!run) throw new VoiceError(404, "This run is no longer available.");
        return {
          label: `Run ${run.id}`,
          data: { run, events: await console.runs.events(run.id, undefined, 80), eventLimit: 80 },
        };
      }
      case "draft": {
        const draft = await console.drafts.get(context.id);
        return { label: draft.path, data: console.drafts.view(draft) };
      }
      case "usage": {
        const to = console.now();
        const trails = await console.trails();
        const summary = summarizeUsage(
          await console.usage.list(),
          { from: new Date(to.getTime() - 7 * DAY_MS), to },
          new Map(trails.map((t) => [t.id, { id: t.id, short: t.short, title: t.title, budget: t.budget }])),
        );
        return { label: "Usage, last 7 days", data: summary };
      }
      case "overview":
        return {
          label: "Application overview",
          data: {
            inbox: await port.inbox(),
            recentActivity: await console.activity(30),
            documents: (await console.docs.list()).map((d) => ({ path: d.path, kind: d.kind })),
          },
        };
    }
  };
}

export type ResolvedReferences = { resolved: VelumResolvedReference[]; data: { key: string; label: string; record: unknown }[] };
const MAX_EVIDENCE_CHARS = 6000;
const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);

/**
 * Reads each reference from the server's own records at the revision or range the person saw. Labels come from the
 * records, never from the client. A changed or missing source is reported, not silently replaced with current data.
 */
export function voiceReferences(console: ConsolePort, port: HttpPort) {
  return async (refs: readonly VelumReference[]): Promise<ResolvedReferences> => {
    const resolved: VelumResolvedReference[] = [];
    const data: ResolvedReferences["data"] = [];
    let autonomy: Awaited<ReturnType<ConsolePort["docs"]["get"]>> | undefined;
    for (const ref of refs) {
      const key = referenceKey(ref);
      switch (ref.kind) {
        case "area": {
          autonomy ??= await console.docs.get("autonomy.md");
          const area = autonomy?.sketches?.find((s) => s.name === ref.name);
          if (!autonomy || !area) { resolved.push({ key, label: `Area ${ref.name}`, status: "missing" }); break; }
          if (autonomy.digest !== ref.revision) { resolved.push({ key, label: `Area ${area.name}`, status: "changed", current: autonomy.digest }); break; }
          resolved.push({ key, label: `Area ${area.name}`, status: "current" });
          data.push({ key, label: `Area ${area.name} (autonomy.md ${autonomy.digest.slice(0, 12)})`, record: area });
          break;
        }
        case "trail": {
          const detail = await port.trail(ref.id);
          if (!detail) { resolved.push({ key, label: "Quest", status: "missing" }); break; }
          const label = `${detail.trail.short}: ${detail.trail.title}`.slice(0, 200);
          if (detail.trail.rev !== ref.rev) { resolved.push({ key, label, status: "changed", current: String(detail.trail.rev) }); break; }
          resolved.push({ key, label, status: "current" });
          data.push({ key, label: `${label} (revision ${detail.trail.rev})`, record: { trail: detail.trail, events: detail.events.slice(-40) } });
          break;
        }
        case "run": {
          const run = await console.runs.get(ref.id);
          if (!run) { resolved.push({ key, label: "Run", status: "missing" }); break; }
          const label = `Run ${run.id.slice(0, 12)}`;
          resolved.push({ key, label, status: "current" });
          data.push({ key, label: `${label} (${run.status})`, record: { run, events: await console.runs.events(run.id, undefined, 40) } });
          break;
        }
        case "usage": {
          const from = dayStart(ref.from);
          const to = new Date(dayStart(ref.to).getTime() + DAY_MS - 1);
          const label = `Usage ${ref.facet}, ${ref.from} to ${ref.to}`;
          if (from > to || to.getTime() - from.getTime() > 92 * DAY_MS) { resolved.push({ key, label, status: "missing" }); break; }
          const trails = await console.trails();
          const summary = summarizeUsage(await console.usage.list(), { from, to },
            new Map(trails.map((t) => [t.id, { id: t.id, short: t.short, title: t.title, budget: t.budget }])));
          const today = console.now().toISOString().slice(0, 10);
          resolved.push({ key, label, status: "current" });
          data.push({ key, label, record: { facet: ref.facet, includesPartialDay: ref.to >= today ? today : null,
            note: "Unknown costs are counted in unknownCost and are not zero.", summary } });
          break;
        }
        case "evidence": {
          const detail = await port.trail(ref.trailId);
          const label = `Evidence ${ref.path}`.slice(0, 200);
          if (!detail) { resolved.push({ key, label, status: "missing" }); break; }
          if (detail.trail.rev !== ref.rev) { resolved.push({ key, label, status: "changed", current: String(detail.trail.rev) }); break; }
          const artefact = detail.artefacts?.find((a) => a.path === ref.path);
          const bytes = artefact ? null : await port.file?.(ref.trailId, ref.path);
          const content = artefact?.content ?? (bytes ? new TextDecoder().decode(bytes) : null);
          if (content === null) { resolved.push({ key, label, status: "missing" }); break; }
          resolved.push({ key, label, status: "current" });
          data.push({ key, label: `${label} at revision ${ref.rev}`, record: { path: ref.path, truncated: content.length > MAX_EVIDENCE_CHARS, content: content.slice(0, MAX_EVIDENCE_CHARS) } });
          break;
        }
      }
    }
    return { resolved, data };
  };
}
