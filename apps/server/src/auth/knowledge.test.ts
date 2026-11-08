import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../audit.ts";
import { newDpopKeys, jwtClaims, sha256b64url, type Fetch } from "./crypto.ts";
import { SignInError, type NotOrganicSignIn } from "./notorganic.ts";
import { KnowledgeAccessError, NotOrganicKnowledge, knowledgeToolView } from "./knowledge.ts";

const DID = "did:plc:alice";
const OTHER = "did:plc:bob";
const ORIGIN = "https://knowledge-gateway.test";
const rawTool = () => ({ name: "search_notes", description: "Search saved notes.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  annotations: { readOnlyHint: true, destructiveHint: false },
});
const source = () => ({ id: "source-1", provider: "remote-mcp", label: "Project notes", resources_allowed: true, tools: [rawTool()] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fixture(fetcher: Fetch, options: { scopes?: string[]; timeoutMs?: number; issuer?: string } = {}) {
  const alice = await newDpopKeys();
  const bob = await newDpopKeys();
  const credentials = new Map([
    [DID, { token: "alice-access-token", keys: alice.keys, publicJwk: alice.publicJwk }],
    [OTHER, { token: "bob-access-token", keys: bob.keys, publicJwk: bob.publicJwk }],
  ]);
  const scopeCalls: Array<{ did: string; scope: string }> = [];
  const credentialCalls: string[] = [];
  const scopes = new Set(options.scopes ?? ["knowledge:read", "knowledge:tools"]);
  const connection = {
    config: { issuer: options.issuer ?? ORIGIN }, fetch: fetcher,
    hasScope: async (did: string, scope: string) => { scopeCalls.push({ did, scope }); return credentials.has(did) && scopes.has(scope); },
    credentialsFor: async (did: string) => {
      credentialCalls.push(did);
      const value = credentials.get(did);
      if (!value) throw new SignInError(401, "private refresh details");
      return value;
    },
  };
  const client = new NotOrganicKnowledge(connection as unknown as NotOrganicSignIn, { timeoutMs: options.timeoutMs });
  return { client, connection, credentials, scopeCalls, credentialCalls, scopes, alice, bob };
}

async function errorStatus(result: Promise<unknown>) {
  try { await result; throw new Error("Expected a knowledge error"); }
  catch (error) {
    expect(error).toBeInstanceOf(KnowledgeAccessError);
    return (error as KnowledgeAccessError).status;
  }
}

test("each gateway request uses the selected account, a fresh signed DPoP proof, and the exact method and URL", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const f = await fixture(async (url, init) => {
    requests.push({ url, init: init! });
    if (url.endsWith("/call")) return json({ content: [{ type: "text", text: "Evidence" }] });
    if (url.endsWith("/read")) return json({ contents: [{ uri: "notes://one", text: "Evidence", mimeType: "text/plain" }] });
    if (url.endsWith("/resources")) return json({ resources: [{ uri: "notes://one", name: "One" }] });
    return json({ object: "list", data: [source()] });
  });
  expect((await f.client.sources(DID))[0]).toMatchObject({ id: "source-1", resourcesAllowed: true });
  await f.client.resources(DID, "source-1");
  await f.client.readResource(OTHER, "source-1", "notes://one");
  await f.client.callTool(OTHER, "source-1", "search_notes", { query: "failing checkout" });
  const proofs = [];
  for (const [index, { url, init }] of requests.entries()) {
    const headers = new Headers(init.headers);
    const token = index < 2 ? "alice-access-token" : "bob-access-token";
    expect(headers.get("authorization")).toBe(`DPoP ${token}`);
    const proof = headers.get("dpop")!; proofs.push(jwtClaims(proof).jti);
    expect(jwtClaims(proof)).toMatchObject({ htu: url, htm: index < 2 ? "GET" : "POST", ath: await sha256b64url(token) });
    const [header, payload, signature] = proof.split(".");
    const key = index < 2 ? f.alice.keys.publicKey : f.bob.keys.publicKey;
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
      Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
    expect(init.redirect).toBe("manual"); expect(init.cache).toBe("no-store");
  }
  expect(new Set(proofs).size).toBe(4);
  expect(f.credentialCalls).toEqual([DID, DID, OTHER, OTHER]);
  expect(f.scopeCalls.map((call) => call.scope)).toEqual([
    "knowledge:read", "knowledge:read", "knowledge:read", "knowledge:read",
    "knowledge:read", "knowledge:read", "knowledge:tools", "knowledge:tools",
  ]);
  expect(requests[2]!.init.body).toBe(JSON.stringify({ uri: "notes://one" }));
  expect(requests[3]!.init.body).toBe(JSON.stringify({ arguments: { query: "failing checkout" } }));
});

test("missing scopes stop before credential access and network traffic", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return json({}); }, { scopes: ["knowledge:read"] });
  expect(await errorStatus(f.client.callTool(DID, "source-1", "search_notes", { query: "test" }))).toBe("needs_sign_in");
  expect(await errorStatus(f.client.sources("did:plc:unknown"))).toBe("needs_sign_in");
  expect(calls).toBe(0); expect(f.credentialCalls).toEqual([]);
});

test("scope revocation during credential refresh prevents dispatch", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return json({}); });
  const original = f.connection.credentialsFor;
  f.connection.credentialsFor = async (did) => { const value = await original(did); f.scopes.clear(); return value; };
  expect(await errorStatus(f.client.sources(DID))).toBe("needs_sign_in");
  expect(calls).toBe(0);
});

test("rotating one account's token never substitutes another account's credentials", async () => {
  const authorizations: Array<string | null> = [];
  const f = await fixture(async (_url, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization")); return json({ object: "list", data: [] });
  });
  await f.client.sources(DID);
  f.credentials.get(DID)!.token = "rotated-alice-token";
  await f.client.sources(OTHER); await f.client.sources(DID);
  expect(authorizations).toEqual(["DPoP alice-access-token", "DPoP bob-access-token", "DPoP rotated-alice-token"]);
});

test("HTTP failures expose safe status and no upstream error body", async () => {
  for (const [status, expected] of [[401, "needs_sign_in"], [403, "denied"], [409, "changed"], [500, "ambiguous"]] as const) {
    let calls = 0;
    const f = await fixture(async () => { calls++; return json({ error: "sensitive upstream error alice-access-token" }, status); });
    try { await f.client.callTool(DID, "source-1", "search_notes", {}); throw new Error("Expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(KnowledgeAccessError);
      expect((error as KnowledgeAccessError).status).toBe(expected);
      expect(String(error)).not.toContain("alice-access-token");
      expect(String(error)).not.toContain("sensitive upstream");
    }
    expect(calls).toBe(1);
  }
});

test("redirects never forward tokens to a second origin and are not retried", async () => {
  const calls: string[] = [];
  const f = await fixture(async (url) => { calls.push(url); return new Response(null, {
    status: 302, headers: { location: "https://attacker.test/collect" },
  }); });
  expect(await errorStatus(f.client.sources(DID))).toBe("unavailable");
  expect(await errorStatus(f.client.callTool(DID, "source-1", "search_notes", {}))).toBe("ambiguous");
  expect(calls.every((url) => url.startsWith(`${ORIGIN}/v1/knowledge/`))).toBe(true);
  expect(calls).toHaveLength(2);
});

test("a timeout bounds an uncooperative fetch and labels tool outcomes ambiguous", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return new Promise(() => {}); }, { timeoutMs: 25 });
  const start = Date.now();
  expect(await errorStatus(f.client.callTool(DID, "source-1", "search_notes", {}))).toBe("ambiguous");
  expect(Date.now() - start).toBeLessThan(1000);
  expect(calls).toBe(1);
});

test("credentials resolving after the deadline cannot dispatch a late tool call", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return json({}); }, { timeoutMs: 10 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = f.connection.credentialsFor;
  f.connection.credentialsFor = async (did) => { await gate; return original(did); };
  expect(await errorStatus(f.client.callTool(DID, "source-1", "search_notes", {}))).toBe("unavailable");
  release(); await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBe(0);
});

test("a response arriving after the deadline is canceled without exposing its body", async () => {
  let resolve!: (response: Response) => void;
  let canceled = false;
  const f = await fixture(async () => new Promise((release) => { resolve = release; }), { timeoutMs: 20 });
  expect(await errorStatus(f.client.callTool(DID, "source-1", "search_notes", {}))).toBe("ambiguous");
  resolve(new Response(new ReadableStream({ cancel() { canceled = true; } })));
  await new Promise((release) => setTimeout(release, 10));
  expect(canceled).toBe(true);
});

test("the body deadline cancels a stalled stream", async () => {
  let canceled = false;
  const f = await fixture(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"content":')); },
    cancel() { canceled = true; },
  })), { timeoutMs: 25 });
  expect(await errorStatus(f.client.callTool(DID, "source-1", "search_notes", {}))).toBe("ambiguous");
  expect(canceled).toBe(true);
});

test("streamed size is enforced independently of declared Content-Length", async () => {
  let canceled = false;
  const f = await fixture(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(300_000)); },
    cancel() { canceled = true; },
  }), { headers: { "content-length": "1" } }));
  expect(await errorStatus(f.client.callTool(DID, "source-1", "search_notes", {}))).toBe("ambiguous");
  expect(canceled).toBe(true);
});

test("malformed, oversized and schema-invalid tool replies stay ambiguous without retry", async () => {
  for (const make of [() => new Response("not JSON"), () => json({ unexpected: true }),
    () => new Response("{}", { headers: { "content-length": "1048577" } })]) {
    let calls = 0;
    const f = await fixture(async () => { calls++; return make(); });
    expect(await errorStatus(f.client.callTool(DID, "source-1", "search_notes", {}))).toBe("ambiguous");
    expect(calls).toBe(1);
  }
});

test("returned bodies redact access tokens and retain MCP isError for the caller", async () => {
  const f = await fixture(async () => json({ content: [{ type: "text", text: "Failure alice-access-token" }], isError: true,
    structuredContent: { secret: "alice-access-token" } }));
  expect(await f.client.callTool(DID, "source-1", "search_notes", {})).toEqual({
    content: [{ type: "text", text: "Failure [REDACTED]" }], isError: true,
  });
});

test("source/tool duplicate identities and unbounded catalogs are rejected", async () => {
  const bad = [
    { object: "list", data: [source(), source()] },
    { object: "list", data: [{ ...source(), tools: [rawTool(), rawTool()] }] },
    { object: "list", data: Array.from({ length: 129 }, (_, i) => ({ ...source(), id: `source-${i}` })) },
    { object: "list", data: [{ ...source(), provider: "unknown" }] },
  ];
  for (const body of bad) {
    const f = await fixture(async () => json(body));
    expect(await errorStatus(f.client.sources(DID))).toBe("unavailable");
  }
});

test("definition hash includes the complete tool and is independent of object key ordering", () => {
  const first = { ...rawTool(), vendor: { revision: 1, kind: "search" } };
  const reordered = { vendor: { kind: "search", revision: 1 }, annotations: first.annotations,
    inputSchema: first.inputSchema, description: first.description, name: first.name };
  const expected = createHash("sha256").update(canonicalJson(first)).digest("hex");
  expect(knowledgeToolView(first).definitionHash).toBe(expected);
  expect(knowledgeToolView(reordered).definitionHash).toBe(expected);
  expect(knowledgeToolView({ ...first, vendor: { ...first.vendor, revision: 2 } }).definitionHash).not.toBe(expected);
  expect(knowledgeToolView(first)).toMatchObject({ queryField: "query", unavailableReason: null });
});

test("eligibility requires an explicit read-only claim and a supported unconstrained query argument", () => {
  const rejected = [
    { ...rawTool(), annotations: {} },
    { ...rawTool(), annotations: { readOnlyHint: true, destructiveHint: true } },
    { ...rawTool(), inputSchema: { ...rawTool().inputSchema, required: ["query", "projectId"] } },
    { ...rawTool(), inputSchema: { ...rawTool().inputSchema, anyOf: [{}] } },
    { ...rawTool(), inputSchema: { ...rawTool().inputSchema, description: { unexpected: true } } },
    ...["pattern", "enum", "minLength", "maxLength", "format", "const", "$ref"].map((key) => ({ ...rawTool(),
      inputSchema: { type: "object", properties: { query: { type: "string", [key]: key === "enum" ? ["fixed"] : "restricted" } } },
    })),
    { ...rawTool(), inputSchema: { type: "object", properties: { query: { type: "string" }, q: { type: "string" } } } },
    { ...rawTool(), inputSchema: { type: "object", properties: { query: { type: "string" }, nested: { type: "object" } } } },
  ];
  for (const raw of rejected) expect(knowledgeToolView(raw)).toMatchObject({ queryField: null });
  for (const name of ["query", "q", "search", "term", "text"]) {
    expect(knowledgeToolView({ ...rawTool(), inputSchema: { type: "object",
      properties: { [name]: { type: "string" }, limit: { type: "integer", minimum: 1, default: 10 } }, required: [name] },
    }).queryField).toBe(name);
  }
});

test("catalog projection preserves raw definition hashes while hiding extra metadata", async () => {
  const tool = { ...rawTool(), outputSchema: { type: "object" }, vendor: { revision: "v1" } };
  const f = await fixture(async () => json({ object: "list", data: [{ ...source(), tools: [tool] }] }));
  const result = await f.client.sources(DID);
  expect(result[0]!.tools[0]!.definitionHash).toBe(knowledgeToolView(tool).definitionHash);
  expect(result[0]!.tools[0]).not.toHaveProperty("vendor");
});

test("unsafe issuers and path traversal identifiers cannot alter the gateway destination", async () => {
  for (const issuer of ["http://gateway.test", "https://gateway.test/prefix", "https://user:secret@gateway.test", "https://gateway.test?x=1"]) {
    await expect(fixture(async () => json({}), { issuer })).rejects.toBeInstanceOf(KnowledgeAccessError);
  }
  let calls = 0;
  const f = await fixture(async () => { calls++; return json({}); });
  for (const identifier of ["..", ".", "../account", "foo/bar", "foo\\bar", "source?override=1"]) {
    expect(() => f.client.resources(DID, identifier)).toThrow(KnowledgeAccessError);
  }
  expect(calls).toBe(0);
});
