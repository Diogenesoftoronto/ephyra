import { expect, test } from "bun:test";
import { AccountClient } from "./account-api.ts";
import { ApiError, UnknownWriteOutcome } from "./api.ts";
import { ACCOUNT_FIXTURE } from "./fake/account.ts";
import { KNOWLEDGE_CATALOG_FIXTURE, KNOWLEDGE_SELECTION_FIXTURE } from "./fake/knowledge.ts";

const update = { expectedVersion: 0, workspaceId: ACCOUNT_FIXTURE.workspaceId, enabled: true, sources: KNOWLEDGE_SELECTION_FIXTURE };

test("knowledge reads and saves bind the account, workspace selection, version and exact tool definition", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const api = new AccountClient("https://console.example", "", (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(init.method === "GET" ? KNOWLEDGE_CATALOG_FIXTURE : {
      ...ACCOUNT_FIXTURE, version: 1, knowledge: { ...update, updatedAt: "2026-11-08T12:00:00.000Z" },
    });
  }) as typeof fetch, ACCOUNT_FIXTURE.did);
  expect((await api.knowledge()).sources[0]!.tools[0]!.definitionHash).toBe("a".repeat(64));
  await api.saveKnowledge(update, "account-knowledge-fixture");
  for (const { url, init } of calls) {
    expect(url.pathname).toBe("/v1/account/knowledge");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("X-Ephyra-Account")).toBe(ACCOUNT_FIXTURE.did);
    expect(new Headers(init.headers).has("Authorization")).toBeFalse();
  }
  expect(calls[0]!.init.method).toBe("GET");
  expect(calls[1]!.init.method).toBe("PUT");
  expect(new Headers(calls[1]!.init.headers).get("Idempotency-Key")).toBe("account-knowledge-fixture");
  expect(JSON.parse(calls[1]!.init.body as string)).toEqual(update);
});

test("knowledge save keeps ambiguous outcomes keyed; revoked or stale configuration is a definite refusal", async () => {
  for (const fetcher of [
    async () => { throw new Error("network interruption"); },
    async () => Response.json({}, { status: 503 }),
    async () => Response.json({ unexpected: "success shape" }),
  ]) {
    const api = new AccountClient("https://console.example", "", fetcher as typeof fetch, ACCOUNT_FIXTURE.did);
    try { await api.saveKnowledge(update, "account-uncertain"); throw new Error("unexpected success"); }
    catch (error) {
      expect(error).toBeInstanceOf(UnknownWriteOutcome);
      expect((error as UnknownWriteOutcome).operationKey).toBe("account-uncertain");
    }
  }
  const refused = new AccountClient("https://console.example", "", (async () => Response.json({ error: "Tool changed" }, { status: 409 })) as typeof fetch);
  await expect(refused.saveKnowledge(update, "account-stale")).rejects.toBeInstanceOf(ApiError);
});

test("malformed knowledge catalog cannot become selectable source data", async () => {
  const api = new AccountClient("https://console.example", "", (async () => Response.json({
    ...KNOWLEDGE_CATALOG_FIXTURE,
    sources: [{ ...KNOWLEDGE_CATALOG_FIXTURE.sources[0]!, tools: [{ name: "search", definitionHash: "unbound" }] }],
  })) as typeof fetch);
  await expect(api.knowledge()).rejects.toThrow("Account settings could not be read");
});
