import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { complete, CompletionUsageError, createCompletion } from "../src/commands/completion";
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
		expect(script.length).toBeGreaterThan(200);
	}
	for (const args of [[], ["sh"], ["bash", "extra"], ["bash", "--json"], ["$(touch injected)"]])
		expect(() => complete(args)).toThrow(CompletionUsageError);
});
