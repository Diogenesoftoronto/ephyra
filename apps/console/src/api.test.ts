import { describe, expect, test } from "bun:test";
import { ApiError, ConsoleClient, UnknownWriteOutcome } from "./api.ts";
import { FakeApi } from "./fake/api.ts";

describe("console HTTP client", () => {
  test("validates server data and sends the session token", async () => {
    let authorization = "";
    const fetcher: typeof fetch = async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).Authorization!;
      return Response.json([{ id: "not an activity" }]);
    };
    const client = new ConsoleClient("https://example.test", "session", fetcher);
    await expect(client.activity()).rejects.toThrow();
    expect(authorization).toBe("Bearer session");
  });
  test("preserves an ambiguous write's operation key", async () => {
    const client = new ConsoleClient("https://example.test", "session", async () => {
      throw new Error("offline");
    });
    try {
      await client.createDraft("autonomy.md", "op-1");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownWriteOutcome);
      expect((error as UnknownWriteOutcome).operationKey).toBe("op-1");
    }
  });
  test("surfaces conflicts", async () => {
    const client = new ConsoleClient(
      "https://example.test",
      "session",
      async () => new Response(null, { status: 409 }),
    );
    await expect(client.createDraft("autonomy.md", "op-2")).rejects.toBeInstanceOf(ApiError);
  });
});

test("malformed successful write replies remain ambiguous and retain their operation key", async () => {
  const client = new ConsoleClient("https://example.test", "session", async () => new Response("{broken"));
  const failure = await client.createDraft("autonomy.md", "same-operation").catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(UnknownWriteOutcome);
  expect((failure as UnknownWriteOutcome).operationKey).toBe("same-operation");
});

test("checkpoint writes send the binding the human reviewed", async () => {
  let body: unknown;
  const client = new ConsoleClient("https://example.test", "session", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  });
  const bound = { rev: 3, head: "a".repeat(40), proofDigest: "sha256:" + "b".repeat(64) };
  await client.decide("trail", { checkpoint: "C", verdict: "approve", bound }, "review");
  expect(body).toEqual({ checkpoint: "C", verdict: "approve", bound });
});

test("trail reads carry authentication, abort signal, and bypass caches", async () => {
  const fake = new FakeApi();
  const id = (await fake.inbox())[0]!.trailId;
  const detail = await fake.trail(id);
  const ctl = new AbortController();
  let received: RequestInit | undefined;
  const client = new ConsoleClient("https://example.test", "session", async (_url, init) => {
    received = init;
    return Response.json(detail);
  }, "principal");
  expect(await client.trail(id, ctl.signal)).toEqual(detail);
  expect(received?.signal).toBe(ctl.signal);
  expect(received?.cache).toBe("no-store");
  expect(received?.headers).toMatchObject({ Authorization: "Bearer session", "X-Ephyra-Principal": "principal" });
});

test("operation reconciliation is a validated authenticated GET, never a retry", async () => {
  const calls: { url: string; method?: string }[] = [];
  const client = new ConsoleClient("https://example.test", "session", async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return Response.json({ status: "recorded" });
  });
  expect(await client.trailOperation("trail/a", "comment", "key?+&")).toEqual({ status: "recorded" });
  expect(calls).toEqual([{ url: "https://example.test/v1/trails/trail%2Fa/operations/comment?key=key%3F%2B%26", method: "GET" }]);
  const invalid = new ConsoleClient("https://example.test", "session", async () => Response.json({ status: "probably" }));
  await expect(invalid.trailOperation("a", "claim", "k")).rejects.toThrow();
});

test("normal and streaming requests invoke fetch without a ConsoleClient receiver", async () => {
  const receivers: unknown[] = [];
  const fetcher: typeof fetch = async function (this: unknown, url) {
    receivers.push(this);
    return String(url).includes("/events")
      ? new Response('event: end\ndata: {"status":"done"}\n\n')
      : Response.json({ principal: "did:example:a", kind: "human", approver: true });
  };
  const client = new ConsoleClient("https://example.test", "fixture", fetcher);
  await client.identity();
  await client.watchRun("run", -1, new AbortController().signal, () => undefined);
  expect(receivers).toEqual([undefined, undefined]);
});

test("a server failure after a shared write remains an unconfirmed keyed operation", async () => {
  const client = new ConsoleClient("https://example.test", "fixture", async () => new Response(null, { status: 500 }));
  const error = await client.trailAction("trail", "comment", { text: "Review note" }, "saved-intent").catch((e) => e);
  expect(error).toBeInstanceOf(UnknownWriteOutcome);
  expect(error.operationKey).toBe("saved-intent");
});
