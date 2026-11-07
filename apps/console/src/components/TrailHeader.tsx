import type { Trail } from "@ephyra/core";
import { Badge, Card, Hash, Meter, Tag } from "../kit.ts";
import { formatMicrousd, formatTokens } from "../lib/format.ts";
import "./TrailHeader.css";

const RISK = { critical: "bad", high: "warn", medium: "info", low: "neutral" } as const;

export function TrailHeader({ trail }: { trail: Trail }) {
  const b = trail.budget;
  return (
    <Card>
      <div className="trail-head">
        <div className="trail-head-top">
          <span className="mono">{trail.short}</span>
          <Badge tone={trail.state === "parked" ? "warn" : trail.state === "closed" ? "ok" : "info"}>{trail.state.replace(/_/g, " ")}</Badge>
          <Badge tone={RISK[trail.risk]}>{trail.risk} risk</Badge>
          <Tag>{trail.area}</Tag>
          {trail.owner && <Badge tone={trail.owner.kind === "human" ? "live" : "neutral"}>{trail.owner.kind === "human" ? "claimed by a person" : `agent ${trail.owner.id}`}</Badge>}
        </div>
        <h2 className="trail-head-title">{trail.title}</h2>
        <dl className="trail-head-facts">
          <div><dt>Revision</dt><dd className="num">{trail.rev}</dd></div>
          <div><dt>Head</dt><dd>{trail.head ? <Hash value={trail.head} chars={10} /> : <span className="muted">none yet</span>}</dd></div>
          <div><dt>Base</dt><dd><Hash value={trail.base.sha} chars={10} /></dd></div>
          <div><dt>Repository</dt><dd className="mono">{trail.repo}</dd></div>
        </dl>
        <div className="trail-head-budget">
          <div><span className="muted">Spend {formatMicrousd(b.spendMicrousdUsed)} of {formatMicrousd(b.spendMicrousdMax)}</span>
            <Meter label="Spend against budget" used={b.spendMicrousdUsed} max={b.spendMicrousdMax} /></div>
          <div><span className="muted">Tokens {formatTokens(b.tokensUsed)} of {formatTokens(b.tokensMax)}</span>
            <Meter label="Tokens against budget" used={b.tokensUsed} max={b.tokensMax} /></div>
        </div>
      </div>
    </Card>
  );
}
