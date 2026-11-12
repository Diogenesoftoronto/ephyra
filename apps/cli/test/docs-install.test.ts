import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
	const result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-c", script], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: ROOT } });
	expect(result.stderr.toString()).toBe("");
	expect(result.exitCode).toBe(0);
	const out = result.stdout.toString();
	expect(out).toContain("usage  ephyra <command>");
	expect(out).toContain("complete -F __ephyra_complete ephyra");
	expect(out).toContain("failed\t\n:4");
}, 30_000);
