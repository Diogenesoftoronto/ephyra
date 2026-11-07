// Velum's specs are untrusted output. `readSpec` is the only way a spec reaches the renderer:
// a spec that fails any check is dropped, and callers show a note instead of the spec.
import { catalog } from "./catalog.local.ts";

export type FormState = Record<string, unknown>;
export type ReadSpec =
  | { ok: true; spec: ValidSpec; state: FormState }
  | { ok: false; reason: string };
/** The catalog-validated spec (typed loosely: the renderer takes the validated data as is). */
export type ValidSpec = Parameters<typeof import("@json-render/react").Renderer>[0]["spec"] & {};

export const MAX_ELEMENTS = 120;
export const MAX_DEPTH = 8;
const MAX_STATE_BYTES = 20_000;

function plainState(value: unknown): FormState | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  let text: string;
  try { text = JSON.stringify(value); } catch { return null; }
  if (text.length > MAX_STATE_BYTES) return null;
  return JSON.parse(text, (key, v) => (key === "__proto__" || key === "constructor" ? undefined : v)) as FormState;
}

function treeProblem(spec: { root: string; elements: Record<string, { children?: string[] }> }): string | null {
  const keys = Object.keys(spec.elements);
  if (keys.length > MAX_ELEMENTS) return "too many fields";
  if (!spec.elements[spec.root]) return "missing root";
  const seen = new Set<string>();
  const walk = (key: string, depth: number): string | null => {
    if (depth > MAX_DEPTH) return "nested too deeply";
    if (seen.has(key)) return "a field appears twice";
    seen.add(key);
    const el = spec.elements[key];
    if (!el) return "a field points at something that does not exist";
    for (const child of el.children ?? []) {
      const problem = walk(child, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  return walk(spec.root, 0);
}

const SEGMENT = "(?!__)[A-Za-z0-9_-]{1,40}";
const BIND_PATH = new RegExp(`^/${SEGMENT}(?:/${SEGMENT}){0,4}$`);

/** The catalog lets json-render expression objects through any prop. Only `value: { $bindState: "/a/b" }` is allowed. */
function expressionProblem(spec: { elements: Record<string, { props?: Record<string, unknown> }> }): string | null {
  const hasDollar = (v: unknown): boolean =>
    typeof v === "object" && v !== null && (Object.keys(v).some((k) => k.startsWith("$")) || Object.values(v).some(hasDollar));
  for (const el of Object.values(spec.elements)) {
    for (const [name, v] of Object.entries(el.props ?? {})) {
      if (!hasDollar(v)) continue;
      const keys = typeof v === "object" && v !== null ? Object.keys(v) : [];
      const path = (v as { $bindState?: unknown }).$bindState;
      if (name !== "value" || keys.length !== 1 || keys[0] !== "$bindState" || typeof path !== "string" || !BIND_PATH.test(path)) {
        return "computed values are not allowed";
      }
    }
  }
  return null;
}

export function readSpec(raw: unknown): ReadSpec {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not a form" };
  const checked = catalog.validate(raw);
  if (!checked.success || !checked.data) return { ok: false, reason: "unknown fields or values" };
  const problem = treeProblem(checked.data as never) ?? expressionProblem(checked.data as never);
  if (problem) return { ok: false, reason: problem };
  // The standard schema strips `state`. Initial values are read from the raw spec, as plain JSON only.
  const state = plainState((raw as { state?: unknown }).state);
  if (!state) return { ok: false, reason: "initial values are not plain data" };
  return { ok: true, spec: checked.data as ValidSpec, state };
}
