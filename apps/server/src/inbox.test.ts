import { expect, test } from "bun:test";
import type { InboxItem, Trail } from "@ephyra/core";
import { boundMatches } from "./inbox.ts";

test("approvals are bound to revision, head and proof digest", () => {
  const item = { bound: { rev: 2, head: "a", proofDigest: "p" } } as InboxItem;
  expect(boundMatches(item, { rev: 2, head: "a" } as Trail, "p")).toBe(true);
  expect(boundMatches(item, { rev: 3, head: "a" } as Trail, "p")).toBe(false);
  expect(boundMatches(item, { rev: 2, head: "b" } as Trail, "p")).toBe(false);
  expect(boundMatches(item, { rev: 2, head: "a" } as Trail, "q")).toBe(false);
});
