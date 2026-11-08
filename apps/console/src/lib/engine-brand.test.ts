import { expect, test } from "bun:test";
import fc from "fast-check";
import { engineBrand } from "./engine-brand.ts";

test("model names, lookalike harnesses and missing identities do not claim an agent brand", () => {
  for (const engine of [null, undefined, "", "ampersand", "codex-local", "CLAUDE-CODE", "runner/codex",
    "claude-opus-5-5", "gpt-6-codex", "__proto__", "constructor", "unknown/amp/smart"]) {
    expect(engineBrand(engine)).toBeNull();
  }
});

test("a model suffix cannot change the identity of a recognized harness", () => {
  fc.assert(fc.property(fc.string(), (suffix) => {
    expect(engineBrand(`amp/${suffix}`)?.id).toBe("amp");
    expect(engineBrand(`codex/${suffix}`)?.id).toBe("codex");
    expect(engineBrand(`claude-code/${suffix}`)?.id).toBe("claude");
  }));
});

test("unknown prefixes cannot borrow a recognized brand from their suffix", () => {
  fc.assert(fc.property(fc.string().filter((prefix) => !["amp", "codex", "claude-code"].includes(prefix.split("/")[0]!)),
    (prefix) => { expect(engineBrand(`${prefix}/codex/amp/claude-code`)).toBeNull(); }));
});
