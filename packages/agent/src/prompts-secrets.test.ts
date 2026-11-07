import { expect, test } from "bun:test";
import { renderPrompt } from "./prompts.ts";
import { secretEnvValues } from "./redact.ts";

const task = (logs: string) => ({
  step: "research" as const, trail: { id: "00000000-0000-4000-8000-000000000001" } as never,
  untrusted: { logs }, context: { note: "fix it" }, budget: { tokens: 1, wallclockS: 1 },
});

test("secret env values never reach the prompt, even unlabelled (eval finding: harness_redaction)", () => {
  const env = { EPHYRA_CONVEX_SECRET: "c0nvex-s3cret-value", OPENAI_API_KEY: "plain-looking-key-123", HOME: "/home/user-not-secret" };
  const secrets = secretEnvValues(env);
  expect(secrets).toContain("c0nvex-s3cret-value");
  expect(secrets).not.toContain("/home/user-not-secret");
  const out = renderPrompt(task("private value c0nvex-s3cret-value and plain-looking-key-123 in /home/user-not-secret"), secrets);
  expect(out).not.toContain("c0nvex-s3cret-value");
  expect(out).not.toContain("plain-looking-key-123");
  expect(out).toContain("/home/user-not-secret");
});

test("credential shapes are redacted without being told the value", () => {
  const out = renderPrompt(task("Authorization: bearer abc.def.ghi and sk-ABCDEFGHIJKLMNOP1234"), []);
  expect(out).not.toContain("abc.def.ghi");
  expect(out).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
});
