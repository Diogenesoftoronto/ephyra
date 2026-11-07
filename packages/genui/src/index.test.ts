import { expect, test } from "bun:test";
import { catalog, validateVelumSpec, velumPrompt } from "./index.ts";

const spec = { root: "note", elements: { note: { type: "Note", props: { text: "hello" }, children: [] } } };
test("validates the catalog and structural references", () => {
  expect(validateVelumSpec(spec)).toEqual({ spec });
  expect(validateVelumSpec({ ...spec, root: "missing" })).toHaveProperty("reason");
  expect(validateVelumSpec({ root: "x", elements: { x: { type: "Unknown", props: {}, children: [] } } }))
    .toHaveProperty("reason");
  expect(validateVelumSpec({ ...spec, action: "evil" })).toHaveProperty("reason");
  expect(validateVelumSpec({ ...spec, extra: "x".repeat(100_001) })).toHaveProperty("reason");
});
test("prompt names Velum and the catalog", () => {
  expect(velumPrompt("policy")).toContain("Velum");
  expect(catalog.actionNames.sort()).toEqual(["apply_to_draft", "ask_velum", "discard"]);
});
