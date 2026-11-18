import {
  evidenceCoverage, evidenceSourceSummary, readDecisionRecord, readEvidenceIndex, readEvidenceSource,
  type EvidenceHitView, type EvidenceSourceView,
} from "@ephyra/core";
import { useMemo, useState, type ReactNode } from "react";
import { Badge, Hash } from "../kit.ts";
import { clockTime } from "../lib/format.ts";
import { ViewSwitch } from "./CheckpointDocument.tsx";
import "./CheckpointDocument.css";
import "./ReviewRecords.css";

type Artefact = { path: string; content: string | null };
const TONE = { available: "ok", partial: "warn", empty: "neutral", unavailable: "bad" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Hit({ hit, withSource }: { hit: EvidenceHitView; withSource?: boolean }) {
  return (
    <li className="rr-hit">
      <p className="rr-hit-title">
        {withSource && <span className="rr-source mono">{hit.source}</span>}
        <span>{hit.title}</span>
        {hit.score !== undefined && <span className="rr-score num" title="Score the source gave this hit">{hit.score.toFixed(2)}</span>}
      </p>
      {hit.snippet && <p className="rr-snippet">{hit.snippet}</p>}
      {(hit.status && hit.status !== "available" || hit.redacted || hit.revision || hit.uri) && (
        <p className="rr-hit-meta">
          {hit.status === "unavailable" && <Badge tone="bad">content not fetched</Badge>}
          {hit.status === "partial" && <Badge tone="warn">content truncated</Badge>}
          {hit.redacted && <Badge>redacted</Badge>}
          {hit.reason && <span>{hit.reason}</span>}
          {hit.revision && <span className="mono">{hit.revision}</span>}
          {hit.uri && <span className="mono rr-uri">{hit.uri}</span>}
        </p>
      )}
    </li>
  );
}

function Source({ source }: { source: EvidenceSourceView }) {
  const head = (
    <>
      <span className="rr-name">{source.source}</span>
      <Badge tone={TONE[source.status]}>{source.status}</Badge>
      <span className="rr-says">{evidenceSourceSummary(source)}</span>
    </>
  );
  if (!source.hits.length) return <li className="rr-row"><div className="rr-row-head">{head}</div></li>;
  return (
    <li className="rr-row">
      <details>
        <summary className="rr-row-head">{head}</summary>
        <ul className="rr-hits">{source.hits.map((hit, i) => <Hit key={i} hit={hit} />)}</ul>
        {source.reason && <p className="rr-note">{source.reason}</p>}
      </details>
    </li>
  );
}

/** What the collapsed evidence row says: counts taken from the records that were loaded, or from the index alone. */
export function evidenceHeadline(index: string, records: readonly Artefact[]): string {
  const view = readEvidenceIndex(index);
  if (!view) return "Research source coverage";
  if (view.kind === "hits") return `Evidence · ${plural(view.hits.length, "hit")}`;
  const sources = records.flatMap((r) => (r.content ? readEvidenceSource(r.content) : null) ?? []);
  if (!sources.length || sources.length !== view.records.length) return `Research sources · ${view.queried} of ${view.configured} queried`;
  const c = evidenceCoverage(sources);
  return `Research sources · ${[`${c.withHits} with hits`, c.empty ? `${c.empty} empty` : "", c.unavailable ? `${c.unavailable} unavailable` : ""]
    .filter(Boolean).join(" · ")}`;
}

/**
 * The research evidence index as a list: one row per source with what its record says, opening to its hits. An
 * unavailable source is listed as unavailable with its reason. Records the index names but that were not sent are
 * counted as not loaded, never as read.
 */
export function EvidenceCoverage({ index, records }: { index: string; records: readonly Artefact[] }) {
  const view = useMemo(() => readEvidenceIndex(index), [index]);
  const [mode, setMode] = useState<"first" | "file">("first");
  if (!view) return <pre className="review-document">{index}</pre>;
  const body = (): ReactNode => {
    if (view.kind === "hits") {
      return view.hits.length ? <ul className="rr-hits">{view.hits.map((hit, i) => <Hit key={i} hit={hit} withSource />)}</ul>
        : <p className="muted">The index lists no hits.</p>;
    }
    const loaded = view.records.map((path) => ({ path, content: records.find((r) => r.path === path)?.content ?? null }));
    const missing = loaded.filter((r) => r.content === null).length;
    return (
      <>
        <p className="rr-lead">
          <span>{view.queried} of {plural(view.configured, "configured source")} queried</span>
          {view.omitted > 0 && <span>{view.omitted} over the limit and not queried</span>}
          <span>query: <q>{view.query}</q></span>
        </p>
        <ul className="rr-rows">
          {loaded.map((r) => {
            if (r.content === null) return null;
            const source = readEvidenceSource(r.content);
            return source ? <Source key={r.path} source={source} />
              : <li key={r.path} className="rr-row"><div className="rr-row-head"><span className="rr-name mono">{r.path}</span>
                <span className="rr-says">This record is not in a form this page can read.</span></div></li>;
          })}
        </ul>
        {missing > 0 && <p className="rr-note" role="status">{plural(missing, "source record")} named by the index {missing === 1 ? "was" : "were"} not
          loaded, so {missing === 1 ? "it is" : "they are"} not shown here.</p>}
        {view.limitation && <p className="rr-note">{view.limitation}</p>}
      </>
    );
  };
  return (
    <div className="rr">
      <div className="rr-bar"><ViewSwitch label="Evidence view" first="List" view={mode} onChange={setMode} /></div>
      {mode === "file" ? <pre className="review-document">{index}</pre> : body()}
    </div>
  );
}

/** What the collapsed machine checkpoint row says. Only a recorded decision is called a decision. */
export function decisionHeadline(path: string, content: string | null): string {
  const cp = path.match(/latest-([ABC])/)?.[1];
  const title = `Machine checkpoint ${cp ?? "decision"}`;
  const view = content ? readDecisionRecord(content) : null;
  if (!view) return title;
  return view.decision ? `${title} · ${view.decision.verdict}${view.decision.shadow ? " (shadow)" : ""}` : `${title} · ${view.status.replace(/_/g, " ")}`;
}

/** A machine checkpoint record as a sheet: what was decided, by which model, and each answer it gave. */
export function DecisionRecord({ content }: { content: string }) {
  const view = useMemo(() => readDecisionRecord(content), [content]);
  const [mode, setMode] = useState<"first" | "file">("first");
  if (!view) return <pre className="review-document">{content}</pre>;
  const row = (label: string, value: ReactNode, kind?: string) => (
    <div className="cd-part" data-kind={kind}><dt>{label}</dt><dd>{value}</dd></div>
  );
  return (
    <div className="rr">
      <div className="rr-bar"><ViewSwitch label="Decision view" first="Summary" view={mode} onChange={setMode} /></div>
      {mode === "file" ? <pre className="review-document">{content}</pre> : (
        <dl className="cd-sheet">
          {row("Outcome", view.decision
            ? <p className="rr-inline"><Badge tone={view.decision.verdict === "approve" ? "ok" : view.decision.verdict === "revise" ? "warn" : "bad"}>
                {view.decision.verdict}</Badge>{view.decision.shadow && <Badge>shadow</Badge>}
                <span>recorded {clockTime(view.decision.at)}</span></p>
            : <p className="rr-inline"><Badge tone={view.status === "evaluating" ? "info" : "warn"}>{view.status.replace(/_/g, " ")}</Badge>
                <span>No decision was recorded.</span></p>)}
          {view.reason && row("Reason", <p>{view.reason}</p>, "risk")}
          {view.model && row("Model", <p className="mono">{view.model}</p>)}
          {view.fallback && row("Fallback", <p>{view.fallback.from} to {view.fallback.to}: {view.fallback.reason}</p>, "risk")}
          {view.answers.length > 0 && row("Answers", view.answers.map((a) => (
            <div key={a.id} className="rr-answer">
              <p>{a.instructions ?? a.id}</p>
              <p className="rr-inline"><strong>{a.answer}</strong>
                {a.confidence !== undefined && <span className="muted num">confidence {a.confidence.toFixed(2)}</span>}</p>
            </div>
          )))}
          {view.bound && row("Bound to", <p className="rr-inline"><span>revision {view.bound.rev}</span>
            {view.bound.head && <Hash value={view.bound.head} chars={10} />}
            {view.bound.proofDigest && <Hash value={view.bound.proofDigest} chars={10} />}</p>)}
        </dl>
      )}
    </div>
  );
}
