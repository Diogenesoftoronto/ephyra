import { expect, test } from "bun:test";
import { compose } from "./compose.ts";

const config = { EPHYRA_API_TOKEN: "t".repeat(32), PORT: 3000 };

test("memory mode boots and reports health", async () => {
  const { app, mode } = await compose(config, {});
  expect(mode).toBe("memory");
  const res = await app.request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, mode: "memory" });
});

test("API and OTLP ingest require the bearer token", async () => {
  const { app } = await compose(config, {});
  expect((await app.request("/v1/inbox")).status).toBe(401);
  const otlp = await app.request("/otlp/v1/logs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(otlp.status).toBe(401);
  const ok = await app.request("/v1/inbox", {
    headers: { Authorization: `Bearer ${config.EPHYRA_API_TOKEN}`, "X-Ephyra-Principal": "test" },
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual([]);
});
