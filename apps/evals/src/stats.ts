/** All quality denominators exclude null/unavailable observations. */
export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function probabilities(ps: number[]) {
  if (ps.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error("invalid probability");
}
export function brier(ps: number[], ys: boolean[]): number | null {
  probabilities(ps);
  if (ps.length !== ys.length) throw new Error("length mismatch");
  return mean(ps.map((p, i) => (p - Number(ys[i])) ** 2));
}
export function reliability(ps: number[], ys: boolean[], bins = 10) {
  probabilities(ps);
  if (ps.length !== ys.length || !Number.isInteger(bins) || bins < 1)
    throw new Error("invalid calibration input");
  return Array.from({ length: bins }, (_, i) => {
    const indices = ps.flatMap((p, j) => (Math.min(bins - 1, Math.floor(p * bins)) === i ? [j] : []));
    return {
      lower: i / bins,
      upper: (i + 1) / bins,
      n: indices.length,
      probability: mean(indices.map((j) => ps[j]!)),
      frequency: mean(indices.map((j) => Number(ys[j]))),
    };
  });
}
export function ece(ps: number[], ys: boolean[], bins = 10): number | null {
  const table = reliability(ps, ys, bins);
  return ps.length
    ? table.reduce((n, b) => n + b.n * Math.abs((b.probability ?? 0) - (b.frequency ?? 0)), 0) / ps.length
    : null;
}
export function confusion(expected: string[], actual: string[]) {
  if (expected.length !== actual.length) throw new Error("length mismatch");
  const matrix: Record<string, Record<string, number>> = Object.create(null);
  expected.forEach((e, i) => {
    const row = matrix[e] ?? (matrix[e] = Object.create(null));
    row[actual[i]!] = (row[actual[i]!] ?? 0) + 1;
  });
  return matrix;
}
export function accuracy(expected: string[], actual: string[]) {
  if (expected.length !== actual.length) throw new Error("length mismatch");
  return mean(expected.map((e, i) => Number(e === actual[i])));
}
/** Deterministic percentile bootstrap, expanded to contain the point estimate. Descriptive, not population proof. */
export function bootstrap(xs: number[], iterations = 1000) {
  if (xs.some((x) => !Number.isFinite(x)) || iterations < 1) throw new Error("invalid bootstrap input");
  const point = mean(xs);
  if (point === null) return { n: 0, point: null, low: null, high: null };
  let seed = 0xabc123;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const draws = Array.from({ length: iterations }, () =>
    mean(xs.map(() => xs[Math.floor(random() * xs.length)]!))!,
  ).sort((a, b) => a - b);
  return {
    n: xs.length,
    point,
    low: Math.min(point, draws[Math.floor(iterations * 0.025)]!),
    high: Math.max(point, draws[Math.min(iterations - 1, Math.floor(iterations * 0.975))]!),
  };
}
