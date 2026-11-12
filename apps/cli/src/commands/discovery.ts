import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/** Local hints only. An installed SDK does not prove that its service is connected. */
export type RepositoryDiscovery = {
	root: string | null;
	remote?: string;
	branch?: string;
	frameworks: string[];
	integrations: string[];
	warnings: string[];
};

const HTTPS_FORGES = new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org", "git.sr.ht"]);

/** Keep credentials out of discovery results; infer HTTPS only for known SSH forge addresses. */
export function httpsRepositoryUrl(raw: string): string | undefined {
	if (/[\x00-\x20\x7f]/.test(raw)) return undefined;
	const scp = /^git@([^/:]+):(.+)$/.exec(raw);
	if (scp) {
		if (!HTTPS_FORGES.has(scp[1]!.toLowerCase())) return undefined;
		raw = `https://${scp[1]}/${scp[2]}`;
	}
	try {
		const url = new URL(raw);
		if (url.protocol === "ssh:" && HTTPS_FORGES.has(url.hostname.toLowerCase()) && (!url.port || url.port === "22")) {
			// Rebuild because WHATWG URL cannot switch a non-special scheme to a special one in place.
			return httpsRepositoryUrl(`https://${url.hostname}${url.pathname}`);
		}
		if (url.protocol !== "https:" || !url.hostname || url.pathname === "/") return undefined;
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

const SKIP = new Set([
	".git", ".hg", ".svn", "node_modules", "vendor", "Pods", "Carthage", "build", "dist", "target",
	".next", ".nuxt", ".svelte-kit", ".gradle", ".venv", "venv", ".cache", "coverage",
]);
const TEXT_MANIFESTS = new Set([
	"Package.swift", "Podfile", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
	"pubspec.yaml", "pyproject.toml", "requirements.txt", "go.mod", "Gemfile", "composer.json",
]);
const SENTRY_CONFIG = /^sentry\.(?:client|server|edge)\.config\.[cm]?[jt]s$|^sentry\.properties$/;
const MAX_DEPTH = 3;
const MAX_ENTRIES = 2_000;
const MAX_MANIFESTS = 100;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

const FRAMEWORKS: Record<string, string> = {
	next: "Next.js", nuxt: "Nuxt", astro: "Astro", "@sveltejs/kit": "SvelteKit", svelte: "Svelte",
	"@builder.io/qwik": "Qwik", "@qwik.dev/core": "Qwik", "@angular/core": "Angular",
	"react-native": "React Native", expo: "Expo", react: "React", vue: "Vue", hono: "Hono", express: "Express",
};
const PROVIDERS: Record<string, RegExp> = {
	sentry: /@sentry\/|sentry-cocoa|sentry-android|io\.sentry|sentry_sdk|sentry-sdk|sentry_flutter|\bsentry\b/i,
	crashlytics: /firebase-crashlytics|firebasecrashlytics|firebase_crashlytics|com\.google\.firebase\.crashlytics/i,
	loki: /\bloki\b|promtail|grafana\/alloy/i,
	axiom: /@axiomhq\/|axiom-node|axiom-go/i,
	betterstack: /@logtail\/|logtail|betterstack|better_stack/i,
	datadog: /dd-trace|datadog|ddtrace/i,
	bugsnag: /bugsnag/i,
	posthog: /posthog/i,
	otel: /@opentelemetry\/|opentelemetry|opentelemetry-/i,
};

function inside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
}

/** No fetch, package-manager execution or repository scripts: git reads and bounded manifest reads only. */
export async function discoverRepository(cwd: string): Promise<RepositoryDiscovery> {
	const result: RepositoryDiscovery = { root: null, frameworks: [], integrations: [], warnings: [] };
	const git = (...args: string[]) => {
		try {
			const child = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], {
				stdout: "pipe", stderr: "pipe", timeout: 5_000,
			});
			// Only the newline git adds ends the value: a repository path may itself end in spaces.
			return child.exitCode === 0 ? child.stdout.toString().replace(/\r?\n$/, "") : null;
		} catch { return null; }
	};
	const top = git("rev-parse", "--show-toplevel");
	if (!top) {
		result.warnings.push("No local git repository was found. Enter the repository's HTTPS address to continue.");
		return result;
	}
	try { result.root = await realpath(top); }
	catch {
		result.warnings.push("The repository directory could not be read. Enter its HTTPS address to continue.");
		return result;
	}
	const root = result.root;
	const remotes = (git("remote") ?? "").split("\n").filter(Boolean).sort();
	const name = remotes.includes("origin") ? "origin" : remotes[0];
	if (name) {
		const raw = git("remote", "get-url", name);
		result.remote = raw ? httpsRepositoryUrl(raw) : undefined;
		if (!result.remote) result.warnings.push("The selected remote needs an HTTPS address. Its credentials were not copied.");
		const head = git("symbolic-ref", "--quiet", `refs/remotes/${name}/HEAD`);
		const prefix = `refs/remotes/${name}/`;
		if (head?.startsWith(prefix)) result.branch = head.slice(prefix.length);
	}
	if (!result.branch) {
		const current = git("symbolic-ref", "--quiet", "--short", "HEAD");
		if (current) {
			result.branch = current;
			result.warnings.push("The remote default branch is not recorded locally. The detected branch is this checkout's branch.");
		}
	}
	if (!name) result.warnings.push("This repository has no git remote. Enter an HTTPS repository address to connect it.");

	const frameworks = new Set<string>();
	const integrations = new Set<string>();
	const warnings = new Set<string>();
	let entries = 0;
	let manifests = 0;
	let bytes = 0;
	let bounded = false;
	const providerHints = (source: string) => {
		for (const [provider, pattern] of Object.entries(PROVIDERS)) if (pattern.test(source)) integrations.add(provider);
	};
	const readManifest = async (path: string, name: string) => {
		if (manifests >= MAX_MANIFESTS || bytes >= MAX_TOTAL_BYTES) { bounded = true; return; }
		manifests++;
		let file;
		try {
			// Do not follow repository symlinks, including one replacing a manifest during discovery.
			if ((await lstat(path)).isSymbolicLink() || !inside(root, await realpath(path))) return;
			file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_TOTAL_BYTES) { bounded = true; return; }
			// A fixed buffer also bounds a file that grows after stat().
			const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, MAX_TOTAL_BYTES - bytes + 1));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			bytes += bytesRead;
			if (bytesRead > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) { bounded = true; return; }
			const source = buffer.toString("utf8", 0, bytesRead);
			if (name === "package.json") {
				const value: unknown = JSON.parse(source);
				if (!value || typeof value !== "object") return;
				const record = value as Record<string, unknown>;
				const dependencies = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) => {
					const group = record[key];
					return group && typeof group === "object" && !Array.isArray(group) ? Object.keys(group) : [];
				});
				for (const dependency of dependencies) if (FRAMEWORKS[dependency]) frameworks.add(FRAMEWORKS[dependency]!);
				providerHints(dependencies.join("\n"));
			} else {
				providerHints(source);
				if (name === "Podfile" && /platform\s*:ios\b/.test(source)) frameworks.add("iOS");
				if (name.endsWith("gradle") || name.endsWith("gradle.kts")) {
					if (/com\.android\.(?:application|library)/.test(source)) frameworks.add("Android");
				}
				if (name === "pubspec.yaml" && /\bflutter\s*:/.test(source)) frameworks.add("Flutter");
			}
		} catch {
			warnings.add("Some manifest hints could not be read. Setup can still continue from the connected repository.");
		} finally { await file?.close(); }
	};
	const scan = async (directory: string, depth: number): Promise<void> => {
		try {
			if (!inside(root, await realpath(directory)) || (await lstat(directory)).isSymbolicLink()) return;
			const dir = await opendir(directory);
			for await (const entry of dir) {
				if (++entries > MAX_ENTRIES) { bounded = true; break; }
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) {
					if (depth < MAX_DEPTH && !entry.name.startsWith(".") && !SKIP.has(entry.name)) await scan(join(directory, entry.name), depth + 1);
				} else if (entry.isFile()) {
					if (SENTRY_CONFIG.test(entry.name)) integrations.add("sentry"); // Presence only; config may contain credentials.
					else if (entry.name === "package.json" || TEXT_MANIFESTS.has(entry.name)) await readManifest(join(directory, entry.name), entry.name);
				}
			}
		} catch { warnings.add("Some repository directories could not be inspected. Discovery is incomplete."); }
	};
	await scan(root, 0);
	if (bounded) warnings.add("Local discovery reached its size limit. More integrations may exist in the repository.");
	result.frameworks = [...frameworks].sort();
	result.integrations = [...integrations].sort();
	result.warnings.push(...warnings);
	return result;
}
