import { describe, expect, test } from "bun:test";
import { catalog } from "@ephyra/genui";
import { areaFormSpec, checkpointFormSpec, INVALID_SPECS } from "../fake/specs.ts";
import { collectValues, initialState, isEdited, MAX_ELEMENTS, pointerFor, readSpec } from "./spec.ts";
import { parseDuration } from "./fields.tsx";

const form = {
  name: "billing",
  paths: ["a/**"],
  risk: "high",
  userFacing: true,
  checkpoints: { A: "advisory", B: "advisory", C: "blocking" },
  landing: ["trail_ref"],
  watchSeconds: 7200,
  voxqMicrousd: 0,
} as const;
type Loose = { elements: Record<string, { props: Record<string, unknown>; children: string[] }> };
const base = () => structuredClone(areaFormSpec({ ...form })) as Loose;

describe("spec reading (real catalog)", () => {
  test("the catalog has exactly the contract's components and actions", () => {
    expect([...catalog.componentNames].sort()).toEqual([
      "BudgetField",
      "CheckpointMatrix",
      "DiffPreview",
      "Duration",
      "LandingModes",
      "Note",
      "PathList",
      "RiskSelect",
      "Section",
      "TextField",
      "Toggle",
    ]);
    expect([...catalog.actionNames].sort()).toEqual(["apply_to_draft", "ask_velum", "discard"]);
  });
  test("valid specs are accepted and each field is found by its path", () => {
    const r = readSpec(areaFormSpec({ ...form }, "note"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.map((f) => f.path)).toContain("area.billing.risk");
    expect(readSpec(checkpointFormSpec("payments", form.checkpoints)).ok).toBe(true);
  });
  test("invalid specs are dropped", () => {
    for (const [name, raw] of Object.entries(INVALID_SPECS))
      expect([name, readSpec(raw).ok]).toEqual([name, false]);
  });
  test("expressions, prototype paths, shared paths, huge or cyclic trees are dropped", () => {
    const a = base();
    a.elements.name!.props.path = "__proto__";
    const b = base();
    b.elements.risk!.props.path = b.elements.name!.props.path;
    const c = base();
    c.elements.form!.children = ["form"];
    const d = base();
    for (let i = 0; i < MAX_ELEMENTS; i++)
      d.elements[`x${i}`] = { props: { text: "x" }, children: [], type: "Note" } as never;
    const e = base();
    e.elements.name!.props.value = { $state: "/x" };
    for (const spec of [a, b, c, d, e]) expect(readSpec(spec).ok).toBe(false);
  });
  test("form state: values come back by path, and editing is detected", () => {
    const r = readSpec(areaFormSpec({ ...form }));
    if (!r.ok) throw new Error("expected a valid spec");
    const state = initialState(r.fields);
    expect(isEdited(r.fields, state)).toBe(false);
    expect(collectValues(r.fields, state)["area.billing.risk"]).toBe("high");
    const risk = r.fields.find((f) => f.path === "area.billing.risk")!;
    const next = { ...state, [risk.pointer.slice(1)]: "critical" };
    expect(isEdited(r.fields, next)).toBe(true);
    expect(collectValues(r.fields, next)["area.billing.risk"]).toBe("critical");
  });
  test("pointers are injective and pointer-safe", () => {
    const paths = ["area.a.b", "area_a_b", "area.a-b", "a/b", "a b"];
    const pointers = paths.map(pointerFor);
    expect(new Set(pointers).size).toBe(paths.length);
    expect(pointers.every((p) => /^\/p_[A-Za-z0-9_]+$/.test(p))).toBe(true);
  });
  test("durations are the policy's own text", () => {
    expect(parseDuration("2h")).toEqual({ amount: 2, unit: "h" });
    expect(parseDuration("0h")).toBeNull();
    expect(parseDuration("two hours")).toBeNull();
  });
});
