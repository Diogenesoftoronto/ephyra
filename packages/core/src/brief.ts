/**
 * A structured reading of an agent-written checkpoint document (hypothesis.md, plan.md), so an interface can show a
 * compact sheet of labelled parts instead of the raw file. It only rearranges what the document says: every word of
 * the source is in the title, a label taken from the document, or a block, in the original order. A label the
 * reader had to supply (the opening lines have no heading of their own) is marked `named: false`.
 */

export type BriefBlock =
  | { type: "text"; text: string }
  /** `marker` is "•" for a bullet or the document's own number, such as "2.". */
  | { type: "item"; text: string; marker: string; depth: number }
  | { type: "code"; text: string };

/** What a part is for, guessed from its label. It orders nothing and hides nothing; it only picks a tone. */
export type BriefKind = "claim" | "evidence" | "doubt" | "check" | "steps" | "scope" | "risk" | "other";

export interface BriefPart {
  label: string;
  kind: BriefKind;
  /** True when the label is the document's own heading or key. */
  named: boolean;
  blocks: BriefBlock[];
}

export interface DocumentBrief {
  /** The document's first heading, when it opens with one. */
  title?: string;
  parts: BriefPart[];
}

const KINDS: [BriefKind, RegExp][] = [
  ["doubt", /uncertain|unknown|competing|alternative|doubt|ruled? out|open question|confidence|assum/i],
  ["scope", /touch|files?\b|scope/i],
  ["risk", /risk|rollback|blast|danger/i],
  ["evidence", /evidence|observ|signal|symptom|seen\b/i],
  ["check", /next|test|verif|reproduc|check|validat|probe/i],
  ["steps", /steps?\b|implement|change|approach|fix\b|plan\b/i],
  ["claim", /hypothes|cause|claim|summary/i],
];

/** The kind a label suggests. Unrecognized labels are "other" and are shown the same way, without a tone. */
export function briefKind(label: string): BriefKind {
  return KINDS.find(([, pattern]) => pattern.test(label))?.[0] ?? "other";
}

const FACT = /^([A-Z][A-Za-z'’-]*(?: [A-Za-z'’-]+){0,2}):\s+(\S.*)$/;

function lead(path: string, blocks: BriefBlock[]): Pick<BriefPart, "label" | "kind"> {
  const name = path.split("/").pop() ?? path;
  if (name === "hypothesis.md") return { label: "Cause", kind: "claim" };
  if (name === "plan.md") {
    const ordered = blocks.some((b) => b.type === "item" && b.marker !== "•");
    return ordered ? { label: "Steps", kind: "steps" } : { label: "Approach", kind: "steps" };
  }
  return { label: "Summary", kind: "other" };
}

/** Read a Markdown document into labelled parts. `path` names the document, which decides the opening part's label. */
export function readBrief(source: string, path: string): DocumentBrief {
  const parts: BriefPart[] = [];
  let title: string | undefined;
  let part: BriefPart | undefined;
  /** The opening part and the part after a `Key: value` line have no heading of their own. */
  let unnamed: "lead" | "also" = "lead";
  let fact = false;
  let fence: string[] | undefined;
  let open: Extract<BriefBlock, { type: "text" | "item" }> | undefined;
  let any = false;

  const current = () => {
    if (!part) {
      part = { label: unnamed === "lead" ? "" : "Also", kind: "other", named: false, blocks: [] };
      parts.push(part);
    }
    return part;
  };
  const begin = (label: string) => {
    part = { label, kind: briefKind(label), named: true, blocks: [] };
    parts.push(part);
    open = undefined;
    fact = false;
    unnamed = "also";
  };

  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (/^\s*(```|~~~)/.test(raw)) {
        current().blocks.push({ type: "code", text: fence.join("\n") });
        fence = undefined;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = [];
      open = undefined;
      any = true;
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) {
      open = undefined;
      // A `Key: value` line ends at the blank line. What follows is not part of it.
      if (fact) { part = undefined; fact = false; }
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) {
      const text = heading[2]!.trim();
      if (!any && heading[1] === "#") title = text;
      else begin(text);
      any = true;
      continue;
    }
    any = true;
    const item = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      if (fact) { part = undefined; fact = false; }
      open = { type: "item", text: item[4]!, marker: item[3] ? `${item[3]}.` : "•", depth: Math.floor(item[1]!.length / 2) };
      current().blocks.push(open);
      continue;
    }
    const key = open?.type === "item" ? null : line.match(FACT);
    if (key && !/^https?$/i.test(key[1]!)) {
      begin(key[1]!);
      fact = true;
      open = { type: "text", text: key[2]! };
      part!.blocks.push(open);
      continue;
    }
    // A wrapped line continues the paragraph or list item above it.
    if (open) open.text += ` ${line.trim()}`;
    else {
      open = { type: "text", text: line.trim() };
      current().blocks.push(open);
    }
  }
  if (fence) current().blocks.push({ type: "code", text: fence.join("\n") });

  const kept = parts.filter((p) => p.named || p.blocks.length);
  for (const p of kept) if (!p.named && !p.label) Object.assign(p, lead(path, p.blocks));
  return { ...(title === undefined ? {} : { title }), parts: kept };
}

/** How many list items a part holds, for a count beside its label. Zero when it is prose. */
export function briefCount(part: BriefPart): number {
  return part.blocks.filter((b) => b.type === "item" && b.depth === 0).length;
}

/** A `Touches: a, b` style value split into its entries, or null when it does not read as a list of paths. */
export function briefPaths(part: BriefPart): string[] | null {
  if (part.kind !== "scope" || part.blocks.length !== 1 || part.blocks[0]!.type !== "text") return null;
  const entries = part.blocks[0]!.text.replace(/\.$/, "").split(/,\s*/).map((e) => e.trim()).filter(Boolean);
  return entries.length && entries.every((e) => /^[\w@.*/-]+$/.test(e) && /[./]/.test(e)) ? entries : null;
}
