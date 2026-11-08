import { expect, test } from "bun:test";
import type { PolicyActivationReceipt } from "@ephyra/core";
import { ConsoleClient, UnknownWriteOutcome } from "./api.ts";

const receipt: PolicyActivationReceipt = { schema: 1, draftId: "reviewed-policy", path: "autonomy.md", sourceCommit: "a".repeat(40),
  sourceDigest: "b".repeat(64), principal: "did:example:owner", at: "2026-11-08T12:00:00Z", previousActive: null,
  requestDigest: "c".repeat(64), documents: [{ path: "autonomy.md", digest: "b".repeat(64) }], commit: "d".repeat(40) };

test("policy activation binds the reviewed content and active version to an authenticated keyed write", async () => {
  const requests: { path: string; init: RequestInit | undefined }[] = [];
  const client = new ConsoleClient("https://console.example", "", async (url, init) => {
    requests.push({ path: new URL(String(url)).pathname, init });
    return Response.json(receipt);
  }, "did:example:owner", "workspace-exact");
  const input = { expectedCommit: receipt.sourceCommit, expectedDigest: receipt.sourceDigest, expectedActive: null };
  expect(await client.activatePolicy("reviewed-policy", input, "activation-intent-123")).toEqual(receipt);
  const request = requests[0]!;
  expect(request.path).toBe("/v1/drafts/reviewed-policy/activate");
  expect(request.init?.method).toBe("POST");
  expect(JSON.parse(String(request.init?.body))).toEqual(input);
  expect(request.init?.headers).toMatchObject({ "Idempotency-Key": "activation-intent-123",
    "X-Ephyra-Principal": "did:example:owner", "X-Ephyra-Workspace": "workspace-exact" });
  await client.activePolicy();
  expect(requests[1]!.path).toBe("/v1/policy/active");
  expect(requests[1]!.init?.method).toBe("GET");
  expect(requests[1]!.init?.body).toBeUndefined();
});

test("an unreadable successful activation preserves the operation key and never retries automatically", async () => {
  let writes = 0;
  const client = new ConsoleClient("https://console.example", "", async () => {
    writes++; return Response.json({ ...receipt, commit: "not-a-commit" });
  });
  await expect(client.activatePolicy("reviewed-policy", { expectedCommit: receipt.sourceCommit,
    expectedDigest: receipt.sourceDigest, expectedActive: null }, "unknown-activation-123"))
    .rejects.toMatchObject({ operationKey: "unknown-activation-123" });
  expect(writes).toBe(1);
  const disconnected = new ConsoleClient("https://console.example", "", async () => { throw new Error("lost response"); });
  await expect(disconnected.activatePolicy("reviewed-policy", { expectedCommit: receipt.sourceCommit,
    expectedDigest: receipt.sourceDigest, expectedActive: null }, "disconnected-activation-123"))
    .rejects.toBeInstanceOf(UnknownWriteOutcome);
});
