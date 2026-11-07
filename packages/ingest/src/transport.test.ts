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

test("body limits reject declared and streamed oversize before parsing", async () => {
  const app = otlpRoutes({
    store: new MemorySignalStore(),
    quota: () => true,
    maxBodyBytes: 4,
    onNewSignal: () => {},
  });
  let pulled = false;
  const declared = new Request("http://localhost/v1/logs", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "100" },
    body: new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
  });
  expect((await app.fetch(declared)).status).toBe(413);
  expect(pulled).toBe(false);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("123"));
      controller.enqueue(new TextEncoder().encode("456"));
      controller.close();
    },
  });
  expect(
    (
      await app.fetch(
        new Request("http://localhost/v1/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: stream,
        }),
      )
    ).status,
  ).toBe(413);
});

test("partial success counts malformed records", async () => {
  const app = otlpRoutes({
    store: new MemorySignalStore(),
    quota: () => true,
    maxBodyBytes: 10000,
    onNewSignal: () => {},
  });
  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              null,
              { severityNumber: 17, body: { stringValue: "failure" } },
            ],
          },
        ],
      },
    ],
  };
  const response = await app.request("/v1/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    partialSuccess: { rejectedLogRecords: number };
  };
  expect(result.partialSuccess.rejectedLogRecords).toBe(1);
});

test("muted signals notify after expiry and after a quiet gap", async () => {
  const store = new MemorySignalStore();
  const item = fixture("node");
  const record = item.resourceLogs[0].scopeLogs[0].logRecords[0];
  const fp = parseOtlp(item, "logs").signals[0]!.fingerprint;
  await store.mute(fp, new Date("2023-11-14T22:14:00Z"));
  let calls = 0;
  const app = otlpRoutes({
    store,
    quota: () => true,
    maxBodyBytes: 10000,
    gapMs: 60000,
    onNewSignal: () => {
      calls++;
    },
  });
  const send = async (ms: number) => {
    record.timeUnixNano = String(BigInt(ms) * 1000000n);
    return app.request("/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
    });
  };
  await send(Date.parse("2023-11-14T22:13:20Z"));
  expect(calls).toBe(0);
  await send(Date.parse("2023-11-14T22:14:01Z"));
  expect(calls).toBe(1);
  await send(Date.parse("2023-11-14T22:14:02Z"));
  expect(calls).toBe(1);
  await send(Date.parse("2023-11-14T22:16:00Z"));
  expect(calls).toBe(2);
});

test("Go goroutine frames preserve relative application and runtime paths", () => {
  const frames = parseStack(
    `goroutine 18 [running]:
example.com/app/handler.ServeHTTP(0xc00010)
    /repo/internal/handler/serve.go:42 +0x31
net/http.(*Server).Serve(0xc00020)
    /usr/local/go/src/net/http/server.go:123 +0x20`,
    "/repo",
  );
  expect(frames).toHaveLength(2);
  expect(frames[0]).toMatchObject({
    file: "internal/handler/serve.go",
    line: 42,
    inApp: true,
  });
  expect(frames[1]).toMatchObject({
    file: "/usr/local/go/src/net/http/server.go",
    line: 123,
    inApp: false,
  });
});
