import { expect, test } from "bun:test";
import fc from "fast-check";
import { readConfig } from "../config.ts";
import { hostingStatus } from "./hosting.ts";

test("host execution requires an explicit account grant and complete provider configuration", () => {
  const base = { EPHYRA_API_TOKEN: "fixture-service-token", EPHYRA_HOSTED_RUNNER: "railway",
    EPHYRA_RAILWAY_TOKEN: "fixture-host-token", EPHYRA_RAILWAY_ENVIRONMENT_ID: "environment-fixture" };
  expect(hostingStatus(readConfig(base), "did:plc:alice").configured).toBe(false);
  const config = readConfig({ ...base, EPHYRA_HOSTED_ACCOUNTS: "did:plc:alice" });
  expect(hostingStatus(config, "did:plc:alice").configured).toBe(true);
  expect(hostingStatus(config, "did:plc:alice2").configured).toBe(false);
  expect(hostingStatus(readConfig({ ...base, EPHYRA_HOSTED_ACCOUNTS: "*" }), "did:plc:bob").configured).toBe(true);
  const { EPHYRA_RAILWAY_TOKEN: _token, ...missingToken } = base;
  expect(hostingStatus(readConfig({ ...missingToken, EPHYRA_HOSTED_ACCOUNTS: "*" }), "did:plc:bob").configured).toBe(false);
  expect(config.EPHYRA_RAILWAY_IDLE_MINUTES).toBe(5);
  expect(config.EPHYRA_RAILWAY_MEMORY_MB).toBe(2000);
  expect(JSON.stringify(hostingStatus(config, "did:plc:alice"))).not.toContain(base.EPHYRA_RAILWAY_TOKEN);
});

test("partial DID matches never grant another account the host's execution allowance", () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z]{3,12}$/), (name) => {
    const did = `did:plc:${name}`;
    const config = readConfig({ EPHYRA_API_TOKEN: "fixture-service-token", EPHYRA_HOSTED_RUNNER: "railway",
      EPHYRA_RAILWAY_TOKEN: "fixture-host-token", EPHYRA_RAILWAY_ENVIRONMENT_ID: "fixture", EPHYRA_HOSTED_ACCOUNTS: did });
    expect(hostingStatus(config, `${did}x`).configured).toBe(false);
  }));
});
