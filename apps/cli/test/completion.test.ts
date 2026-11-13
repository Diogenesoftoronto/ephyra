import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete, completionScript, CompletionUsageError, createCompletion } from "../src/commands/completion";
import { bashReplies, lexPosix, quoteFor, type Quote } from "../src/commands/shell-words";
import { COMMANDS, COMPLETION_SHELLS, GLOBAL_OPTIONS, commandNames } from "../src/commands/help";
import { DOCS_TOPICS } from "../src/docs";

function capture(args: readonly string[], env: Record<string, string | undefined> = {}): string[] {
	const print = spyOn(console, "log").mockImplementation(() => {});
	try {
		complete(args, env);
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
});

// Notes main() accepts as values, including ones that look like flags, quotes or shell syntax.
const note = fc.oneof(
	fc.string({ maxLength: 12 }),
	fc.tuple(
		fc.constantFrom("-", "--", "--json", "--json=", "-m", "--message=", "--oops", "-h", "'", "\"", "\\", "\n", "$(x)", "`x`"),
		fc.string({ maxLength: 6 }),
	).map(([head, tail]) => head + tail),
);

test("option values that look like flags stay values, never options (R2-B-01)", () => {
	expect(candidates("decide", "--message=--oops", "T-1234", "A", "")).toEqual(["approve", "revise", "reject"]);
	expect(candidates("decide", "-m", "--json=abc", "T-1234", "")).toEqual(["A", "B", "C"]);
	expect(candidates("decide", "-m", "--json", "T-1234", "")).toEqual(["A", "B", "C"]);
	expect(candidates("decide", "-m", "-m", "T-1234", "A", "")).toEqual(["approve", "revise", "reject"]);
	expect(candidates("runs", "--quest", "--status", "--status", "f")).toEqual(["failed"]);
	// A pending option's value is completed from that option even when the typed text starts with a dash.
	expect(candidates("runs", "--status", "-")).toEqual([]);
	expect(candidates("decide", "-m", "--")).toEqual([]);
	expect(candidates("runs", "--status=")).toEqual(["running", "done", "failed", "unavailable"]);
	expect(candidates("runs", "--status", "--status=", "f")).toEqual([]);
	// A boolean flag consumes nothing. main() matches flags exactly, so `--json=1` is the quest argument there.
	expect(candidates("decide", "--json", "T-1234", "")).toEqual(["A", "B", "C"]);
	expect(candidates("decide", "--json=1", "T-1234", "")).toEqual(["approve", "revise", "reject"]);
	expect(candidates("decide", "--trail", "T-1234", "")).toEqual(["approve", "revise", "reject"]);
	// Whatever the note is (empty, multiline, quoted, or starting with dashes), later positions do not move.
	fc.assert(fc.property(note, (text) => {
		expect(candidates("decide", "T-1", "A", "-m", text, "")).toEqual(["approve", "revise", "reject"]);
		expect(candidates("decide", "-m", text, "T-1", "")).toEqual(["A", "B", "C"]);
		expect(candidates("decide", `--message=${text}`, "T-1", "")).toEqual(["A", "B", "C"]);
		expect(candidates("decide", "--message", text, "T-1", "A", "")).toEqual(["approve", "revise", "reject"]);
		expect(candidates("runs", "--quest", text, "--status", "fa")).toEqual(["failed"]);
	}), { numRuns: 300 });
});

/** A word written the way someone could type it: unquoted with escapes, or in one of Bash's quote styles. */
const typedWord = fc.tuple(fc.string({ maxLength: 10 }), fc.constantFrom<Quote>("", "'", "\"", "$'"))
	.map(([value, quote]) => ({ value, raw: quote === "" && value === "" ? "''" : `${quote}${quoteFor(value, quote)}${quote === "$'" ? "'" : quote}` }));

test("the Bash lexer removes quoting without running or expanding anything (R2-B-02)", () => {
	expect(lexPosix("ephyra decide '--message=note' T-1234 ")).toEqual({
		words: ["ephyra", "decide", "--message=note", "T-1234"], current: "", quote: "", suffix: "",
	});
	expect(lexPosix("ephyra 'decide' T-1 \"A\" ").words).toEqual(["ephyra", "decide", "T-1", "A"]);
	expect(lexPosix("ephyra runs --status 'fa")).toMatchObject({ current: "fa", quote: "'" });
	expect(lexPosix("ephyra runs --status=\"fa")).toMatchObject({ current: "--status=fa", quote: "\"" });
	expect(lexPosix("ephyra runs --status='fa'")).toMatchObject({ current: "--status=fa", quote: "" });
	expect(lexPosix("ephyra a\\ b $'x\\ty\\'' \"\\$h \\\\ \\q\" c\\").words).toEqual(["ephyra", "a b", "x\ty'", "$h \\ \\q"]);
	expect(lexPosix("ephyra c\\").current).toBe("c");
	// Substitutions and parameters are kept as literal text, including their spaces and nested quotes.
	expect(lexPosix("ephyra -m $(touch \"a b\") \"$HOME ${X:-y z}\" `id -u` x").words)
		.toEqual(["ephyra", "-m", "$(touch \"a b\")", "$HOME ${X:-y z}", "`id -u`"]);
	expect(lexPosix("ephyra -m \"q$(echo \")\")\" 'z").words).toEqual(["ephyra", "-m", "q$(echo \")\")"]);
	// A multiline quoted value, a completed empty word, and the cursor inside a word with later words after it.
	expect(lexPosix("ephyra decide -m 'first\nsecond' '' T-1 ").words).toEqual(["ephyra", "decide", "-m", "first\nsecond", "", "T-1"]);
	expect(lexPosix("ephyra runs --status=fa", "iled --limit 3")).toMatchObject({ current: "--status=fa", suffix: "iled" });
	expect(lexPosix("ephyra runs 'fa", "il'ed x")).toMatchObject({ current: "fa", quote: "'", suffix: "iled" });
	fc.assert(fc.property(fc.array(typedWord, { maxLength: 6 }), typedWord, (completed, last) => {
		const line = ["ephyra", ...completed.map((word) => word.raw)].join(" ");
		const read = lexPosix(`${line} ${last.raw}`);
		expect(read.words).toEqual(["ephyra", ...completed.map((word) => word.value)]);
		expect(read.current).toBe(last.value);
		expect(read.quote).toBe("");
		// Any cut through the last word reads back as a prefix, with the rest as the suffix.
		for (let cut = 0; cut <= last.raw.length; cut++) {
			const split = lexPosix(`${line} ${last.raw.slice(0, cut)}`, last.raw.slice(cut));
			expect(split.words).toEqual(read.words);
			expect(split.current + split.suffix).toBe(last.value);
		}
	}), { numRuns: 300 });
});

test("Bash replies replace only Readline's word, keep its quote, and never duplicate the suffix (R2-B-03)", () => {
	expect(bashReplies(["--status=failed"], "ephyra runs --status=fa", "", "fa")).toEqual({ replies: ["failed"], nospace: false });
	expect(bashReplies(["--status=failed"], "ephyra runs --status=fa", "iled", "fa")).toEqual({ replies: ["fa"], nospace: true });
	expect(bashReplies(["quickstart"], "ephyra docs quick", "start x", "quick")).toEqual({ replies: ["quick"], nospace: true });
	expect(bashReplies(["quickstart"], "ephyra docs qu", "start", "qu")).toEqual({ replies: ["quick"], nospace: true });
	// The suffix is not part of this candidate, so Readline keeps it after the full value.
	expect(bashReplies(["--state=ready"], "ephyra quests --state=re", "xyz", "re")).toEqual({ replies: ["ready"], nospace: true });
	expect(bashReplies(["--status=failed"], "ephyra runs --status='fa", "", "fa")).toEqual({ replies: ["failed"], nospace: false });
	expect(bashReplies(["--status=failed"], "ephyra runs '--status=fa", "", "--status=fa")).toEqual({ replies: ["--status=failed"], nospace: false });
	expect(bashReplies(["a b'c"], "ephyra x 'a", "", "a")).toEqual({ replies: ["a b'\\''c"], nospace: false });
	expect(bashReplies(["a b$c"], "ephyra x a", "", "a")).toEqual({ replies: ["a\\ b\\$c"], nospace: false });
	expect(bashReplies(["a b$c"], "ephyra x \"a", "", "a")).toEqual({ replies: ["a b\\$c"], nospace: false });
	// Readline's word must end the line before the cursor; anything else is refused rather than guessed.
	expect(bashReplies(["failed"], "ephyra runs fa", "", "zz")).toEqual({ replies: [], nospace: false });
});

test("the Bash protocol decodes the raw line and prints Readline replies with a directive", () => {
	const bashProtocol = (before: string, after: string, word: string) =>
		capture(["--", before, after, word], { EPHYRA_COMPLETE_SHELL: "bash" });
	expect(bashProtocol("ephyra decide '--message=note' T-1234 ", "", "")).toEqual(["A", "B", "C", ":bash"]);
	expect(bashProtocol("ephyra 'decide' T-1234 ", "", "")).toEqual(["A", "B", "C", ":bash"]);
	expect(bashProtocol("ephyra decide --message=--oops T-1234 A ", "", "")).toEqual(["approve", "revise", "reject", ":bash"]);
	expect(bashProtocol("ephyra decide -m '--json=abc' T-1234 ", "", "")).toEqual(["A", "B", "C", ":bash"]);
	expect(bashProtocol("ephyra runs --status 'fa", "", "fa")).toEqual(["failed", ":bash"]);
	expect(bashProtocol("ephyra runs --status='fa", "", "fa")).toEqual(["failed", ":bash"]);
	expect(bashProtocol("ephyra runs --status=fa", "iled --limit 3", "fa")).toEqual(["fa", ":bash-nospace"]);
	expect(bashProtocol("ephyra docs quick", "start", "quick")).toEqual(["quick", ":bash-nospace"]);
	expect(bashProtocol("ephyra decide -m \"$(touch x)\" T-1 ", "", "")).toEqual(["A", "B", "C", ":bash"]);
	expect(bashProtocol("ephyra", "", "ephyra")).toEqual([":bash"]);
	// Without the variable the generated Bash function sets, the same argv is ordinary completed words.
	expect(capture(["--", "decide", "T-1", ""])).toEqual(["A\t", "B\t", "C\t", ":4"]);
	fc.assert(fc.property(note, (text) => {
		const line = `ephyra decide -m '${quoteFor(text, "'")}' T-1 `;
		expect(bashProtocol(line, "", "")).toEqual(["A", "B", "C", ":bash"]);
	}), { numRuns: 200 });
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

// A real Bash process sources the emitted script and runs its function with the variables Readline sets.
// `ephyra` is a recording stub, so this checks the shell boundary: what is passed, and how replies are accepted.
const BASH_DRIVER = [
	'source "$1"',
	'COMP_LINE=$TEST_LINE',
	'COMP_POINT=$TEST_POINT',
	'ephyra() {',
	'    printf "%s\\0" "$EPHYRA_COMPLETE_SHELL" "$@" > "$TEST_CAPTURE"',
	'    printf "%s\\n" "$TEST_RESPONSE"',
	'}',
	'__ephyra_complete ephyra "$TEST_WORD" ""',
	'if (( ${#COMPREPLY[@]} )); then printf "%s\\0" "${COMPREPLY[@]}"; fi',
].join("\n");

test.skipIf(!bash)("Bash passes the raw line literally and accepts only a known directive, never running typed text", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ephyra-bash-completion-"));
	try {
		const script = join(dir, "completion.bash");
		const capture = join(dir, "argv");
		const marker = join(dir, "executed");
		await writeFile(script, completionScript("bash"));
		const hostile = `ephyra comment -m "$(touch ${marker})" '; touch ${marker}; #' \`touch ${marker}\` $'a\\nb' "double\\" and single' quotes" `;
		const invoke = (line: string, point: number, word: string, response: string) => Bun.spawnSync([
			bash!, "--noprofile", "--norc", "-c", BASH_DRIVER, "test", script,
		], { env: { ...process.env, TEST_CAPTURE: capture, TEST_LINE: line, TEST_POINT: String(point), TEST_WORD: word, TEST_RESPONSE: response } });
		const result = invoke(`${hostile}re later`, hostile.length + 2, "re", "ready\nre'\\''x\n:bash");
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		// The line is split at the cursor; the word after the cursor's word is passed but never completed.
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["bash", "complete", "--", `${hostile}re`, " later", "re"]);
		// Replies are inserted as given, one per line, including quote characters.
		expect(nulWords(result.stdout.toString())).toEqual(["ready", "re'\\''x"]);
		expect(invoke("ephyra runs ", 12, "", ":bash").stdout.toString()).toBe("");
		expect(nulWords(invoke("ephyra docs quick", 11, "qu", "quick\n:bash-nospace").stdout.toString())).toEqual(["quick"]);
		for (const response of ["ready\nLooks like a directive:bash", "ready\n:4", "ready\n:bash-x", `ready\n:$(touch ${marker})`, ""]) {
			const invalid = invoke(hostile, hostile.length, "", response);
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

const MAIN = join(import.meta.dir, "../src/main.ts");

/** An `ephyra` on PATH that runs this checkout's CLI, so the shells exercise the real completion protocol. */
async function ephyraOnPath(dir: string): Promise<string> {
	const bin = join(dir, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "ephyra"), `#!/bin/sh\nexec '${process.execPath}' '${MAIN}' "$@"\n`);
	await chmod(join(bin, "ephyra"), 0o755);
	return `${bin}:${process.env.PATH}`;
}

// Interactive Bash in a PTY: real Readline with its default COMP_WORDBREAKS and quote handling, and the real CLI.
// `|` in a case marks where the cursor is when Tab is pressed; the line is read back from Readline's buffer.
test.skipIf(!bash)("Bash Readline completes quoted, inline-valued and mid-word text in place", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ephyra-readline-"));
	let shell: ReturnType<typeof Bun.spawn> | undefined;
	try {
		const PATH = await ephyraOnPath(dir);
		const marker = join(dir, "executed");
		await writeFile(join(dir, "completion.bash"), completionScript("bash"));
		await writeFile(join(dir, "rc"), [
			`source '${join(dir, "completion.bash")}'`, "PS1='$ '",
			// Ctrl+T prints the edited line, so the test reads Readline's buffer rather than screen echo.
			`bind -x '"\\C-t": printf "\\nLINE<%s>\\n" "$READLINE_LINE"'`, "echo READY",
		].join("\n"));
		let screen = "";
		shell = Bun.spawn([bash!, "--noprofile", "--rcfile", join(dir, "rc"), "-i"], {
			env: { PATH, HOME: dir, TERM: "dumb" },
			terminal: { cols: 400, rows: 40, data(_terminal, bytes) { screen += new TextDecoder().decode(bytes); } },
		});
		for (let i = 0; i < 400 && !screen.includes("READY"); i++) await Bun.sleep(25);
		const tab = async (typed: string) => {
			const [left, right = ""] = typed.split("|");
			const mark = screen.length;
			// Readline handles keys in order, so Ctrl+T runs only after the completion function has returned.
			shell!.terminal!.write(`${left}${right}${"\x1b[D".repeat(right.length)}\t\x14`);
			for (let i = 0; i < 400 && !/LINE<[^\n]*>/.test(screen.slice(mark)); i++) await Bun.sleep(25);
			shell!.terminal!.write("\x05\x15");
			return /LINE<([^\n]*)>/.exec(screen.slice(mark))?.[1];
		};
		const cases: [string, string][] = [
			["ephyra runs --status=fa|", "ephyra runs --status=failed "],
			["ephyra quests --state=rea|", "ephyra quests --state=ready "],
			["ephyra runs --status fa|", "ephyra runs --status failed "],
			// R2-B-01: a note that looks like a flag is a value, so later positions stay where main() reads them.
			["ephyra decide --message=--oops T-1234 A rej|", "ephyra decide --message=--oops T-1234 A reject "],
			["ephyra decide -m '--json=abc' T-1234 B|", "ephyra decide -m '--json=abc' T-1234 B "],
			// R2-B-02: quoted completed words and quoted current values mean what they mean unquoted.
			["ephyra decide '--message=note' T-1234 B|", "ephyra decide '--message=note' T-1234 B "],
			["ephyra 'decide' T-1234 B|", "ephyra 'decide' T-1234 B "],
			["ephyra runs --status 'fa|", "ephyra runs --status 'failed' "],
			["ephyra runs --status \"fa|", "ephyra runs --status \"failed\" "],
			["ephyra runs --status='fa|", "ephyra runs --status='failed' "],
			["ephyra runs --status=\"fa|", "ephyra runs --status=\"failed\" "],
			["ephyra runs '--status=fa|", "ephyra runs '--status=failed' "],
			["ephyra runs --status='fa'|", "ephyra runs --status=failed "],
			["ephyra runs --status 'fa'|", "ephyra runs --status failed "],
			// R2-B-03: inside a word, the text after the cursor is kept and never duplicated.
			["ephyra runs --status=fa|iled", "ephyra runs --status=failed"],
			["ephyra runs --status=fa|iled --limit 3", "ephyra runs --status=failed --limit 3"],
			["ephyra runs --status fa|iled --limit 3", "ephyra runs --status failed --limit 3"],
			["ephyra runs --status 'fa|iled' --limit 3", "ephyra runs --status 'failed' --limit 3"],
			["ephyra docs quick|start", "ephyra docs quickstart"],
			["ephyra docs qu|start", "ephyra docs quickstart"],
			// Hostile completed words are text: nothing is run, and completion still counts them as one value.
			[`ephyra decide -m "$(touch ${marker})" T-1234 B|`, `ephyra decide -m "$(touch ${marker})" T-1234 B `],
			[`ephyra decide -m \`touch ${marker}\` T-1234 B|`, `ephyra decide -m \`touch ${marker}\` T-1234 B `],
		];
		const results = [];
		for (const [typed] of cases) results.push(await tab(typed));
		expect(results).toEqual(cases.map(([, expected]) => expected));
		expect(existsSync(marker)).toBe(false);
	} finally {
		shell?.kill("SIGKILL");
		await shell?.exited;
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);

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
		// R2-B-01: notes that look like flags are values.
		expect(run("ephyra decide --message=--oops T-1234 A ")).toEqual(["approve", "reject", "revise"]);
		expect(run("ephyra decide -m '--json=abc' T-1234 ")).toEqual(["A", "B", "C"]);
		// R2-B-02: the current token's quoting is removed before the CLI sees it; Fish re-quotes what it inserts.
		for (const line of ["ephyra runs --status 'fa", "ephyra runs --status \"fa", "ephyra runs --status 'fa'", "ephyra runs --status \"fa\""])
			expect(run(line)).toEqual(["failed"]);
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["complete", "--", "runs", "--status", "fa"]);
		for (const line of ["ephyra runs --status='fa", "ephyra runs --status='fa'", "ephyra runs '--status=fa", "ephyra runs --status=\"fa"])
			expect(run(line)).toEqual(["--status=failed"]);
		expect(nulWords(await readFile(capture, "utf8"))).toEqual(["complete", "--", "runs", "--status=fa"]);
		expect(run("ephyra 'decide' T-1234 ")).toEqual(["A", "B", "C"]);
		// An unfinished trailing escape is left out rather than failing the whole decode.
		expect(run("ephyra runs --status fa\\")).toEqual(["failed"]);
	} finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
