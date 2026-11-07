import { parse as parseYaml } from "yaml";
export type Threshold = {
  duplicate: number;
  regression: number;
  conflict: number;
  actionable: number;
  ignore: number;
  severity: number;
  confidence: number;
};
export const DEFAULT_THRESHOLDS: Threshold = {
  duplicate: 0.7,
  regression: 0.7,
  conflict: 0.6,
  actionable: 0.4,
  ignore: 0.8,
  severity: 2.5,
  confidence: 0.5,
};
export type Thresholds = Record<string, Threshold>;
export function parseThresholds(yaml: string): Thresholds {
  const value: unknown = parseYaml(yaml);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("thresholds must be a mapping");
  return Object.fromEntries(
    Object.entries(value).map(([id, v]) => {
      if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error(`invalid thresholds for ${id}`);
      const t = { ...DEFAULT_THRESHOLDS, ...v };
      for (const [k, n] of Object.entries(t))
        if (
          !(k in DEFAULT_THRESHOLDS) ||
          typeof n !== "number" ||
          !Number.isFinite(n) ||
          n < 0 ||
          n > (k === "severity" ? 4 : 1)
        )
          throw new Error(`invalid threshold ${id}.${k}`);
      return [id, t];
    }),
  );
}
