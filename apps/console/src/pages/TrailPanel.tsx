import { useRef, useState } from "react";
import type { Trail } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { useTrail } from "../app/useTrail.ts";
import { useTrailSession } from "../app/trailSession.ts";
import type { InboxEntry, TrailAction, Verdict } from "../api.ts";
import { Badge, Button, Card, Hash, Skeleton } from "../kit.ts";
import { CheckpointCard, staleness } from "../components/CheckpointCard.tsx";
import { Load } from "../components/Load.tsx";
import { ReviewEvidence } from "../components/ReviewEvidence.tsx";
import { TutorPanel } from "../components/TutorPanel.tsx";
import { RunList } from "../components/RunList.tsx";
import { SpendRequestCard } from "../components/SpendRequestCard.tsx";
import { TrailActions } from "../components/TrailActions.tsx";
import { TrailHeader } from "../components/TrailHeader.tsx";
import { TrailTimeline } from "../components/TrailTimeline.tsx";
import { TrailDiscussion } from "../components/TrailDiscussion.tsx";
import { describeError } from "../lib/errors.ts";
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
  principal,
  onChanged,
}: {
  trailId: string;
  items: InboxEntry[];
  canAct?: boolean;
  principal?: string;
  onChanged?: () => void;
}) {
  const api = useApi();
  const { state, reload, status } = useTrail(api, trailId, { onChanged });
  const { draft, pending, session } = useTrailSession(api, principal, trailId);
  const [reconcileError, setReconcileError] = useState<unknown>(null);
  const [reviewVersion, setReviewVersion] = useState(0);
  const runs = useAsync(() => api.runs({ trail: trailId }), `trail-runs:${trailId}`);
  const latest = items.filter((i) => i.trailId === trailId);
  const basis = useRef({ trailId, api, principal, items: latest });
  if (basis.current.trailId !== trailId || basis.current.api !== api || basis.current.principal !== principal) {
    basis.current = { trailId, api, principal, items: latest };
  }
  // New checkpoints can arrive, but a changed binding requires an explicit review reload.
  for (const item of latest) {
    if (!basis.current.items.some((old) => old.kind === item.kind && old.checkpoint === item.checkpoint)) {
      basis.current.items = [...basis.current.items, item];
    }
  }
  const mine = basis.current.items;

  const changed = () => {
    reload();
    onChanged?.();
  };
  const reviewAgain = () => {
    basis.current = { trailId, api, principal, items: latest };
    setReviewVersion((version) => version + 1);
    changed();
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
    if (!canAct || !principal || status !== "live" || pending) throw new Error("Wait for the current change and shared connection.");
    try {
      if (action === "comment" || action === "claim" || action === "release") await session.act(action, input);
      else await api.trailAction(trailId, action, input, newOp());
    } finally { changed(); }
  };
  const reconcile = async () => {
    setReconcileError(null);
    try { await session.reconcile(); changed(); }
    catch (error) { setReconcileError(error); }
  };
  const retrySaved = async () => {
    setReconcileError(null);
    try { await session.retry(); }
    catch (error) { setReconcileError(error); }
    finally { changed(); }
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
          const held = trail.state === "handed_off" || trail.owner?.kind === "human";
          const decisionReason = !canAct ? undefined : held ? "Release the claimed review before making a decision."
            : pending ? "Resolve the pending change before deciding." : status !== "live" ? "Reconnect to review the latest state." : undefined;
          const mayDecide = canAct && !held && !pending && status === "live";
          return (
            <>
              <TrailHeader trail={trail} />
              <TutorPanel trail={trail} events={events} canSpend={canAct} />
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
                        key={`${cp}:${reviewVersion}`}
                        checkpoint={cp}
                        item={item}
                        decision={trail.checkpoints[cp]}
                        stale={item ? staleness(item.bound, { ...trail, proofDigest }) : null}
                        canDecide={mayDecide}
                        unavailableReason={decisionReason}
                        onDecide={decide(cp)}
                        onReload={reviewAgain}
                      />
                    );
                  })}
                </div>
                {trail.pendingSpend && mine.some((i) => i.kind === "spend") && (
                  <SpendRequestCard
                    purpose={trail.pendingSpend.purpose}
                    microusd={trail.pendingSpend.microusd}
                    canDecide={mayDecide}
                    unavailableReason={decisionReason}
                    onDecide={decide("spend")}
                  />
                )}
              </section>
              <EvidenceLinks trail={trail} evidence={evidence} landing={landing} />
              <TrailActions
                principal={principal}
                owner={trail.owner}
                ownerUnknown={trail.state === "handed_off" && trail.owner?.kind !== "human"}
                canClaim={["hypothesised", "planned", "ready"].includes(trail.state)}
                parked={trail.state === "parked"}
                canAct={canAct}
                blocked={!!pending || status !== "live"}
                onAct={act}
              />
              <TrailDiscussion
                events={events} principal={principal} draft={draft} onDraftChange={session.setDraft}
                onComment={(text) => act("comment", { text })} canComment={canAct && !!principal}
                status={status} busy={pending?.phase === "sending"} unconfirmed={!!pending && pending.phase !== "sending"}
                onReconcile={reconcile}
              />
              {pending?.phase === "not_found" && (
                <div role="status" className="stack">
                  <p>The server has not recorded this change. You can retry the saved change with the same operation key.</p>
                  <Button onClick={() => void retrySaved()} disabled={status !== "live" || !canAct}>Retry saved change</Button>
                </div>
              )}
              {reconcileError ? <p role="alert">{describeError(reconcileError).body}</p> : null}
              {status !== "live" && <Button onClick={reload}>Reconnect shared updates</Button>}
              <section className="stack" aria-label="Agent runs">
                <h2>Agent runs</h2>
                <Load state={runs.state} retry={runs.reload} skeleton={<Skeleton lines={2} />}>
                  {(list) => <RunList runs={list} empty="No agent runs on this quest yet." />}
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
