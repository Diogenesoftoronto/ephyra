import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { KnowledgeUpdate, KnowledgeSelection } from "../src/knowledge.ts";

const source = { id: "notes", resources: true };
describe("knowledge opt-in contracts", () => {
  test("disabled knowledge never retains a capability and sources must be distinct", () => {
    expect(KnowledgeUpdate.safeParse({ expectedVersion: 0, workspaceId: "a", enabled: false, sources: [source] }).success).toBe(false);
    expect(KnowledgeUpdate.safeParse({ expectedVersion: 0, workspaceId: "a", enabled: true, sources: [source, source] }).success).toBe(false);
    expect(KnowledgeSelection.safeParse({ id: "notes", resources: false }).success).toBe(false);
    expect(KnowledgeSelection.safeParse({ ...source, token: "never" }).success).toBe(false);
  });
  test("every accepted selection carries explicit resource or exact-tool authority", () => {
    fc.assert(fc.property(fc.boolean(), fc.option(fc.record({
      name: fc.string({ minLength: 1, maxLength: 40 }),
      definitionHash: fc.constant("a".repeat(64)),
      queryField: fc.constant("query"),
    }), { nil: undefined }), (resources, searchTool) => {
      const value = KnowledgeSelection.safeParse({ id: "notes", resources, searchTool });
      expect(value.success).toBe(resources || searchTool !== undefined);
      if (value.success && searchTool) expect(value.data.searchTool).toEqual(searchTool);
    }));
  });
});
