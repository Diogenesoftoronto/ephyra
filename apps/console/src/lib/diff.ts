// Line diff by longest common subsequence. Pure; used for draft changes and proposals.
export type DiffOp = { kind: "same" | "add" | "del"; text: string; aLine?: number; bLine?: number };
export type DiffRow = DiffOp | { skipped: number };

const MAX_CELLS = 4_000_000;
const lines = (s: string) => (s === "" ? [] : s.split("\n"));

export function lineDiff(before: string, after: string): DiffOp[] {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: "same", text: a[i]!, aLine: i + 1, bLine: i + 1 });
  ops.push(...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail), head));
  for (let k = tail; k > 0; k--) {
    ops.push({ kind: "same", text: a[a.length - k]!, aLine: a.length - k + 1, bLine: b.length - k + 1 });
  }
  return ops;
}

function middle(a: string[], b: string[], offset: number): DiffOp[] {
  const del = (i: number): DiffOp => ({ kind: "del", text: a[i]!, aLine: offset + i + 1 });
  const add = (j: number): DiffOp => ({ kind: "add", text: b[j]!, bLine: offset + j + 1 });
  if (a.length * b.length > MAX_CELLS || a.length === 0 || b.length === 0) {
    return [...a.map((_, i) => del(i)), ...b.map((_, j) => add(j))];
  }
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: "same", text: a[i]!, aLine: offset + i + 1, bLine: offset + j + 1 }); i++; j++; }
    else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) ops.push(del(i++));
    else ops.push(add(j++));
  }
  while (i < a.length) ops.push(del(i++));
  while (j < b.length) ops.push(add(j++));
  return ops;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  return { added: ops.filter((o) => o.kind === "add").length, removed: ops.filter((o) => o.kind === "del").length };
}

/** Collapse long unchanged runs to `context` lines around each change. */
export function withContext(ops: DiffOp[], context = 2): DiffRow[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  ops.forEach((op, i) => {
    if (keep[i]) {
      if (skipped) out.push({ skipped });
      skipped = 0;
      out.push(op);
    } else skipped++;
  });
  if (skipped) out.push({ skipped });
  return out;
}
