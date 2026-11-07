import { Badge, Card } from "../kit.ts";
import type { Verdict } from "../api.ts";
import { describeError } from "../lib/errors.ts";
import { formatMicrousd } from "../lib/format.ts";
import { DecisionForm, useDecision } from "./DecisionForm.tsx";

/** An agent asking to spend money beyond the trail's plan. Nothing is spent until a person approves. */
export function SpendRequestCard({
  purpose,
  microusd,
  canDecide = true,
  onDecide,
}: {
  purpose: string;
  microusd: number;
  canDecide?: boolean;
  onDecide?: (verdict: Verdict, note: string) => Promise<void>;
}) {
  const { busy, error, submit } = useDecision(onDecide);
  const failure = error ? describeError(error) : null;
  return (
    <Card title="Spend request" tone="tray" meta={<Badge tone="warn">blocking</Badge>}>
      <p>
        <strong>{formatMicrousd(microusd)}</strong> for: {purpose}
      </p>
      {failure && (
        <p role="alert">
          <strong>{failure.title}.</strong> {failure.body}
        </p>
      )}
      {!canDecide && <p className="muted">Only approvers can decide.</p>}
      <DecisionForm
        busy={busy}
        disabled={!canDecide || failure?.kind === "stale"}
        approveLabel="Approve spend"
        onSubmit={(v, n) => void submit(v, n)}
      />
    </Card>
  );
}
