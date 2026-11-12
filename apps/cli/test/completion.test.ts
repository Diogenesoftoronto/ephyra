import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete, completionScript, CompletionUsageError, createCompletion } from "../src/commands/completion";
import { COMMANDS, COMPLETION_SHELLS, GLOBAL_OPTIONS, commandNames } from "../src/commands/help";
import { DOCS_TOPICS } from "../src/docs";

function capture(args: readonly string[]): string[] {
	const print = spyOn(console, "log").mockImplementation(() => {});
	try {
		complete(args);
		return print.mock.calls.map((call) => String(call[0]));
	} finally {
		print.mockRestore();
	}
}

function candidates(...args: string[]): string[] {
	const output = capture(["--", ...args]);
	expect(output.at(-1)).toBe(":4");
	return output.slice(0, -1).map((line) => line.split("\t")[0]!);
}

test("completion catalog comes from every help entry, alias, option and positional argument", () => {
	const completion = createCompletion();
	expect([...completion.commands.keys()]).toEqual(commandNames());
	for (const entry of COMMANDS) {
		for (const name of [entry.name, ...(entry.aliases ?? [])]) {
			const command = completion.commands.get(name)!;
			expect(command.description).toBe(entry.summary);
			expect([...command.arguments.keys()]).toEqual((entry.arguments ?? []).map((arg) => arg.name));
			for (const option of entry.options ?? []) {
				for (const flag of option.flags.filter((flag) => flag.startsWith("--"))) {
					const registered = command.options.get(flag.slice(2))!;
					expect(registered.description).toBe(option.description);
					expect(registered.isBoolean).toBe(option.value === undefined);
				}
			}
		}
	}
	expect(candidates("")).toEqual(commandNames());
	expect(candidates("trails", "--")).toEqual(candidates("quests", "--"));
});

test("command prefix filtering and repeat requests never mutate the caller or retain another request", () => {
	fc.assert(fc.property(fc.constantFrom(...commandNames()), fc.nat(), (name, n) => {
		const prefix = name.slice(0, n % (name.length + 1));
		const actual = candidates(prefix);
		expect(actual).toContain(name);
		expect(actual.every((value) => value.startsWith(prefix))).toBe(true);
		expect(new Set(actual).size).toBe(actual.length);
	}), { numRuns: 40 });
	const argv = ["--", "quests", "--state", ""];
	capture(argv);
	expect(argv).toEqual(["--", "quests", "--state", ""]);
	expect(candidates("decide", "T-1a2b", "")).toEqual(["A", "B", "C"]);
	expect(candidates("qu")).toEqual(["quests", "questions"]);
});

test("root and command flags include supported aliases and never suggest a different command's options", () => {
	expect(candidates("--")).toEqual(GLOBAL_OPTIONS.map((option) => option.flags[0]!));
	expect(candidates("-")).toEqual(["-h", "-v"]);
	expect(candidates("setup", "--int")).toEqual(["--interactive"]);
	expect(candidates("run", "-f")).toEqual(["-f"]);
	expect(candidates("decide", "-m")).toEqual(["-m"]);
	expect(candidates("runs", "--")).toEqual(["--json", "--help", "--quest", "--trail", "--status", "--limit"]);
	expect(candidates("setup", "--")).not.toContain("--version");
	expect(candidates("setup", "--")).not.toContain("--force");
	expect(candidates("complete", "--")).toEqual(["--help"]);
	expect(candidates("--json", "que")).toEqual(["quests", "questions"]);
});

test("enum and positional completions track their position past flags and values", () => {
	expect(candidates("runs", "--status", "")).toEqual(["running", "done", "failed", "unavailable"]);
	expect(candidates("runs", "--status", "f")).toEqual(["failed"]);
	expect(candidates("quests", "--state", "rea")).toEqual(["ready"]);
	expect(candidates("trails", "--state", "ready", "--j")).toEqual(["--json"]);
	expect(candidates("decide", "T-1a2b", "B", "re")).toEqual(["revise", "reject"]);
	expect(candidates("decide", "-m", "a note", "T-1a2b", "")).toEqual(["A", "B", "C"]);
	expect(candidates("decide", "--json", "T-1a2b", "A", "")).toEqual(["approve", "revise", "reject"]);
	expect(candidates("spend", "T-1a2b", "")).toEqual(["approve", "reject"]);
	expect(candidates("file", "T-1a2b", "proof/")).toEqual(["proof/manifest.json"]);
	expect(candidates("agents", "")).toEqual(["revoke"]);
	// An offline completion does not invent quest, account, run or agent identifiers.
	expect(candidates("show", "")).toEqual([]);
	expect(candidates("agents", "revoke", "")).toEqual([]);
	expect(candidates("runs", "--quest", "")).toEqual([]);
	expect(candidates("decide", "-m", "")).toEqual([]);
});

test("completed empty words and inline --name=value keep later positionals in place", () => {
	// tab 0.0.22 alone dropped the completed empty note here and printed only the directive.
	expect(capture(["--", "decide", "T-1234", "A", "-m", "", ""])).toEqual(["approve\t", "revise\t", "reject\t", ":4"]);
	expect(candidates("decide", "T-1234", "A", "-m", "note", "")).toEqual(["approve", "revise", "reject"]);
	expect(candidates("decide", "-m", "", "T-1234", "")).toEqual(["A", "B", "C"]);
	expect(candidates("decide", "--message=", "T-1234", "")).toEqual(["A", "B", "C"]);
	expect(candidates("decide", "--message=a note", "T-1234", "A", "")).toEqual(["approve", "revise", "reject"]);
	expect(candidates("runs", "--status=failed", "--quest", "")).toEqual([]);
	expect(candidates("runs", "--status=failed", "--")).toEqual(["--json", "--help", "--quest", "--trail", "--status", "--limit"]);
	expect(candidates("runs", "--status=fa")).toEqual(["failed"]);
	// Whatever the completed words are, positional counting matches the same words with the note given inline.
	fc.assert(fc.property(fc.string({ maxLength: 12 }).filter((note) => !note.startsWith("-")), (note) => {
		expect(candidates("decide", "T-1", "A", "-m", note, "")).toEqual(["approve", "revise", "reject"]);
		expect(candidates("decide", "-m", note, "T-1", "")).toEqual(["A", "B", "C"]);
	}));
});

test("help, documentation and shell choices use the existing catalogs", () => {
	expect(candidates("help", "")).toEqual(commandNames());
	expect(candidates("docs", "")).toEqual(["index", ...Object.keys(DOCS_TOPICS)]);
	expect(candidates("complete", "")).toEqual([...COMPLETION_SHELLS]);
	expect(candidates("help", "com")).toEqual(["complete", "comment"]);
});

test("prints scripts for four shells using the installed executable, with no local path or rcfile write", () => {
	for (const shell of COMPLETION_SHELLS) {
		const script = capture([shell]).join("\n");
		expect(script).toContain("ephyra");
		expect(script).toContain("complete");
		expect(script).not.toContain(process.cwd());
		expect(script).not.toContain("credentials");
		expect(script).not.toMatch(/\beval\b|Invoke-Expression|compgen\s+-W/);
		expect(script.length).toBeGreaterThan(200);
	}
	for (const args of [[], ["sh"], ["bash", "extra"], ["bash", "--json"], ["$(touch injected)"]])
		expect(() => complete(args)).toThrow(CompletionUsageError);
});

const bash = Bun.which("bash");
const fish = Bun.which("fish");
const nulWords = (text: string) => text === "" ? [] : text.slice(0, -1).split("\0");

// Supply Readline's already-tokenized words without running a prompt or executing the typed command.
// A real Bash process sources and invokes the emitted script; only the Readline metadata helper is stubbed.
const BASH_DRIVER = [
	'source "$1"',
	'shift',
	'COMP_WORDS=(ephyra "$@")',
	'COMP_CWORD=$TEST_CWORD',
	'_get_comp_words_by_ref() {',
	'    words=("${COMP_WORDS[@]}")',
	'    cword=$COMP_CWORD',
	'    cur=$TEST_CURRENT',
	'    prev=${words[cword-1]}',
	'}',
	'ephyra() {',
	'    printf "%s\\0" "$@" > "$TEST_CAPTURE"',
	'    printf "%s\\n" "$TEST_RESPONSE"',
	'}',
	'__ephyra_complete',
	'if (( ${#COMPREPLY[@]} )); then printf "%s\\0" "${COMPREPLY[@]}"; fi',
].join("\n");

test.skipIf(!bash)("Bash passes hostile words literally, preserving empty arguments, spaces, quotes and the cursor boundary", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ephyra-bash-completion-"));
	try {
		const script = join(dir, "completion.bash");
		const capture = join(dir, "argv");
		const marker = join(dir, "executed");
		await writeFile(script, completionScript("bash"));
		const hostile = [`$(touch ${marker})`, `; touch ${marker}; #`, `\`touch ${marker}\``, "two words", "double\" and single' quotes"];
		const words = ["comment", "-m", ...hostile, "", "ignored-after-cursor"];
		const invoke = (current: string, cword: number, response = "ready\tDescription: with colons:4\n:4") => Bun.spawnSync([
			bash!, "--noprofile", "--norc", "-c", BASH_DRIVER, "test", script, ...words,
		], { env: { ...process.env, TEST_CAPTURE: capture, TEST_CURRENT: current, TEST_CWORD: String(cword), TEST_RESPONSE: response } });
		const result = invoke("", words.length - 1);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["complete", "--", ...words.slice(0, -1)]);
		expect(nulWords(result.stdout.toString())).toEqual(["ready"]);
		expect(existsSync(marker)).toBe(false);
		// The current word is replaced by its prefix, and later words are never sent.
		const middle = invoke("re", 3);
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["complete", "--", "comment", "-m", "re"]);
		expect(nulWords(middle.stdout.toString())).toEqual(["ready"]);
		// Readline replaces only the text after the last = in COMP_WORDBREAKS; without that break, the whole word.
		const equals = invoke("--state=re", 3);
		expect(nulWords(equals.stdout.toString())).toEqual(["ready"]);
		const unbroken = Bun.spawnSync([bash!, "--noprofile", "--norc", "-c", `COMP_WORDBREAKS=$' \\t\\n'; ${BASH_DRIVER}`, "test", script, ...words], {
			env: { ...process.env, TEST_CAPTURE: capture, TEST_CURRENT: "--state=re", TEST_CWORD: "3", TEST_RESPONSE: "ready\tDescription\n:4" },
		});
		expect(nulWords(unbroken.stdout.toString())).toEqual(["--state=ready"]);
		for (const response of ["ready\tLooks like a directive:4", "ready\tDescription\n:0", `ready\tDescription\n:$(touch ${marker})`]) {
			const invalid = invoke("", words.length - 1, response);
			expect(invalid.stdout.toString()).toBe("");
		}
		expect(existsSync(marker)).toBe(false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

const FISH_DRIVER = [
	'source $argv[1]',
	'function ephyra',
	'    printf "%s\\0" $argv > "$TEST_CAPTURE"',
	'    printf "%s\\n" "$TEST_RESPONSE"',
	'end',
	'set -l line ephyra',
	'for word in $argv[2..-1]',
	'    set line "$line "(string escape -- "$word")',
	'end',
	'complete -C "$line "',
].join("\n");

test.skipIf(!fish)("Fish uses actual completion tokenization without evaluating hostile arguments", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ephyra-fish-completion-"));
	try {
		const script = join(dir, "completion.fish");
		const capture = join(dir, "argv");
		const marker = join(dir, "executed");
		await writeFile(script, completionScript("fish"));
		const words = ["comment", "-m", "two words", `$(touch ${marker})`, `; touch ${marker}; #`, "double\" and single' quotes"];
		const result = Bun.spawnSync([fish!, "--no-config", "-c", FISH_DRIVER, "--", script, ...words], {
			env: { ...process.env, TEST_CAPTURE: capture, TEST_RESPONSE: "ready\tDescription: with colons:4\n:4" },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["complete", "--", ...words, ""]);
		expect(result.stdout.toString()).toContain("ready\tDescription: with colons:4");
		expect(existsSync(marker)).toBe(false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

const bashCompletion = ["/usr/share/bash-completion/bash_completion", "/etc/bash_completion"].find((path) => existsSync(path));
const MAIN = join(import.meta.dir, "../src/main.ts");

/** An `ephyra` on PATH that runs this checkout's CLI, so the shells exercise the real completion protocol. */
async function ephyraOnPath(dir: string): Promise<string> {
	const bin = join(dir, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "ephyra"), `#!/bin/sh\nexec '${process.execPath}' '${MAIN}' "$@"\n`);
	await chmod(join(bin, "ephyra"), 0o755);
	return `${bin}:${process.env.PATH}`;
}

// Interactive Bash in a PTY: real Readline, the default COMP_WORDBREAKS and bash-completion's word helper.
test.skipIf(!bash || !bashCompletion)("Bash Readline replaces only the text after = when completing --name=value", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ephyra-readline-"));
	let shell: ReturnType<typeof Bun.spawn> | undefined;
	try {
		const PATH = await ephyraOnPath(dir);
		await writeFile(join(dir, "completion.bash"), completionScript("bash"));
		await writeFile(join(dir, "rc"), [
			`source '${bashCompletion}'`, `source '${join(dir, "completion.bash")}'`, "PS1='$ '",
			// Ctrl+T prints the edited line, so the test reads Readline's buffer rather than screen echo.
			`bind -x '"\\C-t": printf "\\nLINE<%s>\\n" "$READLINE_LINE"'`, "echo READY",
		].join("\n"));
		let screen = "";
		shell = Bun.spawn([bash!, "--noprofile", "--rcfile", join(dir, "rc"), "-i"], {
			env: { PATH, HOME: dir, TERM: "dumb" },
			terminal: { cols: 200, rows: 40, data(_terminal, bytes) { screen += new TextDecoder().decode(bytes); } },
		});
		const until = async (pattern: RegExp) => {
			for (let i = 0; i < 400 && !pattern.test(screen); i++) await Bun.sleep(25);
			return pattern.exec(screen)?.[1];
		};
		const line = async (typed: string) => {
			const mark = screen.length;
			shell!.terminal!.write(`${typed}\t`);
			await Bun.sleep(50);
			for (let i = 0; i < 400 && !/failed|ready|\x07/.test(screen.slice(mark + typed.length)); i++) await Bun.sleep(25);
			const before = screen.length;
			shell!.terminal!.write("\x14");
			for (let i = 0; i < 400 && !/LINE<.*>/.test(screen.slice(before)); i++) await Bun.sleep(25);
			shell!.terminal!.write("\x15");
			return /LINE<(.*)>/.exec(screen.slice(before))?.[1];
		};
		expect(await until(/(READY)/)).toBe("READY");
		expect(await line("ephyra runs --status=fa")).toBe("ephyra runs --status=failed ");
		expect(await line("ephyra quests --state=rea")).toBe("ephyra quests --state=ready ");
		expect(await line("ephyra runs --status fa")).toBe("ephyra runs --status failed ");
	} finally {
		shell?.kill("SIGKILL");
		await shell?.exited;
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

// Fish's own completion engine, with the generated function calling the real CLI through a recording wrapper.
const FISH_REAL_DRIVER = [
	'source $argv[1]',
	'function ephyra',
	'    printf "%s\\0" $argv > "$TEST_CAPTURE"',
	'    command ephyra $argv',
	'end',
	'complete -C $argv[2]',
].join("\n");

test.skipIf(!fish)("Fish keeps quoted multiline and empty arguments as single words", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ephyra-fish-words-"));
	try {
		const PATH = await ephyraOnPath(dir);
		const script = join(dir, "completion.fish");
		const capture = join(dir, "argv");
		await writeFile(script, completionScript("fish"));
		const run = (line: string) => {
			const result = Bun.spawnSync([fish!, "--no-config", "-c", FISH_REAL_DRIVER, "--", script, line], {
				env: { PATH, HOME: dir, TEST_CAPTURE: capture },
			});
			expect(result.stderr.toString()).toBe("");
			// Fish sorts candidates itself.
			return result.stdout.toString().split("\n").filter(Boolean).map((row) => row.split("\t")[0]).sort();
		};
		expect(run("ephyra decide -m 'first\nsecond' T-1234 ")).toEqual(["A", "B", "C"]);
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["complete", "--", "decide", "-m", "first\nsecond", "T-1234", ""]);
		expect(run("ephyra decide T-1234 A -m '' ")).toEqual(["approve", "reject", "revise"]);
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["complete", "--", "decide", "T-1234", "A", "-m", "", ""]);
		expect(run("ephyra runs --status=fa")).toEqual(["--status=failed"]);
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["complete", "--", "runs", "--status=fa"]);
	} finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
