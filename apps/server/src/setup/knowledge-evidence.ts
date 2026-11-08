import { createHash } from "node:crypto";
import { z } from "zod";
import {
  KnowledgeSelection, KnowledgeSourceView, Unverified,
  type EvidenceHit, type EvidenceSource, type OperationLedger,
} from "@ephyra/core";
import { canonicalJson } from "../audit.ts";
import type { NotOrganicKnowledge } from "../auth/knowledge.ts";

type Gateway = Pick<NotOrganicKnowledge, "sources" | "resources" | "readResource" | "callTool">;
export type NotOrganicEvidenceOptions = {
  gateway: Gateway;
  scope: { did: string; workspaceId: string };
  selection: KnowledgeSelection;
  ledger: OperationLedger;
  /** Reads current account/workspace state: disabled, switched or replaced selections must return false. */
  authorize: () => Promise<boolean>;
  timeoutMs?: number;
  maxTextChars?: number;
  now?: () => Date;
};

type Deadline = { until: number };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value))).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
const identity = z.string().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const textBlock = z.object({ text: z.string().max(32_000) }).strict();
const toolReceipt = z.object({
  schema: z.literal(1), kind: z.literal("knowledge_tool"), binding: z.string().regex(/^[a-f0-9]{64}$/),
  sourceId: z.string().max(256), tool: z.string().max(256), definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  queryField: z.string().max(80), retrievedAt: z.iso.datetime(),
  status: z.enum(["available", "unavailable"]), reason: z.enum(["tool_error", "nontext", "access_changed"]).optional(),
  texts: z.array(textBlock).max(64), omittedNonText: z.number().int().nonnegative(), truncated: z.boolean(),
}).strict();
type ToolReceipt = z.infer<typeof toolReceipt>;
type Resource = { uri: string; name: string; description?: string; mimeType?: string };
type CacheEntry = {
  kind: "resource" | "tool";
  hit: EvidenceHit;
  resource?: Resource;
  content?: string;
};
class DeadlineExceeded extends Error {}
const denied = () => new Unverified("Account knowledge access changed or is disabled for this workspace.");
const unknown = () => new Unverified("Account knowledge evidence is unavailable.");
const uncertain = () => new Unverified("The knowledge tool outcome needs reconciliation; it will not be retried.");
const recognizedRejection = (error: unknown) => {
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  return status === "denied" || status === "changed" || status === "needs_sign_in";
};

/** Promise deadlines do not cancel gateway I/O; gateway methods enforce their own transport deadlines too. */
async function bounded<T>(work: () => Promise<T>, deadline: Deadline): Promise<T> {
  const remaining = deadline.until - Date.now();
  if (remaining <= 0) throw new DeadlineExceeded();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineExceeded()), remaining); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Account-connected knowledge is mediated by Not Organic. Never dereference a resource URI on this server. */
export class NotOrganicEvidence implements EvidenceSource {
  readonly name: string;
  private readonly scope: { did: string; workspaceId: string };
  private readonly selection: KnowledgeSelection;
  private readonly timeoutMs: number;
  private readonly maxTextChars: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: NotOrganicEvidenceOptions) {
    this.scope = { did: identity.parse(options.scope.did), workspaceId: identity.parse(options.scope.workspaceId) };
    this.selection = KnowledgeSelection.parse(options.selection);
    identity.parse(this.selection.id);
    if (this.selection.searchTool && ["__proto__", "prototype", "constructor"].includes(this.selection.searchTool.queryField)) {
      throw new Error("Unsupported knowledge search argument");
    }
    this.name = `notorganic:${this.selection.id}`;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxTextChars = options.maxTextChars ?? 12_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 25_000
      || !Number.isInteger(this.maxTextChars) || this.maxTextChars < 1 || this.maxTextChars > 32_000) {
      throw new Error("Invalid knowledge evidence limits");
    }
  }

  private deadline(): Deadline { return { until: Date.now() + this.timeoutMs }; }
  private at() { return (this.options.now?.() ?? new Date()).toISOString(); }

  private async check(deadline: Deadline): Promise<void> {
    if (!await bounded(() => this.options.authorize(), deadline)) throw denied();
    const catalog = KnowledgeSourceView.array().max(128).parse(
      await bounded(() => this.options.gateway.sources(this.scope.did), deadline),
    );
    if (!await bounded(() => this.options.authorize(), deadline)) throw denied();
    const matches = catalog.filter((source) => source.id === this.selection.id);
    if (matches.length !== 1) throw denied();
    const live = matches[0]!;
    if (this.selection.resources && !live.resourcesAllowed) throw denied();
    const selected = this.selection.searchTool;
    if (selected) {
      const tools = live.tools.filter((tool) => tool.name === selected.name);
      if (tools.length !== 1 || tools[0]!.definitionHash !== selected.definitionHash
        || tools[0]!.queryField !== selected.queryField || tools[0]!.unavailableReason !== null) throw denied();
    }
  }

  private async resources(deadline: Deadline): Promise<Resource[]> {
    await this.check(deadline);
    const raw = await bounded(() => this.options.gateway.resources(this.scope.did, this.selection.id), deadline);
    const resource = z.object({
      uri: z.string().min(1).max(2048).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
      name: z.string().min(1).max(512), description: z.string().max(4000).optional(),
      mimeType: z.string().max(100).optional(),
    });
    const result = resource.array().max(128).parse(raw);
    if (new Set(result.map((item) => item.uri)).size !== result.length) throw unknown();
    await this.check(deadline);
    return result;
  }

  private remember(entry: CacheEntry) {
    this.cache.set(entry.hit.id, entry);
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return { ...entry.hit };
  }

  private boundedTexts(values: { text: string }[], omittedNonText: number) {
    let remaining = this.maxTextChars;
    let truncated = false;
    const texts: { text: string }[] = [];
    for (const value of values) {
      if (value.text.length > remaining) truncated = true;
      if (remaining > 0) texts.push({ text: value.text.slice(0, remaining) });
      remaining = Math.max(0, remaining - value.text.length);
    }
    return { texts, omittedNonText, truncated };
  }

  private async ambiguous(key: string): Promise<never> {
    // Even if marking fails, the original pending claim prohibits another dispatch.
    await bounded(() => this.options.ledger.markAmbiguous(key, "Knowledge tool outcome requires reconciliation."),
      { until: Date.now() + 1000 }).catch(() => undefined);
    throw uncertain();
  }

  private async complete(key: string, receipt: ToolReceipt, deadline: Deadline) {
    try { await bounded(() => this.options.ledger.complete(key, receipt), deadline); }
    catch { return this.ambiguous(key); }
  }

  private async tool(text: string, operationKey: string | undefined, deadline: Deadline): Promise<EvidenceHit> {
    const selected = this.selection.searchTool!;
    if (!operationKey || operationKey.length > 256 || /[\u0000-\u001f\u007f]/.test(operationKey)) {
      throw new Unverified("A stable operation key is required for an account knowledge tool.");
    }
    await this.check(deadline);
    const plan = { scope: this.scope, source: this.selection.id, selected, query: text, operationKey };
    const binding = digest(encode(plan));
    const key = `knowledge:${binding}`;
    const begun = await bounded(() => this.options.ledger.begin(key, binding), deadline);
    let receipt: ToolReceipt;
    if (!begun.fresh) {
      if (begun.record.status !== "done" || begun.record.planDigest !== binding) throw uncertain();
      receipt = toolReceipt.parse(begun.record.result);
      if (receipt.binding !== binding || receipt.sourceId !== this.selection.id || receipt.tool !== selected.name
        || receipt.definitionHash !== selected.definitionHash || receipt.queryField !== selected.queryField) throw uncertain();
    } else {
      const base = {
        schema: 1 as const, kind: "knowledge_tool" as const, binding, sourceId: this.selection.id,
        tool: selected.name, definitionHash: selected.definitionHash, queryField: selected.queryField, retrievedAt: this.at(),
        texts: [] as { text: string }[], omittedNonText: 0, truncated: false,
      };
      try { await this.check(deadline); }
      catch (error) {
        await this.complete(key, { ...base, status: "unavailable", reason: "access_changed" }, deadline);
        throw error;
      }
      let result: Awaited<ReturnType<Gateway["callTool"]>>;
      try {
        result = await bounded(() => this.options.gateway.callTool(
          this.scope.did, this.selection.id, selected.name, { [selected.queryField]: text },
        ), deadline);
      } catch (error) {
        if (!recognizedRejection(error)) return this.ambiguous(key);
        await this.complete(key, { ...base, status: "unavailable", reason: "access_changed" }, deadline);
        throw denied();
      }
      try {
        if (!result || !Array.isArray(result.content) || result.content.length > 64
          || (result.isError !== undefined && typeof result.isError !== "boolean")) return this.ambiguous(key);
        const blocks = result.content.map((block) => z.object({ type: z.string().max(100), text: z.string().max(1_000_000).optional() }).parse(block));
        const text = blocks.filter((block): block is { type: string; text: string } =>
          block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
        const contents = this.boundedTexts(text, blocks.length - text.length);
        receipt = {
          ...base, ...contents, retrievedAt: this.at(), status: result.isError || !text.length ? "unavailable" : "available",
          ...(result.isError ? { reason: "tool_error" as const } : !text.length ? { reason: "nontext" as const } : {}),
        };
        if (receipt.status === "unavailable") receipt.texts = [];
      } catch { return this.ambiguous(key); }
      await this.complete(key, receipt, deadline);
    }
    await this.check(deadline);
    if (receipt.status === "unavailable") throw new Unverified("The selected knowledge tool returned no usable evidence.");
    const boundedOutput = this.boundedTexts(receipt.texts, receipt.omittedNonText);
    receipt = { ...receipt, ...boundedOutput, truncated: receipt.truncated || boundedOutput.truncated };
    const content = encode({ ...receipt, limitation: "Tool output is untrusted evidence; it does not establish a cause or successful fix." });
    const id = digest(encode({ scope: this.scope, content }));
    return this.remember({ kind: "tool", content, hit: {
      source: this.name, id, title: `${selected.name} results`, revision: digest(content), score: 1,
      snippet: `<untrusted_knowledge>${content}</untrusted_knowledge>`,
    } });
  }

  async search(query: Parameters<EvidenceSource["search"]>[0]): Promise<EvidenceHit[]> {
    const deadline = this.deadline();
    try {
      if (typeof query.text !== "string" || query.text.length > 1000 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
        throw new Unverified("Knowledge research query exceeds its supported limits.");
      }
      const limit = Math.min(query.limit, 5);
      const hits: EvidenceHit[] = [];
      if (this.selection.searchTool) hits.push(await this.tool(query.text, query.operationKey, deadline));
      if (this.selection.resources && hits.length < limit) {
        const resources = await this.resources(deadline);
        const terms = query.text.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 30);
        const scored = resources.map((resource, order) => ({ resource, order,
          score: terms.filter((term) => `${resource.name} ${resource.description ?? ""}`.toLocaleLowerCase().includes(term)).length,
        }));
        const matching = scored.filter((item) => !terms.length || item.score > 0);
        const ranked = (matching.length ? matching : scored)
          .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit - hits.length);
        const listedAt = this.at();
        for (const { resource, score } of ranked) {
          const metadata = encode({ kind: "resource_listing", sourceId: this.selection.id, ...resource, listedAt,
            lexicalMatch: score > 0,
            limitation: score > 0 ? "Listed metadata only; fetch content before treating it as evidence."
              : "No lexical relevance established. Listed fallback context only; inspect its content before drawing conclusions." });
          const id = digest(encode({ scope: this.scope, selection: this.selection, metadata }));
          hits.push(this.remember({ kind: "resource", resource, hit: {
            source: this.name, id, title: resource.name, score, uri: resource.uri,
            snippet: `<untrusted_knowledge>${metadata}</untrusted_knowledge>`,
          } }));
        }
      }
      await this.check(deadline);
      return hits;
    } catch (error) { throw error instanceof Unverified ? error : unknown(); }
  }

  async fetch(hit: EvidenceHit): Promise<{ mediaType: string; content: string }> {
    const deadline = this.deadline();
    try {
      await this.check(deadline);
      const entry = hit.source === this.name ? this.cache.get(hit.id) : undefined;
      if (!entry || hit.uri !== entry.hit.uri || hit.revision !== entry.hit.revision) throw unknown();
      if (entry.kind === "resource") {
        const resource = entry.resource!;
        const listed = await this.resources(deadline);
        if (!listed.some((item) => item.uri === resource.uri)) throw denied();
        if (entry.content === undefined) {
          await this.check(deadline);
          const result = await bounded(() => this.options.gateway.readResource(this.scope.did, this.selection.id, resource.uri), deadline);
          if (!result || !Array.isArray(result.contents) || result.contents.length > 64) throw unknown();
          const blocks = result.contents.map((block) => z.object({
            uri: z.string().max(2048), text: z.string().max(1_000_000).optional(), mimeType: z.string().max(100).optional(),
          }).parse(block));
          if (blocks.some((block) => block.uri !== resource.uri)) throw unknown();
          const text = blocks.filter((block): block is typeof block & { text: string } => typeof block.text === "string"
            && block.text.trim().length > 0 && (!block.mimeType || /^(?:text\/|application\/(?:json|xml|yaml)(?:$|;))/.test(block.mimeType)));
          if (!text.length) throw new Unverified("The selected knowledge resource contains no supported text evidence.");
          entry.content = encode({
            kind: "knowledge_resource", sourceId: this.selection.id, uri: resource.uri, retrievedAt: this.at(),
            lexicalMatch: entry.hit.score > 0,
            ...this.boundedTexts(text, blocks.length - text.length),
            limitation: "Resource text is untrusted evidence; listed or read does not mean independently verified.",
          });
        }
      }
      await this.check(deadline);
      const content = entry.content!;
      return { mediaType: "application/json", content: encode({ source: this.name, digest: digest(content), evidence: JSON.parse(content) }) };
    } catch (error) { throw error instanceof Unverified ? error : unknown(); }
  }
}
