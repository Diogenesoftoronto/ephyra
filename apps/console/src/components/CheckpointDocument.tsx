import { briefCount, briefPaths, readBrief, type BriefBlock, type BriefPart } from "@ephyra/core";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Card } from "../kit.ts";
import "./CheckpointDocument.css";

/** A part longer than this opens with its first blocks and a button for the rest. */
const CLAMP = 5;

/** hypothesis.md and plan.md are read into labelled parts. Every other document stays as its file. */
export const readsAsBrief = (path: string): boolean => /(^|\/)(hypothesis|plan)\.md$/.test(path);

/** Backticked spans become code. Everything else is shown as the agent wrote it. */
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/).map((piece, i) =>
    piece.length > 2 && piece.startsWith("`") && piece.endsWith("`") ? <code key={i}>{piece.slice(1, -1)}</code> : <Fragment key={i}>{piece}</Fragment>);
}

function Block({ block }: { block: BriefBlock }) {
  if (block.type === "code") return <pre className="cd-code">{block.text}</pre>;
  if (block.type === "text") return <p>{inline(block.text)}</p>;
  return (
    <p className="cd-item" style={block.depth ? { marginInlineStart: `${block.depth * 1.25}rem` } : undefined}>
      <span className="cd-marker" aria-hidden={block.marker === "•"}>{block.marker}</span>
      <span>{inline(block.text)}</span>
    </p>
  );
}

function Part({ part }: { part: BriefPart }) {
  const [all, setAll] = useState(false);
  const paths = briefPaths(part);
  const count = briefCount(part);
  const shown = all || part.blocks.length <= CLAMP ? part.blocks : part.blocks.slice(0, CLAMP - 1);
  const hidden = part.blocks.length - shown.length;
  return (
    <div className="cd-part" data-kind={part.kind}>
      <dt>
        {part.label}
        {count > 1 && <span className="cd-count num" aria-label={`${count} items`}>{count}</span>}
      </dt>
      <dd>
        {paths
          ? <ul className="cd-paths">{paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          : shown.map((block, i) => <Block key={i} block={block} />)}
        {hidden > 0 && <button type="button" className="cd-more" onClick={() => setAll(true)}>Show {hidden} more</button>}
      </dd>
    </div>
  );
}

/** Two views of one record: the readable one, named by `first`, and the file as it was written. */
export function ViewSwitch({ label, first, view, onChange }: {
  label: string; first: string; view: "first" | "file"; onChange: (view: "first" | "file") => void;
}) {
  return (
    <div className="cd-switch" role="group" aria-label={label}>
      {(["first", "file"] as const).map((id) => (
        <button key={id} type="button" aria-pressed={view === id} onClick={() => onChange(id)}>{id === "first" ? first : "File"}</button>
      ))}
    </div>
  );
}

/**
 * A hypothesis or a plan as a compact sheet: one labelled row per part of the document, in the document's order. The
 * File view shows the Markdown exactly as the agent wrote it. Nothing here edits the document: a person changes it by
 * sending the checkpoint back with a note.
 */
export function CheckpointDocument({ path, content, meta }: { path: string; content: string; meta?: ReactNode }) {
  const brief = useMemo(() => readBrief(content, path), [content, path]);
  const [view, setView] = useState<"brief" | "file">("brief");
  const readable = brief.parts.length > 0;
  const switcher = readable && <ViewSwitch label={`${path} view`} first="Brief" view={view === "brief" ? "first" : "file"}
    onChange={(next) => setView(next === "first" ? "brief" : "file")} />;
  return (
    <Card tone="quiet" title={path} meta={meta} actions={switcher}>
      {readable && view === "brief"
        ? <dl className="cd-sheet">{brief.parts.map((part, i) => <Part key={i} part={part} />)}</dl>
        : <pre className="review-document">{content}</pre>}
    </Card>
  );
}
