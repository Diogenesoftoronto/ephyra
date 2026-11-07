// json-render specs of the kind Velum sends (fictional), following the real catalog in packages/genui: every field has a
// `label`, a `path` (where it writes in the policy) and a plain `value`. The invalid ones exist to prove the console drops
// them without showing them.
import type { AreaForm } from "./autonomy.ts";
import { watchText } from "./autonomy.ts";

const f = (type: string, label: string, path: string, value: unknown) => ({
  type,
  props: { label, path, value },
  children: [] as string[],
});

export function areaFormSpec(a: AreaForm, note?: string): unknown {
  const p = (k: string) => `area.${a.name}.${k}`;
  return {
    root: "form",
    elements: {
      form: {
        type: "Section",
        props: { title: `Area: ${a.name}` },
        children: [
          "name",
          "paths",
          "risk",
          "matrix",
          "landing",
          "watch",
          "uf",
          "budget",
          ...(note ? ["note"] : []),
        ],
      },
      name: f("TextField", "Area name", p("name"), a.name),
      paths: f("PathList", "Paths", p("paths"), a.paths),
      risk: f("RiskSelect", "Risk", p("risk"), a.risk),
      matrix: f("CheckpointMatrix", "Checkpoints", p("checkpoints"), a.checkpoints),
      landing: f("LandingModes", "May land by", p("landing"), a.landing),
      watch: f("Duration", "Watch after landing", p("watch"), watchText(a.watchSeconds)),
      uf: f("Toggle", "User facing", p("user_facing"), a.userFacing),
      budget: f(
        "BudgetField",
        "Monthly voxq budget",
        p("voxq_budget_usd"),
        `${Math.round(a.voxqMicrousd / 1_000_000)}/month`,
      ),
      ...(note ? { note: { type: "Note", props: { text: note }, children: [] } } : {}),
    },
  };
}

export function checkpointFormSpec(area: string, checkpoints: AreaForm["checkpoints"]): unknown {
  return {
    root: "form",
    elements: {
      form: {
        type: "Section",
        props: { title: `Checkpoints for ${area}` },
        children: ["warn", "matrix", "diff"],
      },
      warn: {
        type: "Note",
        props: { text: "Blocking C means nothing lands in this area without a named approver." },
        children: [],
      },
      matrix: f("CheckpointMatrix", "Checkpoints", `area.${area}.checkpoints`, checkpoints),
      diff: {
        type: "DiffPreview",
        props: {
          before: "checkpoints: A=advisory B=advisory C=advisory",
          after: "checkpoints: A=advisory B=advisory C=blocking",
        },
        children: [],
      },
    },
  };
}

/** Unknown component, a computed expression, a missing child, and a spec that is not an object. */
export const INVALID_SPECS: Record<string, unknown> = {
  "unknown component": {
    root: "a",
    elements: { a: { type: "RunShell", props: { cmd: "rm -rf /" }, children: [] } },
  },
  "computed value": {
    root: "a",
    elements: {
      a: { type: "TextField", props: { label: "x", path: "p", value: { $computed: "env" } }, children: [] },
    },
  },
  "missing child": {
    root: "a",
    elements: { a: { type: "Section", props: { title: "x" }, children: ["ghost"] } },
  },
  "not a form": "<img src=x onerror=alert(1)>",
};
