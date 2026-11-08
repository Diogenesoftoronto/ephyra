import { expect, test } from "bun:test";
import { readWorkspaceChoice, rememberWorkspace } from "./workspace-selection.ts";
test("workspace choice survives reload, stays account-bound and follows an owner's deliberate repository change", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value) } as Storage;
  rememberWorkspace(storage, "alice", "alice-personal", "shared");
  expect(readWorkspaceChoice(storage, "alice", "alice-personal")).toBe("shared");
  expect(readWorkspaceChoice(storage, "bob", "bob-personal")).toBe("bob-personal");
  // A missing/revoked choice remains explicit so the caller can show access ended, never choose a neighbor.
  expect(readWorkspaceChoice(storage, "alice", "alice-new-personal")).toBe("shared");
  rememberWorkspace(storage, "alice", "alice-personal", "alice-personal");
  expect(readWorkspaceChoice(storage, "alice", "alice-new-personal")).toBe("alice-new-personal");
});
