// json-render specs of the kind Velum sends (fictional). Valid ones follow genui/catalog.local.ts;
// the invalid ones exist to prove the console drops them without showing them.
import type { AreaForm } from "./autonomy.ts";

const bind = (path: string) => ({ $bindState: path });

export function areaFormSpec(a: AreaForm, note?: string): unknown {
  return {
    root: "form",
    elements: {
      form: { type: "Section", props: { title: `Area: ${a.name}`, description: "Edit the fields, then apply them to the draft." },
        children: ["name", "paths", "risk", "matrix", "landing", "watch", "uf", "budget", ...(note ? ["note"] : [])] },
      name: { type: "TextField", props: { label: "Area name", value: bind("/area/name"), hint: "Used in the `## area:` heading." }, children: [] },
      paths: { type: "PathList", props: { label: "Paths", value: bind("/area/paths"), hint: "Glob patterns, one per row." }, children: [] },
      risk: { type: "RiskSelect", props: { label: "Risk", value: bind("/area/risk") }, children: [] },
      matrix: { type: "CheckpointMatrix", props: { label: "Checkpoints", value: bind("/area/checkpoints") }, children: [] },
      landing: { type: "LandingModes", props: { label: "May land by", value: bind("/area/landing") }, children: [] },
      watch: { type: "Duration", props: { label: "Watch after landing", value: bind("/area/watchSeconds") }, children: [] },
      uf: { type: "Toggle", props: { label: "User facing", value: bind("/area/userFacing"), hint: "Changes here need story proof." }, children: [] },
      budget: { type: "BudgetField", props: { label: "Monthly voxq budget", value: bind("/area/voxqMicrousd") }, children: [] },
      ...(note ? { note: { type: "Note", props: { tone: "info", text: note }, children: [] } } : {}),
    },
    state: { area: { ...a } },
  };
}

export function checkpointFormSpec(area: string, checkpoints: AreaForm["checkpoints"]): unknown {
  return {
    root: "form",
    elements: {
      form: { type: "Section", props: { title: `Checkpoints for ${area}` }, children: ["warn", "matrix", "diff"] },
      warn: { type: "Note", props: { tone: "warn", text: "Blocking C means nothing lands in this area without a named approver." }, children: [] },
      matrix: { type: "CheckpointMatrix", props: { label: "Checkpoints", value: bind("/area/checkpoints") }, children: [] },
      diff: { type: "DiffPreview", props: { title: "Today", before: "checkpoints: A=advisory B=advisory C=advisory",
        after: "checkpoints: A=advisory B=advisory C=blocking" }, children: [] },
    },
    state: { area: { name: area, checkpoints } },
  };
}

/** Unknown component, a computed expression, a missing child, and a spec that is not an object. */
export const INVALID_SPECS: Record<string, unknown> = {
  "unknown component": { root: "a", elements: { a: { type: "RunShell", props: { cmd: "rm -rf /" }, children: [] } } },
  "computed value": {
    root: "a", elements: { a: { type: "TextField", props: { label: "x", value: { $computed: "env" } }, children: [] } },
  },
  "missing child": { root: "a", elements: { a: { type: "Section", props: { title: "x" }, children: ["ghost"] } } },
  "not a form": "<img src=x onerror=alert(1)>",
};
