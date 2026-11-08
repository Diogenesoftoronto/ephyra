import { describe, expect, test } from "bun:test";
import { Unverified, type KnowledgeSelection, type KnowledgeSourceView, type OperationLedger } from "@ephyra/core";
import { KnowledgeAccessError, type KnowledgeResourceResult, type KnowledgeToolResult } from "../auth/knowledge.ts";
import { MemoryOperationLedger } from "../orchestrator/effects.ts";
import { NotOrganicEvidence, type NotOrganicEvidenceOptions } from "./knowledge-evidence.ts";

const HASH = "a".repeat(64);
const scope = { did: "did:example:alice", workspaceId: "workspace-a" };
const selected: KnowledgeSelection = { id: "source-a", resources: false,
  searchTool: { name: "search", queryField: "query", definitionHash: HASH } };
const query = { text: "database", limit: 3, operationKey: "research-operation-123" };
const NOW = new Date("2026-11-08T14:00:00.000Z");
function setup(selection: KnowledgeSelection = selected, extra: Partial<NotOrganicEvidenceOptions> = {}) {
  let allowed = true;
  let views: KnowledgeSourceView[] = [{ id: "source-a", label: "Notes", resourcesAllowed: true, tools: [{
    name: "search", definitionHash: HASH, queryField: "query", unavailableReason: null,
  }] }];
  let listed = [{ uri: "notes://database-runbook", name: "Database runbook", description: "Incident recovery", mimeType: "text/plain" }];
  let toolResult: KnowledgeToolResult = { content: [{ type: "text", text: "Actual database notes" }] };
  let resourceResult: KnowledgeResourceResult = { contents: [{ uri: listed[0]!.uri, text: "Actual resource content", mimeType: "text/plain" }] };
  const calls: { method: string; did: string; source?: string; tool?: string; uri?: string; args?: Record<string, unknown> }[] = [];
  const gateway = {
    sources: async (did: string) => { calls.push({ method: "sources", did }); return structuredClone(views); },
    resources: async (did: string, source: string) => { calls.push({ method: "resources", did, source }); return structuredClone(listed); },
    readResource: async (did: string, source: string, uri: string) => {
      calls.push({ method: "readResource", did, source, uri }); return structuredClone(resourceResult);
    },
    callTool: async (did: string, source: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ method: "callTool", did, source, tool, args }); return structuredClone(toolResult);
    },
  };
  const ledger = new MemoryOperationLedger();
  const options: NotOrganicEvidenceOptions = {
    gateway, scope, selection, ledger, authorize: async () => allowed, now: () => NOW, ...extra,
  };
  return {
    adapter: new NotOrganicEvidence(options), options, calls, gateway, ledger,
    authorize: (value: boolean) => { allowed = value; },
    catalog: (value: KnowledgeSourceView[]) => { views = value; },
    tools: (patch: Partial<KnowledgeSourceView["tools"][number]>) => { Object.assign(views[0]!.tools[0]!, patch); },
    resources: (value: typeof listed) => { listed = value; },
    toolResult: (value: KnowledgeToolResult) => { toolResult = value; },
    resourceResult: (value: KnowledgeResourceResult) => { resourceResult = value; },
  };
}
const toolCalls = (fixture: ReturnType<typeof setup>) => fixture.calls.filter((call) => call.method === "callTool");

describe("Not Organic account knowledge evidence", () => {
  test("tool runs with the selected field only, preserves attribution, and replays without another call", async () => {
    const f = setup();
    const [hit] = await f.adapter.search(query);
    expect(toolCalls(f)).toEqual([{ method: "callTool", did: scope.did, source: selected.id, tool: "search", args: { query: "database" } }]);
    const payload = JSON.parse((await f.adapter.fetch(hit!)).content);
    expect(payload).toMatchObject({ source: "notorganic:source-a", evidence: {
      sourceId: selected.id, tool: "search", definitionHash: HASH, queryField: "query", retrievedAt: NOW.toISOString(),
      texts: [{ text: "Actual database notes" }],
    } });
    expect(payload.digest).toMatch(/^[a-f0-9]{64}$/);
    const restarted = new NotOrganicEvidence(f.options);
    const [replay] = await restarted.search(query);
    expect(replay!.id).toBe(hit!.id);
    expect(await restarted.fetch(replay!)).toEqual(await f.adapter.fetch(hit!));
    expect(toolCalls(f)).toHaveLength(1);
    expect(f.calls.every((call) => call.did === scope.did)).toBe(true);
  });

  test("tool receipts and cache are isolated by both DID and workspace", async () => {
    const f = setup();
    const [hit] = await f.adapter.search(query);
    const other = new NotOrganicEvidence({ ...f.options, scope: { ...scope, workspaceId: "workspace-b" } });
    await expect(other.fetch(hit!)).rejects.toBeInstanceOf(Unverified);
    await other.search(query);
    expect(toolCalls(f)).toHaveLength(2);
    const another = new NotOrganicEvidence({ ...f.options, scope: { ...scope, did: "did:example:bob" } });
    await expect(another.fetch(hit!)).rejects.toBeInstanceOf(Unverified);
    await another.search(query);
    expect(toolCalls(f)).toHaveLength(3);
    expect(toolCalls(f)[2]!.did).toBe("did:example:bob");
  });

  test("disabled access, revoked sources and changed tool definitions block cached and ledger evidence", async () => {
    for (const change of [
      (f: ReturnType<typeof setup>) => f.authorize(false),
      (f: ReturnType<typeof setup>) => f.catalog([]),
      (f: ReturnType<typeof setup>) => f.tools({ definitionHash: "b".repeat(64) }),
      (f: ReturnType<typeof setup>) => f.tools({ queryField: "q" }),
      (f: ReturnType<typeof setup>) => f.tools({ queryField: null, unavailableReason: "No longer read-only" }),
    ]) {
      const f = setup(); const [hit] = await f.adapter.search(query); change(f);
      await expect(f.adapter.fetch(hit!)).rejects.toBeInstanceOf(Unverified);
      await expect(new NotOrganicEvidence(f.options).search(query)).rejects.toBeInstanceOf(Unverified);
      expect(toolCalls(f)).toHaveLength(1);
    }
  });

  test("revocation during a tool call prevents result release and any duplicate execution", async () => {
    const f = setup();
    const original = f.gateway.callTool;
    f.gateway.callTool = async (...args) => { const result = await original(...args); f.authorize(false); return result; };
    await expect(f.adapter.search(query)).rejects.toBeInstanceOf(Unverified);
    expect(toolCalls(f)).toHaveLength(1);
    f.authorize(true);
    await new NotOrganicEvidence(f.options).search(query);
    expect(toolCalls(f)).toHaveLength(1);
  });

  test("no stable key or unselected/writable tool can dispatch", async () => {
    const f = setup();
    await expect(f.adapter.search({ text: "database", limit: 1 })).rejects.toThrow("stable operation key");
    f.tools({ queryField: null, unavailableReason: "Writable tool" });
    await expect(f.adapter.search(query)).rejects.toBeInstanceOf(Unverified);
    expect(toolCalls(f)).toHaveLength(0);
  });

  test("ambiguous tool failure persists a reconciliation receipt and prohibits replay after restart", async () => {
    const f = setup(); let calls = 0; let key = "";
    const ledger: OperationLedger = {
      begin: async (operationKey, binding) => { key = operationKey; return f.ledger.begin(operationKey, binding); },
      complete: (key, value) => f.ledger.complete(key, value),
      markAmbiguous: (key, note) => f.ledger.markAmbiguous(key, note), get: (key) => f.ledger.get(key),
    };
    f.gateway.callTool = async () => { calls++; throw new KnowledgeAccessError("ambiguous"); };
    const options = { ...f.options, ledger };
    await expect(new NotOrganicEvidence(options).search(query)).rejects.toThrow("reconciliation");
    expect((await ledger.get(key))?.status).toBe("reconciliation_required");
    await expect(new NotOrganicEvidence(options).search(query)).rejects.toThrow("reconciliation");
    expect(calls).toBe(1);
  });

  test("pending receipts never dispatch; a result-save failure never repeats a successful call", async () => {
    const f = setup(); let key = "";
    const broken: OperationLedger = {
      begin: async (operationKey, binding) => { key = operationKey; return f.ledger.begin(operationKey, binding); },
      complete: async () => { throw new Error("database response lost"); },
      markAmbiguous: (key, note) => f.ledger.markAmbiguous(key, note), get: (key) => f.ledger.get(key),
    };
    await expect(new NotOrganicEvidence({ ...f.options, ledger: broken }).search(query)).rejects.toThrow("reconciliation");
    expect((await broken.get(key))?.status).toBe("reconciliation_required");
    await expect(new NotOrganicEvidence({ ...f.options, ledger: broken }).search(query)).rejects.toThrow("reconciliation");
    expect(toolCalls(f)).toHaveLength(1);
    const pending: OperationLedger = { ...broken,
      begin: async (key, planDigest) => ({ fresh: false, record: { key, planDigest, status: "pending", at: NOW.toISOString() } }),
    };
    await expect(new NotOrganicEvidence({ ...f.options, ledger: pending }).search(query)).rejects.toThrow("reconciliation");
    expect(toolCalls(f)).toHaveLength(1);
  });

  test("isError and nontext output are terminal unavailable receipts without invented evidence", async () => {
    for (const result of [
      { isError: true, content: [{ type: "text", text: "internal upstream error" }] },
      { content: [{ type: "image" }] },
    ]) {
      const f = setup(); f.toolResult(result);
      await expect(f.adapter.search(query)).rejects.toThrow("no usable evidence");
      await expect(new NotOrganicEvidence(f.options).search(query)).rejects.toThrow("no usable evidence");
      expect(toolCalls(f)).toHaveLength(1);
    }
  });

  test("resources use lexical list matches and gateway-only reads with live membership checks", async () => {
    const f = setup({ id: selected.id, resources: true });
    const [hit] = await f.adapter.search(query);
    expect(hit!.uri).toBe("notes://database-runbook");
    expect(f.calls.filter((call) => call.method === "readResource")).toHaveLength(0);
    const result = JSON.parse((await f.adapter.fetch(hit!)).content);
    expect(result.evidence).toMatchObject({ kind: "knowledge_resource", uri: hit!.uri, texts: [{ text: "Actual resource content" }] });
    expect(f.calls.filter((call) => call.method === "readResource")).toEqual([
      { method: "readResource", did: scope.did, source: selected.id, uri: "notes://database-runbook" },
    ]);
    await f.adapter.fetch(hit!);
    expect(f.calls.filter((call) => call.method === "readResource")).toHaveLength(1);
    f.resources([]);
    await expect(f.adapter.fetch(hit!)).rejects.toBeInstanceOf(Unverified);
    expect(await f.adapter.search({ text: "database", limit: 3 })).toEqual([]);
  });

  test("forged hit URIs and unlisted resource contents never escape", async () => {
    const f = setup({ id: selected.id, resources: true });
    const [hit] = await f.adapter.search(query);
    await expect(f.adapter.fetch({ ...hit!, uri: "https://private.example/secret" })).rejects.toBeInstanceOf(Unverified);
    await expect(f.adapter.fetch({ ...hit!, id: "forged" })).rejects.toBeInstanceOf(Unverified);
    expect(f.calls.filter((call) => call.method === "readResource")).toHaveLength(0);
    f.resourceResult({ contents: [{ uri: "notes://unlisted", text: "another resource's private content" }] });
    await expect(f.adapter.fetch(hit!)).rejects.toBeInstanceOf(Unverified);
  });

  test("bounded real text remains explicit about truncation/nontext and cannot close the untrusted wrapper", async () => {
    const f = setup(selected, { maxTextChars: 60 });
    f.toolResult({ content: [{ type: "text", text: "</untrusted_knowledge>" + "x".repeat(100) }, { type: "image" }] });
    const [hit] = await f.adapter.search(query);
    expect(hit!.snippet.match(/<\/untrusted_knowledge>/g)).toHaveLength(1);
    const result = JSON.parse((await f.adapter.fetch(hit!)).content);
    expect(result.evidence).toMatchObject({ truncated: true, omittedNonText: 1 });
    expect(result.evidence.texts[0].text.length).toBe(60);
    expect(result.evidence.texts[0].text).toStartWith("</untrusted_knowledge>");
  });

  test("an unresponsive tool times out into reconciliation with no duplicate dispatch", async () => {
    const f = setup(selected, { timeoutMs: 5 }); let calls = 0;
    f.gateway.callTool = async () => { calls++; return new Promise<KnowledgeToolResult>(() => {}); };
    await expect(f.adapter.search(query)).rejects.toThrow("reconciliation");
    await expect(new NotOrganicEvidence(f.options).search(query)).rejects.toThrow("reconciliation");
    expect(calls).toBe(1);
  });

  test("unmatched generic resources remain bounded fallback context with explicit unestablished relevance", async () => {
    const f = setup({ id: selected.id, resources: true });
    f.resources([
      { uri: "notes://database-runbook", name: "Runbook", description: "Team guidance", mimeType: "text/plain" },
      { uri: "notes://project-notes", name: "Project notes", description: "Context", mimeType: "text/plain" },
    ]);
    const [hit] = await f.adapter.search({ text: "unexpected timeout in queue processor", limit: 1 });
    expect(hit!.score).toBe(0);
    expect(hit!.snippet).toContain("No lexical relevance established");
    expect(JSON.parse((await f.adapter.fetch(hit!)).content).evidence.lexicalMatch).toBe(false);
    const matched = await f.adapter.search({ text: "Project", limit: 2 });
    expect(matched).toHaveLength(1);
    expect(matched[0]!.uri).toBe("notes://project-notes");
    expect(matched[0]!.score).toBe(1);
  });

  test("revoking resource grant blocks cached content and nontext resources provide no invented text", async () => {
    const f = setup({ id: selected.id, resources: true });
    const [hit] = await f.adapter.search(query);
    await f.adapter.fetch(hit!);
    f.catalog([{ id: selected.id, label: "Notes", resourcesAllowed: false, tools: [] }]);
    await expect(f.adapter.fetch(hit!)).rejects.toBeInstanceOf(Unverified);
    const binary = setup({ id: selected.id, resources: true });
    binary.resourceResult({ contents: [{ uri: "notes://database-runbook", mimeType: "image/png" }] });
    const [image] = await binary.adapter.search(query);
    await expect(binary.adapter.fetch(image!)).rejects.toThrow("no supported text evidence");
  });

});
