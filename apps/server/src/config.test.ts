import { expect, test } from "bun:test";
import { readConfig } from "./config.ts";

const base = { EPHYRA_API_TOKEN: "t".repeat(32) };
test("EPHYRA_DRAFT defaults to none and each BYOK adapter needs its key", () => {
  expect(readConfig(base).EPHYRA_DRAFT).toBe("none");
  expect(() => readConfig({ ...base, EPHYRA_DRAFT: "anthropic" })).toThrow("EPHYRA_DRAFT_ANTHROPIC_API_KEY");
  expect(() => readConfig({ ...base, EPHYRA_DRAFT: "openai" })).toThrow("EPHYRA_DRAFT_OPENAI_API_KEY");
  expect(readConfig({ ...base, EPHYRA_DRAFT: "anthropic", EPHYRA_DRAFT_ANTHROPIC_API_KEY: "k" }).EPHYRA_DRAFT).toBe("anthropic");
  expect(readConfig({ ...base, EPHYRA_DRAFT: "fake" }).EPHYRA_DRAFT).toBe("fake");
  expect(() => readConfig({ ...base, EPHYRA_DRAFT: "gemini" })).toThrow();
});
test("hosted Velum needs sign-in and a billing account like the other hosted models", () => {
  expect(() => readConfig({ ...base, EPHYRA_DRAFT: "notorganic" })).toThrow("sign-in");
  const signIn = { EPHYRA_PUBLIC_ORIGIN: "https://ephyra.example.test", EPHYRA_SESSION_KEY: "k".repeat(32) };
  expect(() => readConfig({ ...base, ...signIn, EPHYRA_DRAFT: "notorganic" })).toThrow("EPHYRA_BILLING_DID");
  expect(readConfig({ ...base, ...signIn, EPHYRA_DRAFT: "notorganic", EPHYRA_APPROVER_DIDS: "did:plc:a" }).EPHYRA_DRAFT).toBe("notorganic");
});
test("the console directory defaults to apps/console/dist", () => {
  expect(readConfig(base).EPHYRA_CONSOLE_DIR).toEndWith("apps/console/dist");
});
