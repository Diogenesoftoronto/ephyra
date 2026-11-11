import { InvestigationQuestion, type ProofBundle } from "@ephyra/core";
import { Badge, Card, Hash } from "../kit.ts";
import type { TrailDetail } from "../api.ts";
import { ReadAloudButton } from "../voice/Voice.tsx";
import { Referable } from "../velum/VelumProvider.tsx";
import type { ReactNode } from "react";
import { QuestionRecord } from "./InvestigationQuestions.tsx";

/** A quest document Velum can be referred to, bound to the revision under review. Unavailable documents are not referable. */
function ArtefactFrame({ trail, path, available, children }: { trail?: { id: string; rev: number }; path: string; available: boolean; children: ReactNode }) {
  if (!trail || !available) return <>{children}</>;
  return (
    <Referable id={`evidence:${trail.id}:${path}`} refData={{ kind: "evidence", trailId: trail.id, rev: trail.rev, path }}
      label={`${path} (revision ${trail.rev})`} href={`#/inbox/${trail.id}`}>
      {children}
    </Referable>
  );
}

function RecordedQuestion({ content }: { content: string | null }) {
  let value: unknown;
  try { value = content ? JSON.parse(content) : null; } catch { value = null; }
  const parsed = InvestigationQuestion.safeParse(value);
  return <details className="review-proof-item"><summary>Investigation question and checks</summary>
    {parsed.success ? <QuestionRecord question={parsed.data} /> : <pre className="review-document">{content ?? "No question record available."}</pre>}
  </details>;
}

export function ReviewEvidence({
  artefacts,
  proof,
  trail,
}: {
  artefacts?: TrailDetail["artefacts"];
  proof?: ProofBundle;
  /** With the quest id and revision, each document can be referred to Velum at that revision. */
  trail?: { id: string; rev: number };
}) {
  return (
    <section className="stack" aria-label="Review evidence">
      {(artefacts ?? []).map((a) => a.path === "questions/latest.json" ? <RecordedQuestion key={a.path} content={a.content} />
        : a.path.startsWith("decisions/") || a.path === "evidence/index.json" ? (
        <details key={a.path} className="review-proof-item">
          <summary>
            {a.path === "evidence/index.json" ? "Research source coverage"
              : `Machine checkpoint ${a.path.match(/latest-([ABC])/)?.[1] ?? "decision"}`}
          </summary>
          <pre className="review-document">{a.content}</pre>
        </details>
      ) : (
        <ArtefactFrame key={a.path} trail={trail} path={a.path} available={a.content !== null}>
        <Card tone="quiet" title={a.path} meta={a.content ? <ReadAloudButton text={a.content} label={a.path} /> : undefined}>
          {a.content === null ? (
            <p className="muted">
              No document is available for this revision. Reload after the journal catches up.
            </p>
          ) : (
            <pre className="review-document">{a.content}</pre>
          )}
        </Card>
        </ArtefactFrame>
      ))}
      {proof && (
        <Card
          tone="quiet"
          title="Recorded proof"
          meta={<Badge tone={proof.awaitingHumanC ? "warn" : proof.passed ? "ok" : "bad"}>
            {proof.awaitingHumanC ? "Awaiting human approval" : proof.passed ? "Passed" : "Failed"}</Badge>}
        >
          <p>
            Revision {proof.rev} · <Hash value={proof.head} /> · {proof.env.runner}
          </p>
          {proof.awaitingHumanC && <p>Automated checks passed. A named human must review and approve checkpoint C.</p>}
          <ReadAloudButton label="recorded proof summary" text={`Recorded proof for revision ${proof.rev}. Result: ${proof.passed ? "passed" : "failed"}. ` +
            (proof.missing.length ? `Missing: ${proof.missing.join(", ")}. ` : "") + proof.items.map(item => item.kind === "tests"
              ? `Tests: ${item.passed} passed, ${item.failed} failed, ${item.newFailures} new failures.`
              : `${item.kind.replace(/_/g, " ")}${"result" in item ? `: ${item.result}` : " recorded"}.`).join(" ")} />
          {proof.missing.length > 0 && <p role="alert">Missing: {proof.missing.join(", ")}</p>}
          {proof.items.map((item, i) => (
            <details key={i} className="review-proof-item">
              <summary>
                {item.kind.replace(/_/g, " ")}
                {"result" in item ? `: ${item.result}` : ""}
                {item.kind === "tests"
                  ? `: ${item.passed} passed, ${item.failed} failed, ${item.newFailures} new failures`
                  : ""}
              </summary>
              <pre className="review-document">
                {"log" in item ? item.log : JSON.stringify(item, null, 2)}
              </pre>
            </details>
          ))}
        </Card>
      )}
    </section>
  );
}
