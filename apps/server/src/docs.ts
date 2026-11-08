// Policy documents the console edits: autonomy.md, thresholds.yaml and intents/*.md.
// Source order per document: the configured file (EPHYRA_AUTONOMY_FILE / EPHYRA_THRESHOLDS_FILE, what the server loaded at boot),
// then the deployment repository at the base ref, then the shipped template (autonomy and thresholds only).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AreaSketch, PolicyDoc, PolicyDocKind } from "@ephyra/core";
import {
  AUTONOMY_TEMPLATE, THRESHOLDS_TEMPLATE, applySketches, parseAutonomy, parseThresholds, renderAutonomy, sketchesOf,
} from "@ephyra/policy";
import type { Git } from "./wiring/landing.ts";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const INTENT_PATH = /^intents\/[a-z0-9][a-z0-9._-]{0,80}\.md$/;
export const MAX_DOC_BYTES = 200_000;

/** Which kind of document a repository-relative path names, or null when it is not an editable policy document. */
export function docKind(path: string): PolicyDocKind | null {
  if (path === "autonomy.md") return "autonomy";
  if (path === "thresholds.yaml") return "thresholds";
  return INTENT_PATH.test(path) && !path.includes("..") ? "intent" : null;
}

/** Errors are reported in the same string list as warnings, prefixed "error:". A document with any error cannot be published. */
export const ERROR_PREFIX = "error:";
export const hasErrors = (warnings: readonly string[]): boolean => warnings.some((w) => w.startsWith(ERROR_PREFIX));

export function inspectDoc(kind: PolicyDocKind, content: string): string[] {
  if (Buffer.byteLength(content) > MAX_DOC_BYTES) return [`${ERROR_PREFIX} document is larger than ${MAX_DOC_BYTES} bytes`];
  if (content.includes("\0")) return [`${ERROR_PREFIX} document contains a NUL byte`];
  try {
    if (kind === "autonomy") return [...parseAutonomy(content).warnings];
    if (kind === "thresholds") { parseThresholds(content); return []; }
  } catch (error) {
    return [`${ERROR_PREFIX} ${String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, "").slice(0, 300)}`];
  }
  return content.trim() ? [] : [`${ERROR_PREFIX} the document is empty`];
}

/** The application map of an autonomy document, or undefined when the text does not parse (or is not an autonomy document). */
export function sketchesFor(kind: PolicyDocKind, content: string): AreaSketch[] | undefined {
  if (kind !== "autonomy") return undefined;
  try { return sketchesOf(parseAutonomy(content)); } catch { return undefined; }
}

export type RenderedSketches = { content: string; notes: string[] } | { error: string };
/**
 * Renders an edited application map into the document: the sketches are the complete set of mapped areas, applied to the current text.
 * What the map does not carry (comments, text outside areas, the parser's fallback) is not kept, and the notes say so.
 */
export function renderSketches(kind: PolicyDocKind, current: string, sketches: AreaSketch[]): RenderedSketches {
  if (kind !== "autonomy") return { error: "the application map only applies to the autonomy document" };
  try {
    const { policy, notes } = applySketches(parseAutonomy(current), sketches);
    const content = renderAutonomy(policy);
    const rewritten = current.trim() === content.trim() ? []
      : ["the document was re-rendered from the application map; comments and text outside areas are not kept"];
    return { content, notes: [...notes, ...rewritten] };
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }
}

export type DocsConfig = {
  git: Git; baseRef: string; autonomyFile?: string; thresholdsFile?: string;
  activeContent?: (path: string) => Promise<string | null>;
  activePaths?: () => Promise<string[]>;
};

export class PolicyDocs {
  constructor(private readonly config: DocsConfig) {}

  private async fromRepo(path: string): Promise<string | null> {
    try { return await this.config.git(["show", `${this.config.baseRef}:${path}`]); } catch { return null; }
  }

  /** Current text of a document, or null when this deployment has none (only possible for intents). */
  async content(path: string): Promise<string | null> {
    const kind = docKind(path);
    if (!kind) return null;
    const active = await this.config.activeContent?.(path);
    if (active !== undefined && active !== null) return active;
    const file = kind === "autonomy" ? this.config.autonomyFile : kind === "thresholds" ? this.config.thresholdsFile : undefined;
    if (file) { try { return await readFile(file, "utf8"); } catch { /* fall through to the repository */ } }
    const repo = await this.fromRepo(path);
    if (repo !== null) return repo;
    return kind === "autonomy" ? AUTONOMY_TEMPLATE : kind === "thresholds" ? THRESHOLDS_TEMPLATE : null;
  }

  async get(path: string): Promise<(PolicyDoc & { sketches?: AreaSketch[] }) | null> {
    const kind = docKind(path);
    const content = kind ? await this.content(path) : null;
    if (!kind || content === null) return null;
    const sketches = sketchesFor(kind, content);
    return { path, kind, content, digest: sha256(content), warnings: inspectDoc(kind, content), ...(sketches ? { sketches } : {}) };
  }

  async list(): Promise<(PolicyDoc & { sketches?: AreaSketch[] })[]> {
    let intents: string[] = [];
    try {
      intents = (await this.config.git(["ls-tree", "--name-only", this.config.baseRef, "intents/"])).split("\n").filter((p) => INTENT_PATH.test(p));
    } catch { /* no repository yet, or no intents directory */ }
    const active = await this.config.activePaths?.() ?? [];
    const paths = [...new Set(["autonomy.md", "thresholds.yaml", ...intents.sort(), ...active.filter((path) => docKind(path)).sort()])];
    const docs = await Promise.all(paths.map((p) => this.get(p)));
    return docs.filter((d): d is NonNullable<typeof d> => d !== null);
  }
}
