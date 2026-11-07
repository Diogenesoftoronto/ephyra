import { useState } from "react";
import type { AreaSketch } from "@ephyra/core";
import { Badge, Button, Card } from "../kit.ts";
import { describeError } from "../lib/errors.ts";
import { hasBlocking } from "../lib/warnings.ts";
import { DiffView } from "./DiffView.tsx";
import { MapDiff } from "./MapDiff.tsx";
import { WarningList } from "./WarningList.tsx";
import "./ProposalCard.css";

export type Proposal = {
  summary: string;
  content: string;
  warnings: readonly string[];
  sketches?: readonly AreaSketch[];
};

/**
 * Velum's proposal: what it would change (as a before/after map when it sent one, and always as a text diff), the
 * parser's warnings, and the button that puts it into the draft. A proposal with parser errors cannot be applied.
 */
export function ProposalCard({
  proposal,
  currentContent,
  currentSketches,
  onApply,
  disabled,
}: {
  proposal: Proposal;
  currentContent: string;
  currentSketches?: readonly AreaSketch[];
  onApply?: () => Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const applied = proposal.content === currentContent;
  const blocked = hasBlocking(proposal.warnings);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await onApply?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const failure = error ? describeError(error) : null;
  return (
    <Card title="Proposal" tone="quiet" meta={proposal.summary} className="proposal">
      <div className="proposal-body">
        {proposal.sketches && currentSketches && (
          <MapDiff before={currentSketches} after={proposal.sketches} />
        )}
        <details className="proposal-doc">
          <summary>Document changes</summary>
          <DiffView before={currentContent} after={proposal.content} label="Document changes" />
        </details>
        <WarningList warnings={proposal.warnings} />
        {failure && (
          <p role="alert">
            <strong>{failure.title}.</strong> {failure.body}
          </p>
        )}
        <div className="proposal-actions">
          {applied ? (
            <Badge tone="ok">In the draft</Badge>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={blocked || disabled || !onApply}
              onClick={() => void apply()}
            >
              Use this proposal
            </Button>
          )}
          {blocked && <span className="muted">It has parser errors, so it cannot be applied.</span>}
        </div>
      </div>
    </Card>
  );
}
