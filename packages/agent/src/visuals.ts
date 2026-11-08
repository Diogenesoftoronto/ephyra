import { RunVisual } from "@ephyra/core";
import { redact } from "./redact.ts";
import type { RunEventDraft } from "./run-events.ts";

/** Portable across local CLIs and remote orbs: publication travels through the recorded stream. */
export const VISUAL_GUIDE = [
  "When a visual helps the human inspect your work, share a self-contained interactive HTML page.",
  "Use inline CSS/JS and data-URI images; external requests, forms, popups and host access are unavailable.",
  "Use responsive widths and theme variables --background, --foreground, --card, --border, --accent, --font-sans.",
  "Keep controls keyboard accessible and honor prefers-reduced-motion for animation.",
  "Publish from a successful shell command by printing one line: EPHYRA_VISUAL followed by a space and JSON",
  'with {"id":"stable-short-id","title":"Clear title","html":"<complete HTML>","height":420}.',
  "For a file, use Python: print('EPHYRA_VISUAL '+json.dumps(dict(id='review',title='Review',html=Path('review.html').read_text(),height=420))).",
  "Import json and pathlib.Path first. HTML is limited to 240000 characters; height is 160–1200. Reusing an id publishes a revision.",
  "Alternatively put the same JSON in an ephyra-visual fenced block in your own reply (except JSON-only reviews).",
  "Verify the visual with available browser tools before sharing; say explicitly when it is unverified.",
  "A visual is a presentation, never a passing proof. Never include credentials or private material unrelated to this trail.",
  "For Amp orb apps, use declared services (amp orb services ensure) or amp orb portal for an already-running server.",
  "Report only the actual returned portal URL; do not invent hostnames or claim readiness from a link alone.",
].join("\n");

/** Explicit envelopes only. Logs, quoted user text and failed commands cannot silently publish a page. */
export function visualPublisher(secrets: string[] = []) {
  let savedChars = 0;
  return (text: string, source: "assistant" | "tool"): { text: string; events: RunEventDraft[] } => {
    const events: RunEventDraft[] = [];
    const pattern = source === "tool" ? /^EPHYRA_VISUAL (\{[^\r\n]+\})[ \t]*$/gm
      : /^```ephyra-visual\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
    const rest = text.replace(pattern, (_block, json: string) => {
      let visual: RunVisual | undefined;
      if (json.length <= 256_000 && events.length < 8 && savedChars + json.length <= 2_000_000) {
        try {
          const parsed = RunVisual.parse(JSON.parse(json));
          visual = RunVisual.parse({ ...parsed,
            title: redact(parsed.title, secrets, 160), html: redact(parsed.html, secrets, 240_000) });
          // A secret cannot become an identifier either.
          if (redact(visual.id, secrets) !== visual.id) visual = undefined;
        } catch { /* Invalid or oversized presentations stay unavailable. */ }
      }
      if (visual) {
        savedChars += json.length;
        events.push({ type: "message", text: `Shared visual: ${visual.title}`, visual });
        return `[Shared visual: ${visual.title}]`;
      }
      events.push({ type: "status", text: "A visual was not saved: its format or size exceeded the presentation limits." });
      return "[Visual unavailable]";
    });
    return { text: rest, events };
  };
}
