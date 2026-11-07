import type { ProofBundle } from "@ephyra/core";
import { Badge, Card, Hash } from "../kit.ts";
import type { TrailDetail } from "../api.ts";

export function ReviewEvidence({
  artefacts,
  proof,
}: {
  artefacts?: TrailDetail["artefacts"];
  proof?: ProofBundle;
}) {
  return (
    <section className="stack" aria-label="Review evidence">
      {(artefacts ?? []).map((a) => (
        <Card key={a.path} tone="quiet" title={a.path}>
          {a.content === null ? (
            <p className="muted">
              No document is available for this revision. Reload after the journal catches up.
            </p>
          ) : (
            <pre className="review-document">{a.content}</pre>
          )}
        </Card>
      ))}
      {proof && (
        <Card
          tone="quiet"
          title="Recorded proof"
          meta={<Badge tone={proof.passed ? "ok" : "bad"}>{proof.passed ? "Passed" : "Failed"}</Badge>}
        >
          <p>
            Revision {proof.rev} · <Hash value={proof.head} /> · {proof.env.runner}
          </p>
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
