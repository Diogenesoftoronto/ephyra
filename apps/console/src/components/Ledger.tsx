import type { UsageEntry } from "@ephyra/core";
import { Badge, Button, Empty, Tag } from "../kit.ts";
import { DataTable } from "./DataTable.tsx";
import { clockTime, formatDuration, formatTokens } from "../lib/format.ts";
import { Cost } from "./Cost.tsx";
import { PersonaLabel } from "./PersonaLabel.tsx";
import "./Ledger.css";

export type LedgerFilterValue = {
  persona: string;
  engine: string;
  trail: string;
  outcome: "all" | "ok" | "failed" | "unavailable" | "unknown-cost";
};
export const noFilters: LedgerFilterValue = { persona: "", engine: "", trail: "", outcome: "all" };

export const matchesOutcome = (e: UsageEntry, outcome: LedgerFilterValue["outcome"]): boolean =>
  outcome === "all" ? true : outcome === "unknown-cost" ? e.costMicrousd === null : e.outcome === outcome;

/** One row per unit of work. Unknown cost reads "unknown"; failed and unavailable rows keep their reason on screen. */
export function Ledger({
  entries,
  hasMore,
  loadingMore,
  onMore,
}: {
  entries: UsageEntry[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
}) {
  if (entries.length === 0)
    return (
      <Empty
        title={hasMore ? "No matches in the loaded entries" : "No entries match"}
        body={
          hasMore
            ? "Load more to check older work with these filters."
            : "Widen the window or clear a filter."
        }
        action={
          hasMore ? (
            <Button onClick={onMore} loading={loadingMore}>
              Show more
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <div className="ledger">
      <DataTable label="Usage ledger">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Step</th>
            <th>Engine</th>
            <th>Quest</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th>Time</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} data-outcome={e.outcome}>
              <td className="num">
                <time dateTime={e.at}>
                  {e.at.slice(5, 10)} {clockTime(e.at)}
                </time>
              </td>
              <td>
                <PersonaLabel persona={e.persona} />
              </td>
              <td>{e.step}</td>
              <td>
                <Tag>{e.engine}</Tag>
              </td>
              <td>
                {e.trailId ? (
                  <a className="mono" href={`#/inbox/${e.trailId}`}>
                    {e.short}
                  </a>
                ) : (
                  <span className="muted">none</span>
                )}
              </td>
              <td className="num">{formatTokens(e.tokens)}</td>
              <td>
                <Cost micro={e.costMicrousd} />
              </td>
              <td className="num">{formatDuration(e.wallMs)}</td>
              <td>
                {e.outcome === "ok" ? (
                  <Badge tone="ok">ok</Badge>
                ) : (
                  <Badge tone={e.outcome === "failed" ? "bad" : "warn"}>{e.outcome}</Badge>
                )}
                {e.note && <p className="ledger-note muted">{e.note}</p>}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {hasMore && (
        <Button onClick={onMore} loading={loadingMore}>
          Show more
        </Button>
      )}
    </div>
  );
}
