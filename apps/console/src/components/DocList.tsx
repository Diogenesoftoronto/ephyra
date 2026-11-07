import type { Draft, PolicyDoc } from "@ephyra/core";
import { Badge, Button, Empty, Table, Tag } from "../kit.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import { hasBlocking } from "../lib/warnings.ts";
import { shortDigest } from "../lib/format.ts";
import "./DocList.css";

/** The policy documents in effect, each with the button that starts a draft of it. */
export function DocList({ docs, onDraft, busyPath, canDraft = true }: {
  docs: PolicyDoc[]; onDraft: (path: string) => void; busyPath?: string | null; canDraft?: boolean;
}) {
  if (docs.length === 0) return <Empty title="No policy documents yet" body="The server serves autonomy.md, thresholds.yaml and intents/*.md once they exist." />;
  return (
    <Table label="Policy documents">
      <thead><tr><th>Document</th><th>Kind</th><th>Parser</th><th>Version</th><th><span className="sr-only">Action</span></th></tr></thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.path}>
            <td className="mono">{d.path}</td>
            <td><Tag>{d.kind}</Tag></td>
            <td>{d.warnings.length === 0 ? <Badge tone="ok">clean</Badge> : <Badge tone={hasBlocking(d.warnings) ? "bad" : "warn"}>{d.warnings.length} warning{d.warnings.length === 1 ? "" : "s"}</Badge>}</td>
            <td className="mono muted">{shortDigest(d.digest)}</td>
            <td><Button size="sm" loading={busyPath === d.path} disabled={!canDraft || Boolean(busyPath)} onClick={() => onDraft(d.path)}>Edit as draft</Button></td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const STATUS = { open: "info", published: "ok", discarded: "neutral" } as const;

export function DraftList({ drafts }: { drafts: Draft[] }) {
  const now = useNow(60_000);
  if (drafts.length === 0) return <Empty title="No drafts" body="Start one from the map or from a document." />;
  return (
    <ul className="draft-list" aria-label="Drafts">
      {drafts.map((d) => (
        <li key={d.id}>
          <a className="draft-row" href={`#/workspace/${d.id}`}>
            <span className="mono">{d.path}</span>
            <Badge tone={STATUS[d.status]}>{d.status}</Badge>
            <span className="muted draft-row-meta">{d.messages.filter((m) => m.role === "human").length} messages · updated {relativeTime(d.updatedAt, now)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
