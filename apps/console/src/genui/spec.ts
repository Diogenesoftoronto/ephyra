// Velum's specs are untrusted output. `readSpec` is the only way a spec reaches the renderer: a spec that fails any check
// is dropped, and callers show a note instead of the spec. The server has already validated it (`validateVelumSpec`);
// the browser checks again with the same catalog (`@ephyra/genui`) because it must not trust the network either.
import { catalog } from "@ephyra/genui";
import type { Renderer } from "@json-render/react";

export type FormValues = Record<string, unknown>;
type SpecProp = Parameters<typeof Renderer>[0]["spec"] & {};
export type ValidSpec = SpecProp;
export type ReadSpec = { ok: true; spec: ValidSpec; fields: FormField[] } | { ok: false; reason: string };
/** A form field: where it writes (`path`, from the spec), the pointer it is held under in form state, and its first value. */
export type FormField = { path: string; pointer: string; initial: unknown };

export const MAX_ELEMENTS = 120;
export const MAX_DEPTH = 8;
const MAX_PATH = 160;

/** An injective, json-pointer-safe key for a policy path such as `area.billing.risk`. */
export function pointerFor(path: string): string {
  return `/p_${[...path].map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch : `_${ch.charCodeAt(0).toString(16)}_`)).join("")}`;
}

type El = { type?: string; props?: Record<string, unknown>; children?: string[] };
type Tree = { root: string; elements: Record<string, El> };

function treeProblem(spec: Tree): string | null {
  if (Object.keys(spec.elements).length > MAX_ELEMENTS) return "too many fields";
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

/** json-render lets expression objects (`{ $state }`, `{ $computed }`…) through any prop. Forms here carry plain values only. */
const hasExpression = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  (Object.keys(v).some((k) => k.startsWith("$")) || Object.values(v).some(hasExpression));

export function readSpec(raw: unknown): ReadSpec {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not a form" };
  const checked = catalog.validate(raw);
  if (!checked.success || !checked.data) return { ok: false, reason: "unknown fields or values" };
  const tree = checked.data as unknown as Tree;
  const problem = treeProblem(tree);
  if (problem) return { ok: false, reason: problem };
  const fields: FormField[] = [];
  const paths = new Set<string>();
  for (const el of Object.values(tree.elements)) {
    if (hasExpression(el.props)) return { ok: false, reason: "computed values are not allowed" };
    const path = el.props?.path;
    if (path === undefined) continue;
    if (typeof path !== "string" || path === "" || path.length > MAX_PATH || path.includes("__proto__"))
      return { ok: false, reason: "a field has a bad path" };
    if (paths.has(path)) return { ok: false, reason: "two fields write to the same place" };
    paths.add(path);
    fields.push({ path, pointer: pointerFor(path), initial: el.props?.value });
  }
  return { ok: true, spec: checked.data as ValidSpec, fields };
}

/** The values to send: each field's path and its current value, read from form state. */
export function collectValues(fields: readonly FormField[], state: Record<string, unknown>): FormValues {
  const out: FormValues = {};
  for (const f of fields) out[f.path] = state[f.pointer.slice(1)];
  return out;
}

/** Initial form state (one entry per field, keyed by pointer without the slash). */
export const initialState = (fields: readonly FormField[]): Record<string, unknown> =>
  Object.fromEntries(fields.map((f) => [f.pointer.slice(1), f.initial]));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const isEdited = (fields: readonly FormField[], state: Record<string, unknown>): boolean =>
  fields.some((f) => !same(state[f.pointer.slice(1)], f.initial));
