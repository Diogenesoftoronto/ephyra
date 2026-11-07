import { test, expect } from "bun:test";
import { ParserExtract, Registry, UnknownAlias, defaultAccessTokenProvider } from "../src/index.ts";
import { Unverified } from "@ephyra/core";
import fc from "fast-check";

test("parser finds Node, Python and Rust application frames with spans", async () => {
  const parser = new ParserExtract();
  for (const state of ["TypeError: bad\n at run (src/main.ts:12:3)", "Traceback\n File \"src/app.py\", line 42\nValueError: bad", "Error: bad\n at src/main.rs:42:2"]) {
    const result = await parser.extract({ state, fields: { top_app_frame: { type: "text", instructions: "" }, touched_files: { type: "list", instructions: "" } } }, { idempotencyKey: "key" });
    const answer = result.answers.top_app_frame!;
    expect(state.slice(...answer.span!)).toEqual(answer.value as string);
    expect(result.answers.touched_files!.value).toEqual([answer.value]);
  }
});
test("parser spans always refer to source", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), async state => {
    const result = await new ParserExtract().extract({ state, fields: { exception_type: { type: "text", instructions: "" } } }, { idempotencyKey: "k" });
    const answer = result.answers.exception_type!;
    if (answer.span) expect(state.slice(...answer.span)).toEqual(answer.value as string);
  }));
});
test("registry fails closed for unknown aliases", () => {
  const registry = new Registry({ backends: [], purposes: { extract: "missing" } }, new Map());
  expect(() => registry.resolve("extract")).toThrow(UnknownAlias);
  expect(() => defaultAccessTokenProvider()).toThrow(Unverified);
});
