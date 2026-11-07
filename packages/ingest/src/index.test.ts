import { test, expect } from "bun:test";
import fc from "fast-check";
import {
  fingerprint,
  parseStack,
  redact,
  toSignal,
  MemorySignalStore,
} from "./index.ts";
test("fingerprint ignores frame line changes", () =>
  fc.assert(
    fc.property(fc.nat(), fc.nat(), (a, b) =>
      expect(
        fingerprint({
          frames: [{ file: "src/a.ts", fn: "f", line: a, inApp: true }],
        }),
      ).toBe(
        fingerprint({
          frames: [{ file: "src/a.ts", fn: "f", line: b, inApp: true }],
        }),
      ),
    ),
  ));
test("fingerprint ignores numeric values", () =>
  fc.assert(
    fc.property(fc.nat(), fc.nat(), (a, b) =>
      expect(fingerprint({ message: `failure ${a}` })).toBe(
        fingerprint({ message: `failure ${b}` }),
      ),
    ),
  ));
test("redaction removes common secrets", () => {
  for (const x of [
    "a@b.com",
    "Bearer abc",
    "sk-abcdef",
    "ghp_abcdef",
    "xoxb-abcdef",
    "AKIA1234567890123456",
    "eyJabc.def.ghi",
    "192.168.1.1",
    "4111 1111 1111 1111",
    "password=hunter2",
    "secret=foo",
  ])
    expect(redact(x)).not.toContain(x);
});
test("parses Node and Python frames", () => {
  expect(
    parseStack(
      '    at run (/repo/src/a.ts:12:4)\n  File "/repo/foo.py", line 5, in work',
      "/repo",
    ),
  ).toEqual([
    { file: "src/a.ts", fn: "run", line: 12, column: 4, inApp: true },
    { file: "foo.py", fn: "work", line: 5, column: undefined, inApp: true },
  ]);
});
test("store tracks occurrences and coverage", async () => {
  const store = new MemorySignalStore();
  const s = toSignal({
    repo: "r",
    message: "bad",
    frames: [{ file: "a.ts", inApp: true }],
    at: "2026-01-01T00:00:00.000Z",
  });
  expect((await store.upsert(s)).isNew).toBe(true);
  expect((await store.upsert(s)).isNew).toBe(false);
  expect(await store.countSince(s.fingerprint, new Date("2025-01-01"))).toBe(2);
  expect(
    (await store.newFingerprintsInFiles(["a.ts"], new Date("2025-01-01")))
      .length,
  ).toBe(1);
  expect(await store.errorRate("/", new Date(0), new Date())).toBeNull();
});

test("fingerprints ignore UUID and number tokens", () => {
  fc.assert(
    fc.property(fc.uuid(), fc.uuid(), fc.nat(), fc.nat(), (a, b, x, y) => {
      expect(fingerprint({ message: `failure ${a} count ${x}` })).toBe(
        fingerprint({ message: `failure ${b} count ${y}` }),
      );
    }),
  );
});
test("fingerprints ignore line and column across three application frames", () => {
  fc.assert(
    fc.property(
      fc.array(fc.nat(), { minLength: 6, maxLength: 6 }),
      (numbers) => {
        const frames = ["a", "b", "c"].map((file, i) => ({
          file,
          fn: "run",
          inApp: true,
          line: numbers[i],
          column: numbers[i + 3],
        }));
        expect(fingerprint({ exceptionType: "Error", frames })).toBe(
          fingerprint({
            exceptionType: "Error",
            frames: frames.map((frame) => ({ ...frame, line: 1, column: 2 })),
          }),
        );
      },
    ),
  );
});
