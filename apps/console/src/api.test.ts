import { describe, expect, test } from "bun:test";
import { ApiError, ConsoleClient, UnknownWriteOutcome } from "./api.ts";

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
