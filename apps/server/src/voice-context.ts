import type { VoiceContext } from "@ephyra/core";
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
        return { label: `${detail.trail.short}: ${detail.trail.title}`, data: detail };
      }
      case "run": {
        const run = await console.runs.get(context.id);
        if (!run) throw new VoiceError(404, "This run is no longer available.");
        return { label: `Run ${run.id}`, data: { run, events: await console.runs.events(run.id, undefined, 80), eventLimit: 80 } };
      }
      case "draft": {
        const draft = await console.drafts.get(context.id);
        return { label: draft.path, data: console.drafts.view(draft) };
      }
      case "usage": {
        const to = console.now();
        const trails = await console.trails();
        const summary = summarizeUsage(await console.usage.list(), { from: new Date(to.getTime() - 7 * DAY_MS), to },
          new Map(trails.map(t => [t.id, { id: t.id, short: t.short, title: t.title, budget: t.budget }])));
        return { label: "Usage, last 7 days", data: summary };
      }
      case "overview": return { label: "Application overview", data: {
        inbox: await port.inbox(), recentActivity: await console.activity(30), documents: (await console.docs.list()).map(d => ({ path: d.path, kind: d.kind })),
      } };
    }
  };
}
