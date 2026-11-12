import { expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, appManifest, convertManifest, githubAppConfig, installationToken, verifyInstallation } from "./github-app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const config = { appId: "123", slug: "ephyra-test", privateKey: pem };

test("the feature flag needs all three values, and accepts a PEM with escaped newlines", () => {
  expect(githubAppConfig({})).toBeNull();
  expect(githubAppConfig({ EPHYRA_GITHUB_APP_ID: "1", EPHYRA_GITHUB_APP_SLUG: "x" })).toBeNull();
  expect(githubAppConfig({ EPHYRA_GITHUB_APP_ID: "1", EPHYRA_GITHUB_APP_SLUG: "x", EPHYRA_GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") })!
    .privateKey).toBe(pem);
  expect(() => githubAppConfig({ EPHYRA_GITHUB_APP_ID: "abc", EPHYRA_GITHUB_APP_SLUG: "x", EPHYRA_GITHUB_APP_PRIVATE_KEY: pem })).toThrow();
});

test("the app JWT is RS256, issued in the past, expires within ten minutes, and verifies with the app's key", () => {
  const now = Date.parse("2026-11-12T00:00:00Z");
  const [head, body, sig] = appJwt(config, now).split(".");
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
  expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  expect(claims.iss).toBe("123");
  expect(claims.iat).toBeLessThan(now / 1000);
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  expect(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
});

test("the manifest asks only for what landing uses, with no webhook", () => {
  const m = appManifest("https://console.ephyra.quest");
  expect(m.default_permissions).toEqual({ contents: "write", pull_requests: "write", checks: "read", statuses: "read", metadata: "read" });
  expect(m.hook_attributes.active).toBe(false);
  expect(m.setup_url).toBe("https://console.ephyra.quest/github/install/callback");
});

test("an installation is trusted only when GitHub says it covers the repository; tokens are scoped to that one repository", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const github = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/repos/acme/app/installation")) return new Response(JSON.stringify({ id: 77, account: { login: "acme" } }));
    if (url.endsWith("/repos/acme/other/installation")) return new Response("{}", { status: 404 });
    if (url.endsWith("/app/installations/77/access_tokens")) return new Response(JSON.stringify({ token: "ghs_installation" }), { status: 201 });
    return new Response("{}", { status: 404 });
  };
  expect(await verifyInstallation(config, "77", "acme/app", github)).toEqual({ installationId: "77", account: "acme" });
  await expect(verifyInstallation(config, "78", "acme/app", github)).rejects.toThrow("does not cover");
  await expect(verifyInstallation(config, "77", "acme/other", github)).rejects.toThrow("not installed");
  await expect(verifyInstallation(config, "../1", "acme/app", github)).rejects.toThrow();
  expect(await installationToken(config, "77", "acme/app", github)).toBe("ghs_installation");
  const minted = JSON.parse(String(calls.at(-1)!.init!.body));
  expect(minted).toEqual({ repositories: ["app"], permissions: { contents: "write", pull_requests: "write", checks: "read", statuses: "read" } });
  expect(new Headers(calls.at(-1)!.init!.headers).get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

test("manifest conversion returns the new app's id, slug and key", async () => {
  const github = async () => new Response(JSON.stringify({ id: 9, slug: "ephyra-x", pem, html_url: "https://github.com/apps/ephyra-x" }), { status: 201 });
  expect(await convertManifest("abc123", github)).toMatchObject({ appId: "9", slug: "ephyra-x", privateKey: pem });
  await expect(convertManifest("bad code!", github)).rejects.toThrow();
});
