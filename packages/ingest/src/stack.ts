import type { StackFrame } from "@ephyra/core";
import { redact } from "./redact.ts";

export function parseStack(stack: string, repoRoot?: string): StackFrame[] {
  const frames: StackFrame[] = [];
  let pendingFunction: string | undefined;
  for (const line of stack.split("\n")) {
    const python = line.match(/^\s*File "([^"]+)", line (\d+), in (.+)$/);
    const node = line.match(
      /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?\s*$/,
    );
    const native = line.match(
      /^\s*(?:(.*?)\s+at\s+)?(\S+\.(?:rs|go)):(\d+)(?::(\d+))?/,
    );
    if (!python && !node && !native) {
      const fn = line.match(
        /^\s*(?:\d+:\s*)?([\w./:$<>~*()-]+)(?:\([^)]*\))?\s*$/,
      );
      if (fn) pendingFunction = fn[1]?.replace(/\(\)$/, "");
      continue;
    }
    let file = python ? python[1]! : (node ?? native)![2]!;
    const fn = python ? python[3] : (node ?? native)![1] || pendingFunction;
    const lineNumber = Number(python ? python[2] : (node ?? native)![3]);
    const column = python ? undefined : (node ?? native)![4];
    file = file.replace(/^file:\/\//, "");
    const root = repoRoot?.replace(/\/$/, "");
    if (root && file.startsWith(root + "/")) file = file.slice(root.length + 1);
    const inApp =
      !/(?:node_modules|site-packages|\/rustc\/|\.cargo\/registry|\/pkg\/mod\/|\/go\/src\/|^node:|^<)/.test(
        file,
      );
    frames.push({
      file: redact(file),
      fn: fn ? redact(fn) : undefined,
      line: lineNumber,
      column: column ? Number(column) : undefined,
      inApp,
    });
    pendingFunction = undefined;
  }
  return frames;
}
