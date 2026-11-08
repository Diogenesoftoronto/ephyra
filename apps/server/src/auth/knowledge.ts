import { createHash } from "node:crypto";
import { z } from "zod";
import type { KnowledgeSourceView, KnowledgeToolView } from "@ephyra/core";
import { canonicalJson } from "../audit.ts";
import { dpopProof } from "./crypto.ts";
import { SignInError, type NotOrganicSignIn } from "./notorganic.ts";

export type KnowledgeAccessStatus = "needs_sign_in" | "unavailable" | "denied" | "changed" | "ambiguous";
const messages: Record<KnowledgeAccessStatus, string> = {
  needs_sign_in: "Sign in again to allow the selected knowledge access.",
  unavailable: "The knowledge source could not be read. Check its connection and permissions.",
  denied: "This account has not granted access to the selected knowledge operation.",
  changed: "The knowledge tool changed. Review its definition and permissions before using it.",
  ambiguous: "The knowledge tool outcome could not be confirmed. Reconcile the operation before trying again.",
};
export class KnowledgeAccessError extends Error {
  constructor(readonly status: KnowledgeAccessStatus) {
    super(messages[status]);
    this.name = "KnowledgeAccessError";
  }
}

export type KnowledgeResource = { uri: string; name: string; description?: string; mimeType?: string };
export type KnowledgeResourceResult = { contents: Array<{ uri: string; text?: string; mimeType?: string }> };
export type KnowledgeToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const MAX_BYTES = 1_048_576;
const identifier = z.string().min(1).max(256).refine((s) => s !== "." && s !== ".." && !/[\s\u0000-\u001f\u007f/\\?#]/u.test(s));
const rawTool = z.object({
  name: identifier,
  description: z.string().max(4000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).passthrough().optional(),
}).passthrough();
const rawSource = z.object({
  id: identifier, provider: z.literal("remote-mcp"), label: z.string().max(300), resources_allowed: z.boolean(),
  tools: z.array(rawTool).max(128).refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length),
});
const catalog = z.object({ object: z.literal("list"), data: z.array(rawSource).max(128)
  .refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length) });
const resource = z.object({
  uri: z.string().min(1).max(4096), name: z.string().max(1000), description: z.string().max(16_000).optional(),
  mimeType: z.string().max(300).optional(),
});
const resourceList = z.object({ resources: z.array(resource).max(200)
  .refine((items) => new Set(items.map((item) => item.uri)).size === items.length) });
const resourceResult = z.object({ contents: z.array(z.object({
  uri: z.string().min(1).max(4096), text: z.string().max(MAX_BYTES).optional(), mimeType: z.string().max(300).optional(),
})).max(200) });
const toolResult = z.object({ content: z.array(z.object({
  type: z.string().min(1).max(100), text: z.string().max(MAX_BYTES).optional(),
})).max(1000), isError: z.boolean().optional() });

/** Reject non-JSON/deep values before canonical hashing; include unknown definition metadata in the digest. */
function definitionJson(value: unknown): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 10_000 || depth > 20) throw new KnowledgeAccessError("unavailable");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object") throw new KnowledgeAccessError("unavailable");
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded) > 64_000) throw new KnowledgeAccessError("unavailable");
  return encoded;
}

const QUERY_FIELDS = new Set(["query", "q", "search", "term", "text"]);
const COMPLEX_SCHEMA = new Set([
  "$ref", "$dynamicRef", "$recursiveRef", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "dependentSchemas", "dependencies", "dependentRequired", "patternProperties", "unevaluatedProperties",
]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function queryField(schema: Record<string, unknown>): string | null {
  const complex = (value: unknown): boolean => {
    if (!object(value) && !Array.isArray(value)) return false;
    return Object.entries(value).some(([key, child]) => COMPLEX_SCHEMA.has(key) || complex(child));
  };
  if (complex(schema) || schema.type !== "object" || !object(schema.properties)) return null;
  const rootKeys = new Set(["type", "properties", "required", "additionalProperties", "description", "title", "$schema"]);
  if (Object.keys(schema).some((key) => !rootKeys.has(key))) return null;
  if (["description", "title", "$schema"].some((key) => schema[key] !== undefined && typeof schema[key] !== "string")) return null;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return null;
  const candidates = Object.entries(schema.properties).filter(([key, value]) => QUERY_FIELDS.has(key)
    && object(value) && value.type === "string");
  if (candidates.length !== 1) return null;
  const [name, value] = candidates[0]!;
  if (!object(value) || Object.keys(value).some((key) => !["type", "description", "title"].includes(key))) return null;
  if (["description", "title"].some((key) => value[key] !== undefined && typeof value[key] !== "string")) return null;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((key) => key !== name) || new Set(required).size !== required.length) return null;
  // Optional primitive arguments may exist; automatic research supplies only the selected query field.
  if (Object.values(schema.properties).some((property) => !object(property)
    || !["string", "number", "integer", "boolean"].includes(String(property.type)))) return null;
  return name;
}

/** Eligibility describes an adapter shape, never authorization. The workspace must explicitly select the exact definition hash. */
export function knowledgeToolView(raw: unknown): KnowledgeToolView {
  const encoded = definitionJson(raw);
  const parsed = rawTool.safeParse(raw);
  if (!parsed.success) throw new KnowledgeAccessError("unavailable");
  const tool = parsed.data;
  const readOnly = tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
  const field = readOnly ? queryField(tool.inputSchema) : null;
  return {
    name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }),
    definitionHash: createHash("sha256").update(encoded).digest("hex"), queryField: field,
    unavailableReason: field ? null : readOnly
      ? "This tool needs a supported single string query and no other required arguments."
      : "This tool has not declared read-only, non-destructive operation.",
  };
}

function scrub<T>(value: T, token: string): T {
  if (typeof value === "string") return value.split(token).join("[REDACTED]") as T;
  if (Array.isArray(value)) return value.map((item) => scrub(item, token)) as T;
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, token)])) as T;
  return value;
}

/** Reads only through the configured account gateway. Upstream server addresses and credentials never enter this client. */
export class NotOrganicKnowledge {
  private readonly origin: string;
  private readonly timeoutMs: number;
  constructor(private readonly signIn: NotOrganicSignIn, options: { timeoutMs?: number } = {}) {
    let issuer: URL;
    try { issuer = new URL(signIn.config.issuer); } catch { throw new KnowledgeAccessError("unavailable"); }
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== "/") {
      throw new KnowledgeAccessError("unavailable");
    }
    this.origin = issuer.origin;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(8000, options.timeoutMs!)) : 8000;
  }

  private segment(value: string): string {
    if (!identifier.safeParse(value).success) throw new KnowledgeAccessError("denied");
    return encodeURIComponent(value);
  }

  private async request<T>(did: string, path: string, scope: "knowledge:read" | "knowledge:tools",
    decode: (body: unknown) => T, input?: Record<string, unknown>): Promise<T> {
    const method = input === undefined ? "GET" : "POST";
    const isTool = scope === "knowledge:tools";
    const controller = new AbortController();
    let dispatched = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    const failure = () => new KnowledgeAccessError(isTool && dispatched ? "ambiguous" : "unavailable");
    const active = () => { if (controller.signal.aborted) throw failure(); };
    let rejectTimeout!: (error: Error) => void;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      rejectTimeout(failure());
    }, this.timeoutMs);
    try {
      const run = async () => {
        if (!(await this.signIn.hasScope(did, scope))) throw new KnowledgeAccessError("needs_sign_in");
        active();
        const credentials = await this.signIn.credentialsFor(did);
        active();
        // Scope metadata can change during token rotation; the gateway independently checks the actual access token.
        if (!(await this.signIn.hasScope(did, scope))) throw new KnowledgeAccessError("needs_sign_in");
        active();
        const url = `${this.origin}${path}`;
        const proof = await dpopProof(credentials.keys, credentials.publicJwk, url, method, credentials.token);
        active();
        const body = input === undefined ? undefined : JSON.stringify(input);
        if (body !== undefined && Buffer.byteLength(body) > 65_536) throw new KnowledgeAccessError("denied");
        dispatched = true;
        response = await this.signIn.fetch(url, {
          method, headers: { authorization: `DPoP ${credentials.token}`, dpop: proof, accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body, signal: controller.signal, redirect: "manual", cache: "no-store",
        });
        // A custom transport can ignore AbortSignal and return after the caller has already timed out.
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw failure(); }
        active();
        if (response.redirected || (response.status >= 300 && response.status < 400)) throw failure();
        if (response.status === 401) throw new KnowledgeAccessError("needs_sign_in");
        if (response.status === 403 || response.status === 400) throw new KnowledgeAccessError("denied");
        if (response.status === 409) throw new KnowledgeAccessError("changed");
        if (!response.ok) throw failure();
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw failure();
        if (!response.body) throw failure();
        reader = response.body.getReader();
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const next = await reader.read();
          active();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BYTES) throw failure();
          chunks.push(next.value);
        }
        const data = Buffer.concat(chunks, bytes).toString("utf8");
        // Validate raw definitions before projection, then remove this account's token from any returned text.
        const value = decode(JSON.parse(data));
        return scrub(value, credentials.token);
      };
      return await Promise.race([run(), timeout]);
    } catch (error) {
      if (error instanceof KnowledgeAccessError) throw error;
      if (error instanceof SignInError && [401, 403].includes(error.status)) throw new KnowledgeAccessError("needs_sign_in");
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body) void response.body.cancel().catch(() => {});
    }
  }

  sources(did: string): Promise<KnowledgeSourceView[]> {
    return this.request(did, "/v1/knowledge/sources", "knowledge:read", (body) => {
      const parsed = catalog.parse(body);
      // Hash the complete raw definitions, including unknown metadata, instead of Zod's projection.
      const original = (body as { data: Array<{ tools: unknown[] }> }).data;
      return parsed.data.map((source, index) => ({ id: source.id, label: source.label,
        resourcesAllowed: source.resources_allowed, tools: original[index]!.tools.map(knowledgeToolView) }));
    });
  }
  resources(did: string, sourceId: string): Promise<KnowledgeResource[]> {
    return this.request(did, `/v1/knowledge/sources/${this.segment(sourceId)}/resources`, "knowledge:read",
      (body) => resourceList.parse(body).resources);
  }
  readResource(did: string, sourceId: string, uri: string): Promise<KnowledgeResourceResult> {
    if (typeof uri !== "string" || !uri || uri.length > 4096) return Promise.reject(new KnowledgeAccessError("denied"));
    return this.request(did, `/v1/knowledge/sources/${this.segment(sourceId)}/resources/read`, "knowledge:read",
      (body) => resourceResult.parse(body), { uri });
  }
  callTool(did: string, sourceId: string, tool: string, args: Record<string, unknown>): Promise<KnowledgeToolResult> {
    if (!object(args)) return Promise.reject(new KnowledgeAccessError("denied"));
    return this.request(did, `/v1/knowledge/sources/${this.segment(sourceId)}/tools/${this.segment(tool)}/call`, "knowledge:tools",
      (body) => toolResult.parse(body), { arguments: args });
  }
}
