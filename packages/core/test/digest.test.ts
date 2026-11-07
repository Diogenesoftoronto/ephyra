import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { canonicalJson, proofDigest, sha256Hex } from "../src/digest.ts";

describe("digest", () => {
  test("sha256Hex matches node:crypto, including multi-block and non-ASCII input", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "jellyfish ü 🪼"]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (s) => {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }));
  });
  test("proofDigest is key-order independent and uses canonical JSON", () => {
    const a = { b: 1, a: [1, { y: 2, x: undefined }] };
    const b = { a: [1, { y: 2 }], b: 1 };
    expect(proofDigest(a)).toBe(proofDigest(b));
    expect(proofDigest(a)).toBe(`sha256:${createHash("sha256").update(canonicalJson(b)).digest("hex")}`);
  });
});
