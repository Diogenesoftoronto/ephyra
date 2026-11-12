import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitIndicator } from "../src/commands/interactive";

const FIXTURE = join(import.meta.dir, "fixtures/interrupt-wait.ts");

/**
 * A literal Ctrl+C byte typed into a real PTY while the wizard's wait indicator is showing. The PTY runs `stty`
 * after the CLI exits, so the test also reads whether the terminal was handed back in cooked, echoing mode.
 */
async function interrupt(mode: "read" | "write") {
	const config = await mkdtemp(join(tmpdir(), "ephyra-interrupt-"));
	let screen = "";
	const shell = Bun.spawn(["sh", "-c", 'stty sane; "$0" "$1" "$2" "$3"; echo "EXIT<$?>"; stty -a; echo DONE', process.execPath, FIXTURE, mode, config], {
		env: { PATH: process.env.PATH, HOME: config, TERM: "xterm-256color" },
		terminal: { cols: 120, rows: 40, data(_terminal, bytes) { screen += new TextDecoder().decode(bytes); } },
	});
	try {
		for (let i = 0; i < 600 && !existsSync(join(config, "ready")); i++) await Bun.sleep(25);
		expect(readFileSync(join(config, "ready"), "utf8")).toBe(mode);
		await Bun.sleep(150); // let the indicator draw a frame
		shell.terminal!.write("\x03");
		for (let i = 0; i < 400 && !screen.includes("DONE"); i++) await Bun.sleep(25);
		// Missing when something exited the process before cancellation handling ran.
		const written = join(config, "result.json");
		const result = existsSync(written)
			? JSON.parse(readFileSync(written, "utf8")) as { finallyRan: boolean; receipts: string[] }
			: null;
		const settings = /speed[\s\S]*?DONE/.exec(screen)?.[0] ?? "";
		return { code: Number(/EXIT<(\d+)>/.exec(screen)?.[1]), screen, result, settings };
	} finally {
		shell.kill("SIGKILL");
		await shell.exited;
		await rm(config, { recursive: true, force: true });
	}
}

const cooked = (settings: string) => {
	expect(settings).toMatch(/(^|\s)icanon(\s|$)/);
	expect(settings).toMatch(/(^|\s)echo(\s|$)/);
	expect(settings).toMatch(/(^|\s)isig(\s|$)/);
};

test("Ctrl+C typed during a read stops the wait as a cancellation and restores the terminal", async () => {
	const { code, screen, result, settings } = await interrupt("read");
	expect(code).toBe(130);
	expect(result?.finallyRan).toBe(true);
	expect(screen).toContain("Stopped waiting.");
	expect(screen).toContain("\x1b[?25h");
	cooked(settings);
}, 30_000);

test("Ctrl+C typed after a setup write was sent reports it unconfirmed and keeps the receipt", async () => {
	const { code, screen, result, settings } = await interrupt("write");
	expect(code).toBe(1);
	expect(result?.finallyRan).toBe(true);
	expect(screen).toContain("The server has not confirmed this change.");
	expect(screen).toMatch(/Reference: setup:[a-f0-9-]{36}/);
	expect(result?.receipts).toEqual(["setup"]);
	cooked(settings);
}, 30_000);

test("the wait indicator re-raises only Ctrl+C, restores raw mode and listeners, and stays plain without a TTY", () => {
	const { EventEmitter } = require("node:events") as typeof import("node:events");
	const input = Object.assign(new EventEmitter(), {
		isTTY: true, isRaw: false, modes: [] as boolean[], paused: 0,
		setRawMode(mode: boolean) { this.isRaw = mode; this.modes.push(mode); },
		resume() {}, pause() { this.paused++; },
	});
	const written: string[] = [];
	const output = { isTTY: false, write: (text: string) => { written.push(text); return true; } };
	let interrupts = 0;
	const exitListeners = process.listenerCount("exit");
	const indicator = waitIndicator("Reading saved settings…", false, input as never, output as never, () => interrupts++);
	expect(input.isRaw).toBe(true);
	input.emit("data", Buffer.from("q\r"));
	expect(interrupts).toBe(0);
	input.emit("data", Buffer.from("x\x03"));
	expect(interrupts).toBe(1);
	indicator.end("cancel", "Stopped waiting for the server.");
	indicator.end("done", "ignored");
	expect(input.modes).toEqual([true, false]);
	expect(input.listenerCount("data")).toBe(0);
	expect(input.paused).toBe(1);
	expect(process.listenerCount("exit")).toBe(exitListeners);
	// Piped output gets one line per state, with no cursor or erase sequences.
	expect(written).toEqual(["Reading saved settings…\n", "Stopped waiting for the server.\n"]);

	const accessible: string[] = [];
	waitIndicator("Checking…", true, { ...input, isTTY: false } as never, { isTTY: true, write: (t: string) => { accessible.push(t); return true; } } as never)
		.end("done", "Checking");
	expect(accessible.join("")).not.toContain("\x1b");
});
