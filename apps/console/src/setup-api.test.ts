import { expect, test } from "bun:test";
import { SetupClient } from "./setup-api.ts";
import { ApiError, UnknownWriteOutcome } from "./api.ts";
import { SETUP_FIXTURE } from "./fake/setup.ts";

test("setup client binds cookie requests to principal and workspace and reconciles exact operation keys", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ ...SETUP_FIXTURE, operationKey: "setup:key" });
  }) as typeof fetch;
  const api = new SetupClient("https://console.example", "", "ws_one", "did:example:one", fetcher);
  await api.start({ mode: "autonomous" }, "setup:key");
  await api.current(undefined, "setup:key");
  expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
  const headers = new Headers(calls[0]!.init.headers);
  expect(headers.get("Authorization")).toBeNull();
  expect(headers.get("X-Ephyra-Workspace")).toBe("ws_one");
  expect(headers.get("X-Ephyra-Principal")).toBe("did:example:one");
  expect(headers.get("Idempotency-Key")).toBe("setup:key");
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ mode: "autonomous" });
  expect(calls[1]!.init.method).toBe("GET");
  expect(calls[1]!.url.searchParams.get("operationKey")).toBe("setup:key");
});

test("setup client preserves ambiguous writes and rejects malformed successful results", async () => {
  for (const fetcher of [
    async () => { throw new Error("connection lost"); },
    async () => new Response("", { status: 503 }),
    async () => Response.json({ status: "ready" }),
    async () => Response.json(null),
    async () => Response.json({ ...SETUP_FIXTURE, operationKey: "another-tab" }),
  ]) {
    const api = new SetupClient("https://console.example", "token", "ws_one", "did:one", fetcher as typeof fetch);
    try { await api.start({ mode: "autonomous" }, "setup:pending"); throw new Error("write unexpectedly succeeded"); }
    catch (error) {
      expect(error).toBeInstanceOf(UnknownWriteOutcome);
      expect((error as UnknownWriteOutcome).operationKey).toBe("setup:pending");
    }
  }
});

test("setup conflict is a definite refusal and reading an absent run stays null", async () => {
  const refused = new SetupClient("https://console.example", "", "ws_one", "did:one",
    (async () => Response.json({ error: "Workspace changed" }, { status: 409 })) as typeof fetch);
  await expect(refused.start({ mode: "supervised" }, "setup:key")).rejects.toBeInstanceOf(ApiError);
  const empty = new SetupClient("https://console.example", "", "ws_one", "did:one", (async () => Response.json(null)) as typeof fetch);
  expect(await empty.current()).toBeNull();
});
