import type { ProofBundle } from "@ephyra/core";
import { Badge, Card, Hash } from "../kit.ts";
import type { TrailDetail } from "../api.ts";
import { ReadAloudButton } from "../voice/Voice.tsx";

export function ReviewEvidence({
  artefacts,
  proof,
}: {
  artefacts?: TrailDetail["artefacts"];
  proof?: ProofBundle;
}) {
  return (
    <section className="stack" aria-label="Review evidence">
      {(artefacts ?? []).map((a) => a.path.startsWith("decisions/") || a.path === "evidence/index.json" ? (
        <details key={a.path} className="review-proof-item">
          <summary>
            {a.path === "evidence/index.json" ? "Research source coverage"
              : `Machine checkpoint ${a.path.match(/latest-([ABC])/)?.[1] ?? "decision"}`}
          </summary>
          <pre className="review-document">{a.content}</pre>
        </details>
      ) : (
        <Card key={a.path} tone="quiet" title={a.path} meta={a.content ? <ReadAloudButton text={a.content} label={a.path} /> : undefined}>
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
