import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MemorySignalStore,
  otlpRoutes,
  parseOtlp,
  parseStack,
  redact,
} from "./index.ts";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"),
  );
describe("OTLP", () => {
  for (const name of ["node", "python", "rust"])
    test(`parses ${name} fixture`, () => {
      const result = parseOtlp(fixture(name), "logs");
      expect(result.signals[0]?.service).toBe(name);
      expect(result.signals[0]?.frames.length).toBeGreaterThan(0);
    });
  test("counts server spans and extracts exceptions", () => {
    const result = parseOtlp(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    name: "/x",
                    kind: 2,
                    status: { code: 2 },
                    events: [
                      {
                        name: "exception",
                        attributes: [
                          {
                            key: "exception.message",
                            value: { stringValue: "broken" },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      "traces",
    );
    expect(result.requests[0]?.error).toBe(true);
    expect(result.signals[0]?.message).toBe("broken");
  });
  test("routes enforce limits and deduplicate", async () => {
    const store = new MemorySignalStore();
    let called = 0;
    const app = otlpRoutes({
      store,
      quota: () => true,
      maxBodyBytes: 10000,
      onNewSignal: () => {
        called++;
      },
    });
    const send = () =>
      app.request("/v1/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fixture("node")),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(called).toBe(1);
    expect(
      (
        await app.request("/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/x-protobuf" },
        })
      ).status,
    ).toBe(415);
    const limited = otlpRoutes({
      store,
      quota: () => false,
      maxBodyBytes: 2,
      onNewSignal: () => {},
    });
    expect(
      (
        await limited.request("/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(429);
  });
});
test("Go and Rust backtraces", () => {
  expect(parseStack("main.handler()\n  /app/main.go:42 +0x1")[0]?.fn).toBe(
    "main.handler",
  );
  expect(parseStack("  0: app::main\n    at src/main.rs:7:3")[0]?.fn).toBe(
    "app::main",
  );
});
for (const sample of [
  "a@example.com",
  "Bearer abc",
  "Basic abc",
  "sk-abcdef",
  "ghp_abcdef",
  "xoxb-abcdef",
  "AKIA1234567890123456",
  "eyJabc.def.ghi",
  "127.0.0.1",
  "2001:db8::1",
  "4111 1111 1111 1111",
  "password=abc",
  "secret=abc",
  "token=abc",
]) {
  test(`redacts ${sample}`, () =>
    expect(redact(sample)).toContain("[REDACTED]"));
}
test("does not redact ordinary numbers", () =>
  expect(redact("order 1234567890123456")).toBe("order 1234567890123456"));
