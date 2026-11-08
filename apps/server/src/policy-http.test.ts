import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Draft, PolicyActivationReceipt, PolicyDoc } from "@ephyra/core";
import { AUTONOMY_TEMPLATE } from "@ephyra/policy";
import { compose, type Composed } from "./compose.ts";
import { readConfig } from "./config.ts";
import { sha256 } from "./docs.ts";

const token = "policy-http-offline-token-00000000";
const headers = { Authorization: `Bearer ${token}`, "X-Ephyra-Principal": "fixture-owner", "Content-Type": "application/json" };
const directories: string[] = [];
const servers: Composed[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-policy-http-"));
  directories.push(directory);
  const file = join(directory, "autonomy.md");
  await writeFile(file, AUTONOMY_TEMPLATE);
  const config = readConfig({ EPHYRA_API_TOKEN: token, EPHYRA_DATA_DIR: join(directory, "data"), EPHYRA_AUTONOMY_FILE: file });
  let server = await compose(config, { startJobs: false });
  servers.push(server);
  const send = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => server.app.request(path, {
    method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const draft = async (path: string, content: string) => {
    const opened = await send("POST", "/v1/drafts", { path });
    expect(opened.status).toBe(200);
    const initial = Draft.parse(await opened.json());
    const edited = await send("PUT", `/v1/drafts/${initial.id}/content`, { content, baseDigest: initial.baseDigest });
    expect(edited.status).toBe(200);
    const published = await send("POST", `/v1/drafts/${initial.id}/publish`);
    expect(published.status).toBe(200);
    return Draft.parse(await published.json());
  };
  const request = (value: Draft, expectedActive: string | null = null) => ({
    expectedCommit: value.published!.commit, expectedDigest: sha256(value.content), expectedActive,
  });
  const active = async () => {
    const response = await send("GET", "/v1/policy/active");
    expect(response.status).toBe(200);
    const value: unknown = await response.json();
    return value === null ? null : PolicyActivationReceipt.parse(value);
  };
  return { send, draft, request, active, current: () => server,
    restart: async () => {
      await server.close();
      server = await compose(config, { startJobs: false });
      servers.push(server);
      return server;
    } };
}

test("composed HTTP publication requires explicit bound activation and reloads durable active policy after restart", async () => {
  const f = await fixture();
  expect((await f.current().app.request("/v1/policy/active")).status).toBe(401);
  expect(await f.active()).toBeNull();
  const content = AUTONOMY_TEMPLATE.replace("risk: medium", "risk: high");
  const published = await f.draft("autonomy.md", content);
  expect(published.status).toBe("published");
  expect(await f.active()).toBeNull();
  expect(f.current().ctx.policy.autonomy.areas.find(area => area.name === "cart")!.risk).toBe("medium");
  const path = `/v1/drafts/${published.id}/activate`;
  const body = f.request(published);
  expect((await f.send("POST", path, body)).status).toBe(400);
  expect((await f.send("POST", path, { ...body, expectedDigest: "f".repeat(64) },
    { "Idempotency-Key": "activate-wrong-digest" })).status).toBe(409);
  expect((await f.send("POST", path, { ...body, expectedCommit: "0".repeat(40) },
    { "Idempotency-Key": "activate-wrong-source" })).status).toBe(409);
  expect((await f.send("POST", path, { ...body, expectedActive: "a".repeat(40) },
    { "Idempotency-Key": "activate-wrong-active" })).status).toBe(409);
  const key = { "Idempotency-Key": "activate-reviewed-autonomy" };
  const activated = await f.send("POST", path, body, key);
  expect(activated.status).toBe(200);
  const receipt = PolicyActivationReceipt.parse(await activated.json());
  expect(receipt).toMatchObject({ sourceCommit: published.published!.commit, sourceDigest: sha256(content), previousActive: null });
  const repeated = await f.send("POST", path, body, key);
  expect(repeated.status).toBe(200);
  expect(PolicyActivationReceipt.parse(await repeated.json())).toEqual(receipt);
  expect(f.current().ctx.policy.autonomy.areas.find(area => area.name === "cart")!.risk).toBe("high");
  const effective = await f.send("GET", "/v1/docs/autonomy.md");
  expect(PolicyDoc.parse(await effective.json())).toMatchObject({ content, digest: sha256(content) });
  const restored = await f.restart();
  expect(await f.active()).toEqual(receipt);
  expect(restored.ctx.policy.autonomy.areas.find(area => area.name === "cart")!.risk).toBe("high");
  const restoredDoc = await f.send("GET", "/v1/docs/autonomy.md");
  expect(PolicyDoc.parse(await restoredDoc.json()).content).toBe(content);
}, 20_000);

test("HTTP activation CAS refuses stale documents and old operation replay cannot replace newer active policy", async () => {
  const f = await fixture();
  const a = await f.draft("autonomy.md", AUTONOMY_TEMPLATE.replace("risk: medium", "risk: high"));
  const stale = await f.draft("autonomy.md", AUTONOMY_TEMPLATE.replace("risk: medium", "risk: low"));
  const aKey = { "Idempotency-Key": "activate-first-version" };
  const first = await f.send("POST", `/v1/drafts/${a.id}/activate`, f.request(a), aKey);
  expect(first.status).toBe(200);
  const firstReceipt = PolicyActivationReceipt.parse(await first.json());
  const staleActivation = await f.send("POST", `/v1/drafts/${stale.id}/activate`, f.request(stale, firstReceipt.commit),
    { "Idempotency-Key": "activate-stale-document" });
  expect(staleActivation.status).toBe(409);
  expect((await f.active())!.commit).toBe(firstReceipt.commit);
  const intent = await f.draft("intents/checkout.md", "# Checkout\n\nA completed order exposes its recorded receipt.\n");
  expect((await f.send("POST", `/v1/drafts/${intent.id}/activate`, f.request(intent),
    { "Idempotency-Key": "activate-stale-pointer" })).status).toBe(409);
  const next = await f.send("POST", `/v1/drafts/${intent.id}/activate`, f.request(intent, firstReceipt.commit),
    { "Idempotency-Key": "activate-current-intent" });
  expect(next.status).toBe(200);
  const secondReceipt = PolicyActivationReceipt.parse(await next.json());
  const replayed = await f.send("POST", `/v1/drafts/${a.id}/activate`, f.request(a), aKey);
  expect(replayed.status).toBe(200);
  expect(PolicyActivationReceipt.parse(await replayed.json())).toEqual(firstReceipt);
  expect((await f.active())!.commit).toBe(secondReceipt.commit);
  expect((await f.send("POST", `/v1/drafts/${a.id}/activate`, { ...f.request(a), expectedDigest: "f".repeat(64) }, aKey)).status).toBe(409);
  const documents = await f.send("GET", "/v1/docs");
  const listed = (await documents.json() as unknown[]).map(value => PolicyDoc.parse(value));
  expect(listed.find(value => value.path === "intents/checkout.md")!.content).toBe(intent.content);
  expect(listed.find(value => value.path === "autonomy.md")!.content).toBe(a.content);
  await f.restart();
  expect((await f.active())!.commit).toBe(secondReceipt.commit);
  expect(f.current().ctx.policy.autonomy.areas.find(area => area.name === "cart")!.risk).toBe("high");
  expect(PolicyDoc.parse(await (await f.send("GET", "/v1/docs/intents/checkout.md")).json()).content).toBe(intent.content);
}, 20_000);
