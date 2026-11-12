import { expect, test } from "bun:test";
import { SecretBox, type Fetch } from "../auth/crypto";
import { NotOrganicSignIn } from "../auth/notorganic";
import { fakeNotOrganic } from "../auth/notorganic.fixture";
import { MemoryAuthStore } from "../auth/store";
import { MemoryAccountStore } from "./account-store";
import { Accounts } from "./accounts";

const DID = "did:plc:alice";
const CODE_KEY = "sk-openai-coding-key-123456";
const REVIEW_KEY = "sk-openai-review-key-654321";

async function fixture() {
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url: String(url), auth, body: String(init?.body ?? "") });
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }] }));
    const model = JSON.parse(String(init?.body)).model;
    return new Response(JSON.stringify({ model, choices: [{ message: { content: "ok" } }], usage: { total_tokens: 3 } }));
  };
  const box = await SecretBox.fromBase64(Buffer.alloc(32, 7).toString("base64"));
  const fake = fakeNotOrganic({ approved: true, product: "ephyra", did: DID });
  const signIn = new NotOrganicSignIn({ issuer: "https://api.notorganic.test", authorizationUrl: "https://id.notorganic.test/authorize",
    publicOrigin: "https://ephyra.example", product: "ephyra", scopes: [] }, new MemoryAuthStore(), box, fake.fetcher);
  const service = new Accounts({ store: new MemoryAccountStore(), box, operationSecret: "fixture-secret", dataDir: "/tmp/ephyra-role-models",
    signIn, fetcher, repository: { prepare: async () => { throw new Error("unused"); } } });
  return { service, calls };
}

test("review uses the coding model until a review model is saved, then its own model and key; removing it falls back", async () => {
  const f = await fixture();
  let s = await f.service.saveModel(DID, { expectedVersion: 0, provider: "openai", model: "gpt-6.1-sol", apiKey: CODE_KEY }, "model-code-0001");
  const ws = s.workspaceId;
  expect((await f.service.modelFor(DID, ws, "review"))!.requestedModel).toBe("gpt-6.1-sol");

  s = await f.service.saveRoleModel(DID, { expectedVersion: s.version, role: "review", provider: "openai", model: "gpt-6-astra",
    apiKey: REVIEW_KEY }, "model-review-001");
  expect(s.roleModels?.review).toMatchObject({ provider: "openai", model: "gpt-6-astra", keyConfigured: true, status: "verified" });
  expect(JSON.stringify(s)).not.toContain(REVIEW_KEY);
  const review = (await f.service.modelFor(DID, ws, "review"))!;
  const code = (await f.service.modelFor(DID, ws, "code"))!;
  expect([review.requestedModel, code.requestedModel]).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
  await review.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 } as never);
  await code.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 } as never);
  const completions = f.calls.filter((c) => c.url.endsWith("/chat/completions"));
  expect(completions.map((c) => [JSON.parse(c.body).model, c.auth])).toEqual([
    ["gpt-6-astra", `Bearer ${REVIEW_KEY}`], ["gpt-6.1-sol", `Bearer ${CODE_KEY}`]]);

  s = await f.service.saveRoleModel(DID, { expectedVersion: s.version, role: "review", provider: "none", model: "" }, "model-review-002");
  expect(s.roleModels).toBeUndefined();
  expect((await f.service.modelFor(DID, ws, "review"))!.requestedModel).toBe("gpt-6.1-sol");
});
