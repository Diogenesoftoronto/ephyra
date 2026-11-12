import { afterEach, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepository, httpsRepositoryUrl } from "../src/commands/discovery";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function directory() {
	const root = await mkdtemp(join(tmpdir(), "ephyra-discovery-"));
	roots.push(root);
	return root;
}
function git(root: string, ...args: string[]) {
	const child = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	return child.stdout.toString().trim();
}
async function repository() {
	const root = await directory();
	git(root, "init", "--initial-branch=work");
	return root;
}
async function file(root: string, path: string, content: string) {
	const target = join(root, path);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, content);
}

test("discovers the root, preferred remote and recorded default branch without changing git", async () => {
	const root = await repository();
	git(root, "remote", "add", "backup", "https://backup.example/team/app.git");
	git(root, "remote", "add", "origin", "https://name:secret@git.example/team/app.git?token=secret#secret");
	git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	await file(root, "apps/web/package.json", JSON.stringify({ dependencies: { next: "1", "@sentry/nextjs": "1" } }));
	const before = await readFile(join(root, ".git/config"), "utf8");
	const discovery = await discoverRepository(join(root, "apps/web"));
	expect(discovery).toEqual({
		root, remote: "https://git.example/team/app.git", branch: "main",
		frameworks: ["Next.js"], integrations: ["sentry"], warnings: [],
	});
	expect(await readFile(join(root, ".git/config"), "utf8")).toBe(before);
	expect(JSON.stringify(discovery)).not.toContain("secret");
});

test("reads only dependency names from Node manifests and bounded native manifests", async () => {
	const root = await repository();
	await file(root, "package.json", JSON.stringify({
		dependencies: { hono: "1", "@opentelemetry/api": "1", "posthog-node": "1", "@axiomhq/js": "1" },
		devDependencies: { "@logtail/node": "1", "dd-trace": "1", "@bugsnag/js": "1", "pino-loki": "1" },
		optionalDependencies: { "@builder.io/qwik": "1" },
		scripts: { preinstall: "touch should-not-exist", sentry: "sentry_sdk" },
		description: "firebase_crashlytics is not an installed dependency",
	}));
	await file(root, "ios/Podfile", "platform :ios, '16.0'\npod 'Sentry'\npod 'FirebaseCrashlytics'\n");
	await file(root, "android/app/build.gradle.kts", 'plugins { id("com.android.application") }\n');
	await file(root, "mobile/pubspec.yaml", "dependencies:\n  flutter:\n    sdk: flutter\n");
	await file(root, ".env", "SENTRY_AUTH_TOKEN=must-not-be-read\n");
	const discovery = await discoverRepository(root);
	expect(discovery.frameworks).toEqual(["Android", "Flutter", "Hono", "Qwik", "iOS"]);
	expect(discovery.integrations).toEqual([
		"axiom", "betterstack", "bugsnag", "crashlytics", "datadog", "loki", "otel", "posthog", "sentry",
	]);
	expect(await Bun.file(join(root, "should-not-exist")).exists()).toBe(false);
	expect(JSON.stringify(discovery)).not.toContain("must-not-be-read");
});

test("ignores secret/config contents, scripts, dependency values and unrelated files", async () => {
	const root = await repository();
	await file(root, "package.json", JSON.stringify({
		dependencies: { harmless: "https://secret.example/posthog" }, scripts: { postinstall: "ddtrace" }, description: "@sentry/node",
	}));
	await file(root, "sentry.properties", "token=posthog-ddtrace-very-secret");
	await file(root, ".env", "@axiomhq/js");
	await file(root, "bun.lock", "@bugsnag/js");
	await file(root, "README.md", "firebase_crashlytics");
	const discovery = await discoverRepository(root);
	expect(discovery.integrations).toEqual(["sentry"]);
	expect(JSON.stringify(discovery)).not.toContain("very-secret");
});

test("does not follow file or directory symlinks, dependency trees, hidden directories or depth-four manifests", async () => {
	const root = await repository();
	const outside = await directory();
	await file(outside, "package.json", '{"dependencies":{"next":"1","@sentry/node":"1"}}');
	await symlink(join(outside, "package.json"), join(root, "package.json"));
	await symlink(outside, join(root, "linked"));
	await file(root, "node_modules/library/package.json", '{"dependencies":{"astro":"1","@bugsnag/js":"1"}}');
	await file(root, ".hidden/package.json", '{"dependencies":{"vue":"1","dd-trace":"1"}}');
	await file(root, "a/b/c/d/package.json", '{"dependencies":{"svelte":"1","posthog-js":"1"}}');
	const discovery = await discoverRepository(root);
	expect(discovery.frameworks).toEqual([]);
	expect(discovery.integrations).toEqual([]);
});

test("oversized and malformed manifests produce incomplete hints without failing setup discovery", async () => {
	const root = await repository();
	await file(root, "package.json", "x".repeat(128 * 1024 + 1));
	await file(root, "app/package.json", "{broken");
	await file(root, "another/package.json", '{"dependencies":{"astro":"1"}}');
	const discovery = await discoverRepository(root);
	expect(discovery.frameworks).toEqual(["Astro"]);
	expect(discovery.warnings.some((warning) => warning.includes("size limit"))).toBe(true);
	expect(discovery.warnings.some((warning) => warning.includes("manifest hints"))).toBe(true);
});

test("missing git roots, detached HEAD and unsupported remotes leave missing choices explicit", async () => {
	const empty = await directory();
	const absent = await discoverRepository(empty);
	expect(absent.root).toBeNull();
	expect(absent.warnings).toContain("No local git repository was found. Enter the repository's HTTPS address to continue.");
	const root = await repository();
	git(root, "remote", "add", "upstream", "git@private.example:team/app.git");
	const unconnected = await discoverRepository(root);
	expect(unconnected.remote).toBeUndefined();
	expect(unconnected.branch).toBe("work");
	expect(unconnected.warnings.some((warning) => warning.includes("checkout's branch"))).toBe(true);
	expect(unconnected.warnings.some((warning) => warning.includes("HTTPS address"))).toBe(true);
	git(root, "-c", "user.name=Offline test", "-c", "user.email=offline@example.invalid", "commit", "--allow-empty", "-m", "fixture");
	git(root, "checkout", "--detach", "HEAD");
	expect((await discoverRepository(root)).branch).toBeUndefined();
});

test("HTTPS suggestions preserve repository paths while discarding userinfo, query and fragment", () => {
	fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), fc.string({ maxLength: 80 }), (user, secret) => {
		const url = new URL("https://git.example/team/app.git");
		url.username = user;
		url.password = secret;
		url.searchParams.set("token", secret);
		url.hash = secret;
		expect(httpsRepositoryUrl(url.href)).toBe("https://git.example/team/app.git");
	}));
	for (const address of ["git@github.com:team/app.git", "ssh://git@github.com/team/app.git", "ssh://git@github.com:22/team/app.git"])
		expect(httpsRepositoryUrl(address)).toBe("https://github.com/team/app.git");
	for (const address of [
		"ssh://git@github.com:2222/team/app.git", "git@private.example:team/app.git", "http://git.example/app",
		"/tmp/app", "file:///tmp/app", "https://git.example/", "https://git.example/app\n",
	])
		expect(httpsRepositoryUrl(address)).toBeUndefined();
});
