import type { Trail } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import type { InboxEntry, TrailAction, Verdict } from "../api.ts";
import { Badge, Card, Hash, Skeleton } from "../kit.ts";
import { CheckpointCard, staleness } from "../components/CheckpointCard.tsx";
import { Load } from "../components/Load.tsx";
import { ReviewEvidence } from "../components/ReviewEvidence.tsx";
import { RunList } from "../components/RunList.tsx";
import { SpendRequestCard } from "../components/SpendRequestCard.tsx";
import { TrailActions } from "../components/TrailActions.tsx";
import { TrailHeader } from "../components/TrailHeader.tsx";
import { TrailTimeline } from "../components/TrailTimeline.tsx";
import { newOp } from "../lib/hooks.ts";
import { safeHref } from "../lib/format.ts";
import "./TrailPanel.css";

/**
 * One trail: where it stands, the three checkpoints bound to the revision, head and proof digest they were made for, a
 * spend request when one is open, what a person can do, the agent runs and the timeline.
 */
export function TrailPanel({
  trailId,
  items,
  canAct = true,
  onChanged,
}: {
  trailId: string;
  items: InboxEntry[];
  canAct?: boolean;
  onChanged?: () => void;
}) {
  const api = useApi();
  const { state, reload } = useAsync(() => api.trail(trailId), `trail:${trailId}`);
  const runs = useAsync(() => api.runs({ trail: trailId }), `trail-runs:${trailId}`);
  const mine = items.filter((i) => i.trailId === trailId);

  const changed = () => {
    reload();
    onChanged?.();
  };
  const decide = (checkpoint: "A" | "B" | "C" | "spend") => async (verdict: Verdict, note: string) => {
    await api.decide(
      trailId,
      {
        checkpoint,
        verdict,
        bound: mine.find((i) => (checkpoint === "spend" ? i.kind === "spend" : i.checkpoint === checkpoint))
          ?.bound,
        ...(note ? { note } : {}),
      },
      newOp(),
    );
    changed();
  };
  const act = async (action: TrailAction, input: { text?: string; reason?: string }) => {
    await api.trailAction(trailId, action, input, newOp());
    changed();
  };

  return (
    <div className="trail-panel stack">
      <Load state={state} retry={reload} skeleton={<Skeleton block />}>
        {({ trail, events, artefacts }) => {
          const proof = [...events]
            .reverse()
            .find((e) => e.type === "proof_completed" && e.data.bundle.rev === trail.rev);
          const proofDigest = proof?.type === "proof_completed" ? proof.data.digest : undefined;
          const evidence = mine.find((i) => i.evidenceIndex)?.evidenceIndex;
          const landing = safeHref(mine.find((i) => i.landingUrl)?.landingUrl);
          return (
            <>
              <TrailHeader trail={trail} />
              <ReviewEvidence
                artefacts={artefacts}
                proof={proof?.type === "proof_completed" ? proof.data.bundle : undefined}
              />
              <section className="stack" aria-label="Checkpoints">
                <h2>Checkpoints</h2>
                <div className="trail-checkpoints">
                  {(["A", "B", "C"] as const).map((cp) => {
                    const item = mine.find((i) => i.kind === "checkpoint" && i.checkpoint === cp);
                    return (
                      <CheckpointCard
                        key={cp}
                        checkpoint={cp}
                        item={item}
                        decision={trail.checkpoints[cp]}
                        stale={item ? staleness(item.bound, { ...trail, proofDigest }) : null}
                        canDecide={canAct}
                        onDecide={decide(cp)}
                        onReload={changed}
                      />
                    );
                  })}
                </div>
                {trail.pendingSpend && mine.some((i) => i.kind === "spend") && (
                  <SpendRequestCard
                    purpose={trail.pendingSpend.purpose}
                    microusd={trail.pendingSpend.microusd}
                    canDecide={canAct}
                    onDecide={decide("spend")}
                  />
                )}
              </section>
              <EvidenceLinks trail={trail} evidence={evidence} landing={landing} />
              <TrailActions
                owned={trail.owner?.kind === "human"}
                parked={trail.state === "parked"}
                canAct={canAct}
                onAct={act}
              />
              <section className="stack" aria-label="Agent runs">
                <h2>Agent runs</h2>
                <Load state={runs.state} retry={runs.reload} skeleton={<Skeleton lines={2} />}>
                  {(list) => <RunList runs={list} empty="No agent runs on this trail yet." />}
                </Load>
              </section>
              <section className="stack" aria-label="Timeline">
                <h2>Timeline</h2>
                <TrailTimeline events={events} />
              </section>
            </>
          );
        }}
      </Load>
    </div>
  );
}

function EvidenceLinks({ trail, evidence, landing }: { trail: Trail; evidence?: string; landing?: string }) {
  if (!evidence && !landing && !trail.head) return null;
  return (
    <Card title="Evidence" tone="quiet">
      <ul className="trail-evidence">
        {evidence && (
          <li>
            <Badge>index</Badge> <span className="mono">{evidence}</span>
          </li>
        )}
        {landing && (
          <li>
            <Badge tone="info">landing</Badge>{" "}
            <a href={landing} target="_blank" rel="noopener noreferrer">
              {landing}
            </a>
          </li>
        )}
        {trail.head && (
          <li>
            <Badge>head</Badge> <Hash value={trail.head} chars={12} />
          </li>
        )}
      </ul>
    </Card>
  );
}
