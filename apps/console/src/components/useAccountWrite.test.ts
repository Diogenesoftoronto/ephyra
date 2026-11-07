import { expect, test } from "bun:test";
import { AccountOperation } from "./useAccountWrite.ts";
import { FakeAccountApi, ACCOUNT_FIXTURE, CONNECTED_ACCOUNT_FIXTURE } from "../fake/account.ts";
import { ApiError, UnknownWriteOutcome } from "../api.ts";

test("an explicit retry keeps the operation key until the intent changes", () => {
  const operation = new AccountOperation();
  const intent = { expectedVersion: 0, provider: "openai", model: "fixture", apiKey: "fixture-secret" };
  const original = operation.key(intent);
  expect(operation.key({ ...intent })).toBe(original);
  const changed = operation.key({ ...intent, apiKey: "replacement-secret" });
  expect(changed).not.toBe(original);
  expect(operation.key({ ...intent, apiKey: "replacement-secret" })).toBe(changed);
  expect(operation.key({ ...intent, expectedVersion: 1 })).not.toBe(changed);
  operation.clear();
  expect(operation.key(intent)).not.toBe(original);
});

test("fixture saves are idempotent, versioned, and never return credentials", async () => {
  const api = new FakeAccountApi();
  const input = { expectedVersion: 0, provider: "openai" as const, model: "fixture", apiKey: "fixture-secret" };
  const saved = await api.saveModel(input, "one-intent");
  expect(saved.version).toBe(1);
  expect(saved.model.keyConfigured).toBe(true);
  expect(saved.model.status).toBe("saved");
  expect(JSON.stringify(saved)).not.toContain("fixture-secret");
  expect(await api.saveModel(input, "one-intent")).toEqual(saved);
  await expect(api.saveModel(input, "another-intent")).rejects.toBeInstanceOf(ApiError);
  const cleared = await api.saveModel(
    { ...input, expectedVersion: 1, apiKey: undefined, clearKey: true },
    "remove-key",
  );
  expect(cleared.model.keyConfigured).toBe(false);
  expect(cleared.model.status).toBe("unavailable");
});

test("read-only refresh reveals an applied save after a simulated uncertain response", async () => {
  const api = new FakeAccountApi({ uncertainAfterSave: ["saveModel"] });
  const input = { expectedVersion: 0, provider: "none" as const, model: "" };
  await expect(api.saveModel(input, "uncertain-intent")).rejects.toBeInstanceOf(UnknownWriteOutcome);
  const refreshed = await api.settings();
  expect(refreshed.version).toBe(1);
  expect(await api.saveModel(input, "uncertain-intent")).toEqual(refreshed);
});

test("repository fixture changes isolate workspaces and do not carry another host's token", async () => {
  const initial = structuredClone(CONNECTED_ACCOUNT_FIXTURE);
  initial.repository!.credentialConfigured = true;
  const api = new FakeAccountApi({ initial });
  const saved = await api.saveRepository(
    { expectedVersion: initial.version, url: "https://other.example.org/team/repo.git", branch: "main" },
    "new-repo",
  );
  expect(saved.workspaceId).not.toBe(initial.workspaceId);
  expect(saved.repository?.credentialConfigured).toBe(false);
});

test("exploring first persists the skipped setup state and can be resumed", async () => {
  const api = new FakeAccountApi();
  const skipped = await api.onboarding({ expectedVersion: ACCOUNT_FIXTURE.version, action: "skip" }, "skip");
  expect(skipped.onboarding.status).toBe("skipped");
  const resumed = await api.onboarding({ expectedVersion: skipped.version, action: "resume" }, "resume");
  expect(resumed.onboarding.status).toBe("in_progress");
});
