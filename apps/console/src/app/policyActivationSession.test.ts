import { expect, test } from "bun:test";
import type { Draft, PolicyActivationReceipt } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome, type ActivatePolicyInput, type ConsoleApi } from "../api.ts";
import { PolicyActivationSession, policyContentDigest } from "./policyActivationSession.ts";

const draft: Draft = { id: "published-policy", path: "intents/checkout.md", kind: "intent", content: "# Checkout\nReturn a receipt.\n",
  baseDigest: "b".repeat(64), warnings: [], status: "published", createdBy: "did:example:owner", createdAt: "2026-11-08T12:00:00Z",
  updatedAt: "2026-11-08T12:00:00Z", messages: [], published: { ref: "refs/ephyra/policy/published-policy", commit: "a".repeat(40),
    by: "did:example:owner", at: "2026-11-08T12:00:00Z" } };

async function fixture() {
  const writes: { input: ActivatePolicyInput; op: string }[] = [];
  const digest = await policyContentDigest(draft.content);
  const receipt: PolicyActivationReceipt = { schema: 1, draftId: draft.id, path: draft.path, sourceCommit: draft.published!.commit,
    sourceDigest: digest, principal: "did:example:owner", at: "2026-11-08T12:00:00Z", previousActive: null,
    requestDigest: "c".repeat(64), documents: [{ path: draft.path, digest }], commit: "d".repeat(40) };
  let active: PolicyActivationReceipt | null = null;
  let failure: "unknown" | "forbidden" | null = null;
  const api = {
    activePolicy: async () => active,
    activatePolicy: async (_id: string, input: ActivatePolicyInput, op: string) => {
      writes.push({ input, op });
      if (failure === "unknown") throw new UnknownWriteOutcome(op);
      if (failure === "forbidden") throw new ApiError(403);
      active = { ...receipt, previousActive: input.expectedActive }; return active;
    },
  } as unknown as ConsoleApi;
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); } };
  return { api, receipt, writes, storage, memory, failure: (value: typeof failure) => { failure = value; },
    active: (value: typeof active) => { active = value; } };
}

test("activation sends the exact published digest and observed active version, and updates only on a matching receipt", async () => {
  const f = await fixture();
  const before = { ...f.receipt, draftId: "older-policy", documents: [], commit: "e".repeat(40) };
  f.active(before);
  const session = new PolicyActivationSession(f.api, draft.id, "owner:workspace", f.storage);
  await session.load(draft);
  await session.activate(draft);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.input).toEqual({ expectedCommit: draft.published!.commit, expectedDigest: f.receipt.sourceDigest, expectedActive: before.commit });
  expect(session.getSnapshot()).toMatchObject({ status: "ready", current: true });
  expect(session.getSnapshot().pending).toBeUndefined();
  expect(f.memory.size).toBe(0);
});

test("an interrupted activation survives reload, blocks another write and reconciles only by reading active policy", async () => {
  const f = await fixture(); f.failure("unknown");
  const session = new PolicyActivationSession(f.api, draft.id, "owner:workspace", f.storage);
  await session.load(draft);
  await expect(session.activate(draft)).rejects.toBeInstanceOf(UnknownWriteOutcome);
  const pending = session.getSnapshot().pending;
  const restored = new PolicyActivationSession(f.api, draft.id, "owner:workspace", f.storage);
  await restored.load(draft);
  expect(restored.getSnapshot().pending).toEqual(pending);
  await expect(restored.activate(draft)).rejects.toThrow("Review");
  const isolated = new PolicyActivationSession(f.api, draft.id, "different-owner:workspace", f.storage);
  expect(isolated.getSnapshot().pending).toBeUndefined();
  f.active(f.receipt);
  await restored.load(draft);
  expect(restored.getSnapshot()).toMatchObject({ current: true, pending: undefined });
  expect(f.writes).toHaveLength(1);
});

test("later activations retain the desired document without inventing confirmation of an old request", async () => {
  const f = await fixture(); f.failure("unknown");
  const session = new PolicyActivationSession(f.api, draft.id, "owner:workspace", f.storage);
  await session.load(draft);
  await expect(session.activate(draft)).rejects.toBeInstanceOf(UnknownWriteOutcome);
  f.active({ ...f.receipt, draftId: "different-document", path: "autonomy.md", sourceCommit: "f".repeat(40), commit: "e".repeat(40) });
  await session.load(draft);
  expect(session.getSnapshot().current).toBe(true);
  expect(session.getSnapshot().active?.draftId).toBe("different-document");
  expect(session.getSnapshot().pending).toBeUndefined();
  expect(f.writes).toHaveLength(1);
});

test("a definite rejection requires fresh review, while a mismatched successful receipt remains uncertain", async () => {
  const f = await fixture(); f.failure("forbidden");
  const session = new PolicyActivationSession(f.api, draft.id, "owner:workspace", f.storage);
  await session.load(draft);
  await expect(session.activate(draft)).rejects.toBeInstanceOf(ApiError);
  expect(session.getSnapshot().pending).toBeUndefined();
  await expect(session.activate(draft)).rejects.toThrow("Review");
  f.failure(null);
  f.api.activatePolicy = async () => ({ ...f.receipt, sourceCommit: "f".repeat(40) });
  await session.load(draft);
  await expect(session.activate(draft)).rejects.toBeInstanceOf(UnknownWriteOutcome);
  expect(session.getSnapshot().pending).toBeDefined();
});

test("older read responses cannot replace a newer observed active policy", async () => {
  const f = await fixture();
  const pending: ((value: PolicyActivationReceipt | null) => void)[] = [];
  f.api.activePolicy = () => new Promise((resolve) => pending.push(resolve));
  const session = new PolicyActivationSession(f.api, draft.id, "owner:workspace", f.storage);
  const old = session.load(draft), current = session.load(draft);
  pending[1]!(f.receipt); await current;
  pending[0]!(null); await old;
  expect(session.getSnapshot().current).toBe(true);
  expect(session.getSnapshot().active).toEqual(f.receipt);
});

test("a fixture or older server without activation support stays explicitly unavailable", async () => {
  const session = new PolicyActivationSession({} as ConsoleApi, draft.id, "unsupported", undefined);
  await session.load(draft);
  expect(session.getSnapshot().status).toBe("unavailable");
  await expect(session.activate(draft)).rejects.toThrow("Review");
});
