import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures/opener-login.ts");
const openers: number[] = [];
const dirs: string[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => {
	// Only the fake openers this test started, including any whose test failed before reading the pid.
	for (const dir of dirs) if (existsSync(join(dir, "opener.pid"))) openers.push(Number(readFileSync(join(dir, "opener.pid"), "utf8")));
	for (const pid of new Set(openers.splice(0))) if (alive(pid)) process.kill(pid, "SIGKILL");
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fake platform opener that records its pid and the URL, then stays running like a browser-owning opener. */
async function fakeOpener() {
	const dir = await mkdtemp(join(tmpdir(), "ephyra-opener-"));
	dirs.push(dir);
	const bin = join(dir, "bin");
	await mkdir(bin);
	const script = `#!/bin/sh\necho $$ > '${join(dir, "opener.pid")}'\nprintf '%s' "$1" > '${join(dir, "opener.url")}'\nexec sleep 60\n`;
	for (const name of ["xdg-open", "open"]) {
		await writeFile(join(bin, name), script);
		await chmod(join(bin, name), 0o755);
	}
	return { dir, PATH: `${bin}:${process.env.PATH}` };
}

const waitFor = async (check: () => boolean, ms = 10_000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await Bun.sleep(20);
	return check();
};

test("a still-running browser opener neither delays sign-in polling nor keeps the CLI alive", async () => {
	const { dir, PATH } = await fakeOpener();
	const started = Date.now();
	const child = Bun.spawn([process.execPath, FIXTURE, "approve", dir], { env: { PATH, HOME: dir }, stdout: "ignore", stderr: "pipe" });
	const exited = await Promise.race([child.exited, Bun.sleep(8_000).then(() => null)]);
	if (exited === null) child.kill("SIGKILL");
	const code = exited;
	expect(Date.now() - started).toBeLessThan(8_000);
	expect(code).toBe(0);
	expect(readFileSync(join(dir, "outcome"), "utf8")).toBe("signed-in");
	expect(readFileSync(join(dir, "polls"), "utf8")).toBe("1");
	expect(readFileSync(join(dir, "opener.url"), "utf8")).toMatch(/^https:\/\/fixture\.invalid\/auth\/login\?cli=/);
	const pid = Number(readFileSync(join(dir, "opener.pid"), "utf8"));
	openers.push(pid);
	// The opener may own the user's browser: the CLI leaves it running.
	expect(alive(pid)).toBe(true);
}, 20_000);

test("SIGINT while polling with a live opener exits promptly as a cancellation", async () => {
	const { dir, PATH } = await fakeOpener();
	const child = Bun.spawn([process.execPath, FIXTURE, "pending", dir], { env: { PATH, HOME: dir }, stdout: "ignore", stderr: "pipe" });
	try {
		expect(await waitFor(() => existsSync(join(dir, "opener.pid")))).toBe(true);
		openers.push(Number(readFileSync(join(dir, "opener.pid"), "utf8")));
		expect(await waitFor(() => existsSync(join(dir, "polls")) && Number(readFileSync(join(dir, "polls"), "utf8")) >= 2)).toBe(true);
		const sent = Date.now();
		child.kill("SIGINT");
		const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
		expect(Date.now() - sent).toBeLessThan(2_000);
		expect(code).toBe(130);
		expect(readFileSync(join(dir, "outcome"), "utf8")).toBe("LoginCancelledError");
		expect(existsSync(join(dir, "credentials.json"))).toBe(false);
		expect(alive(openers[0]!)).toBe(true);
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); }
}, 20_000);
