import { describe, expect, test } from "bun:test";
import { areaFormSpec, checkpointFormSpec, INVALID_SPECS } from "../fake/specs.ts";
import { ACTION_NAMES, COMPONENT_NAMES, catalog } from "./catalog.local.ts";
import { MAX_ELEMENTS, readSpec } from "./spec.ts";

const form = { name: "billing", paths: ["a/**"], risk: "high", userFacing: true, checkpoints: { A: "advisory", B: "advisory", C: "blocking" },
  landing: ["trail_ref"], watchSeconds: 7200, voxqMicrousd: 0 } as const;

describe("spec reading", () => {
  test("the catalog has exactly the contract's components and actions", () => {
    expect([...COMPONENT_NAMES].sort()).toEqual(["BudgetField", "CheckpointMatrix", "DiffPreview", "Duration", "LandingModes", "Note",
      "PathList", "RiskSelect", "Section", "TextField", "Toggle"]);
    expect([...ACTION_NAMES].sort()).toEqual(["apply_to_draft", "ask_velum", "discard"]);
    expect(catalog.prompt()).toContain("CheckpointMatrix");
  });
  test("valid specs are accepted and keep their initial state", () => {
    for (const raw of [areaFormSpec({ ...form }, "note"), checkpointFormSpec("payments", form.checkpoints)]) {
      const r = readSpec(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(Object.keys(r.state)).toContain("area");
    }
  });
  test("invalid specs are dropped", () => {
    for (const [name, raw] of Object.entries(INVALID_SPECS)) expect([name, readSpec(raw).ok]).toEqual([name, false]);
  });
  test("expressions other than a plain bind, bad paths, huge or cyclic trees and huge state are dropped", () => {
    type Loose = { elements: Record<string, { props: Record<string, unknown>; children: string[] }>; state: unknown };
    const base = () => structuredClone(areaFormSpec({ ...form })) as Loose;
    const a = base(); a.elements.name!.props.value = { $bindState: "/__proto__/x" };
    const b = base(); b.elements.name!.props.label = { $state: "/area/name" };
    const c = base(); c.elements.form!.children = ["form"];
    const d = base(); for (let i = 0; i < MAX_ELEMENTS; i++) d.elements[`x${i}`] = { type: "Note", props: { tone: "info", text: "x" }, children: [] } as never;
    const e = base(); e.state = { big: "x".repeat(30_000) };
    const f = base(); f.state = [1];
    for (const spec of [a, b, c, d, e, f]) expect(readSpec(spec).ok).toBe(false);
  });
  test("state keeps no prototype keys", () => {
    const spec = areaFormSpec({ ...form }) as { state: Record<string, unknown> };
    spec.state = JSON.parse('{"area":{"name":"x","__proto__":{"polluted":1}}}');
    const r = readSpec(spec);
    expect(r.ok && Object.keys((r.state.area as object))).toEqual(["name"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
