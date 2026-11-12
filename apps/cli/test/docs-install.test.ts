import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const page = readFileSync(join(ROOT, "apps/web/content/docs/pages/cli.md"), "utf8");
const install = /## Install[\s\S]*?```sh\n([\s\S]*?)```/.exec(page)?.[1] ?? "";
const bash = Bun.which("bash");

// Run the page's install block as written, in Bash with alias expansion on and an `ephyra` alias from the earlier
// instructions already defined. `bun install` is shadowed so the test stays offline; every other line is the page's.
test.skipIf(!bash)("the documented source install runs in Bash even where an ephyra alias already exists", () => {
	expect(install).toContain("ephyra help");
	const script = [
		"shopt -s expand_aliases",
		`alias ephyra="bun ${ROOT}/apps/cli/src/main.ts"`,
		'bun() { if [[ "$1" == install ]]; then return 0; fi; command bun "$@"; }',
		install,
		'[[ "$(type -t ephyra)" == function ]] || { echo "not a function" >&2; exit 3; }',
		"source <(ephyra complete bash)",
		"complete -p ephyra",
		"ephyra complete -- runs --status fa",
	].join("\n");
	const home = mkdtempSync(join(tmpdir(), "ephyra-docs-home-"));
	let result: ReturnType<typeof Bun.spawnSync>;
	try { result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-c", script], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } }); }
	finally { rmSync(home, { recursive: true, force: true }); }
	expect(result.stderr!.toString()).toBe("");
	expect(result.exitCode).toBe(0);
	const out = result.stdout!.toString();
	expect(out).toContain("usage  ephyra <command>");
	expect(out).toContain("complete -F __ephyra_complete ephyra");
	expect(out).toContain("failed\t\n:4");
}, 30_000);

test.skipIf(!bash)("the documented profile works in a fresh shell outside the checkout", () => {
	const section = page.split("## Install")[1]?.split("## First five minutes")[0] ?? "";
	const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/g)];
	const profile = blocks[1]?.[1] ?? "";
	expect(profile).toContain('EPHYRA_MAIN="/absolute/path/to/ephyra/apps/cli/src/main.ts"');
	const home = mkdtempSync(join(tmpdir(), "ephyra-docs-profile-"));
	let result: ReturnType<typeof Bun.spawnSync>;
	try {
		writeFileSync(join(home, ".bashrc"), profile.replace("/absolute/path/to/ephyra", ROOT));
		result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-c", [
			'[[ ! -v EPHYRA_MAIN ]] || exit 4',
			'source "$HOME/.bashrc"',
			"ephyra help",
			"source <(ephyra complete bash)",
			"complete -p ephyra",
			"ephyra complete -- runs --status fa",
		].join("\n")], { cwd: home, env: { PATH: process.env.PATH, HOME: home } });
	} finally { rmSync(home, { recursive: true, force: true }); }
	expect(result.stderr!.toString()).toBe("");
	expect(result.exitCode).toBe(0);
	expect(result.stdout!.toString()).toContain("usage  ephyra <command>");
	expect(result.stdout!.toString()).toContain("complete -F __ephyra_complete ephyra");
	expect(result.stdout!.toString()).toContain("failed\t\n:4");
}, 30_000);
