import type { TrailEvent } from "@ephyra/core";
import { Badge } from "../kit.ts";
import { clockTime, safeHref } from "../lib/format.ts";
import "./TrailTimeline.css";

type Line = { text: string; tone?: "ok" | "warn" | "bad" | "info"; link?: string };

/** One plain sentence per event. Free text from people and agents is shown as text. */
export function describeEvent(e: TrailEvent): Line {
  switch (e.type) {
    case "trail_created":
      return { text: `Quest opened: ${e.data.title}` };
    case "triage_completed":
      return {
        text: `Triaged as ${e.data.result.risk} risk in ${e.data.result.area}, severity ${e.data.result.severity}`,
        tone: "info",
      };
    case "research_completed":
      return { text: "Hypothesis written", link: e.data.hypothesis };
    case "checkpoint_decided":
      return {
        text: `Checkpoint ${e.data.checkpoint}: ${e.data.decision.verdict}${e.data.decision.note ? ` — ${e.data.decision.note}` : ""}`,
        tone:
          e.data.decision.verdict === "approve"
            ? "ok"
            : e.data.decision.verdict === "revise"
              ? "warn"
              : "bad",
      };
    case "repro_completed":
      return {
        text: e.data.ok
          ? "Reproduction written"
          : `Reproduction failed${e.data.reason ? `: ${e.data.reason}` : ""}`,
        tone: e.data.ok ? "ok" : "bad",
      };
    case "plan_completed":
      return { text: "Plan written", link: e.data.plan };
    case "patch_completed":
      return { text: `Patch revision ${e.data.revision} at ${e.data.head.slice(0, 8)}` };
    case "proof_completed":
      return {
        text: e.data.bundle.passed ? "Proof passed" : "Proof did not pass",
        tone: e.data.bundle.passed ? "ok" : "bad",
      };
    case "land_requested":
      return { text: "Landing requested" };
    case "landing_completed":
      return { text: `Landed by ${e.data.receipt.mode}`, tone: "ok" };
    case "landing_failed":
      return { text: `Landing failed: ${e.data.reason}`, tone: "bad" };
    case "watch_started":
      return { text: "Watching production" };
    case "watch_completed":
      return { text: "Watch finished clean", tone: "ok" };
    case "human_comment":
      return { text: `Comment: ${e.data.text}` };
    case "claimed_by_human":
      return { text: "Claimed by a person" };
    case "released_by_human":
      return { text: "Released by a person" };
    case "parked":
      return { text: `Parked: ${e.data.reason}`, tone: "warn" };
    case "resumed":
      return { text: "Resumed" };
    case "killed":
      return { text: `Stopped: ${e.data.reason}`, tone: "bad" };
    case "spend_requested":
      return { text: `Spend requested: ${e.data.purpose}`, tone: "warn" };
    case "agent_failed":
      return { text: `${e.data.step} failed: ${e.data.reason}`, tone: "bad" };
    default:
      return { text: e.type.replace(/_/g, " ") };
  }
}

export function TrailTimeline({ events }: { events: TrailEvent[] }) {
  if (events.length === 0) return <p className="muted">No events yet.</p>;
  return (
    <ol className="timeline" aria-label="Quest timeline">
      {events.map((e) => {
        const line = describeEvent(e);
        const href = safeHref(line.link);
        return (
          <li key={e.id} className="timeline-item">
            <time className="mono muted" dateTime={e.at}>
              {e.at.slice(5, 10)} {clockTime(e.at)}
            </time>
            <span className="timeline-text">
              {line.tone && <Badge tone={line.tone}>{e.type.replace(/_/g, " ")}</Badge>} {line.text}
              {line.link &&
                (href ? (
                  <>
                    {" "}
                    <a href={href}>evidence</a>
                  </>
                ) : (
                  <>
                    {" "}
                    <span className="mono muted">{line.link}</span>
                  </>
                ))}
            </span>
            <span className="muted timeline-actor" style={{ overflowWrap: "anywhere", minWidth: 0, maxWidth: "24ch" }}>{e.actor.id}</span>
          </li>
        );
      })}
    </ol>
  );
}
