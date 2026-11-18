// The landing page's copy of packages/core/src/brief.ts: a hypothesis or a plan read into labelled parts.
// apps/web/test/brief.test.js holds the two to the same reading, so the page shows what the app and the CLI show.

const KINDS = [
  ["doubt", /uncertain|unknown|competing|alternative|doubt|ruled? out|open question|confidence|assum/i],
  ["scope", /touch|files?\b|scope/i],
  ["risk", /risk|rollback|blast|danger/i],
  ["evidence", /evidence|observ|signal|symptom|seen\b/i],
  ["check", /next|test|verif|reproduc|check|validat|probe/i],
  ["steps", /steps?\b|implement|change|approach|fix\b|plan\b/i],
  ["claim", /hypothes|cause|claim|summary/i],
];

/** The kind a label suggests. Unrecognized labels are "other" and are shown the same way, without a tone. */
export function briefKind(label) {
  return KINDS.find(([, pattern]) => pattern.test(label))?.[0] ?? "other";
}

const FACT = /^([A-Z][A-Za-z'’-]*(?: [A-Za-z'’-]+){0,2}):\s+(\S.*)$/;

function lead(path, blocks) {
  const name = path.split("/").pop() ?? path;
  if (name === "hypothesis.md") return { label: "Cause", kind: "claim" };
  if (name === "plan.md") {
    const ordered = blocks.some((b) => b.type === "item" && b.marker !== "•");
    return ordered ? { label: "Steps", kind: "steps" } : { label: "Approach", kind: "steps" };
  }
  return { label: "Summary", kind: "other" };
}

/** Read a Markdown document into labelled parts. `path` names the document, which decides the opening part's label. */
export function readBrief(source, path) {
  const parts = [];
  let title;
  let part;
  /** The opening part and the part after a `Key: value` line have no heading of their own. */
  let unnamed = "lead";
  let fact = false;
  let fence;
  let open;
  let any = false;

  const current = () => {
    if (!part) {
      part = { label: unnamed === "lead" ? "" : "Also", kind: "other", named: false, blocks: [] };
      parts.push(part);
    }
    return part;
  };
  const begin = (label) => {
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
      const text = heading[2].trim();
      if (!any && heading[1] === "#") title = text;
      else begin(text);
      any = true;
      continue;
    }
    any = true;
    const item = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      if (fact) { part = undefined; fact = false; }
      open = { type: "item", text: item[4], marker: item[3] ? `${item[3]}.` : "•", depth: Math.floor(item[1].length / 2) };
      current().blocks.push(open);
      continue;
    }
    const key = open?.type === "item" ? null : line.match(FACT);
    if (key && !/^https?$/i.test(key[1])) {
      begin(key[1]);
      fact = true;
      open = { type: "text", text: key[2] };
      part.blocks.push(open);
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

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const words = (text) => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>");

/** The sheet the console shows for a checkpoint document: one labelled row per part, in the document's order. */
export function briefHtml(source, path) {
  const { parts } = readBrief(source, path);
  if (!parts.length) return `<pre class="g-file-text">${escape(source)}</pre>`;
  return `<dl class="g-brief">${parts.map((part) => {
    const count = part.blocks.filter((b) => b.type === "item" && b.depth === 0).length;
    const blocks = part.blocks.map((b) => b.type === "code" ? `<pre>${escape(b.text)}</pre>`
      : b.type === "item" ? `<p class="g-brief-item"><span>${escape(b.marker)}</span><span>${words(b.text)}</span></p>`
      : `<p>${words(b.text)}</p>`).join("");
    return `<div data-kind="${part.kind}"><dt>${escape(part.label)}${count > 1 ? `<span>${count}</span>` : ""}</dt><dd>${blocks}</dd></div>`;
  }).join("")}</dl>`;
}
