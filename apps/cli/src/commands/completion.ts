import { RootCommand, type Command, type Complete } from "@bomb.sh/tab";
import { DOCS_TOPICS } from "../docs";
import {
	COMMANDS, COMPLETION_SHELLS, GLOBAL_OPTIONS,
	type CommandArgument, type CommandOption,
} from "./help";

export class CompletionUsageError extends Error {
	constructor() {
		super("Usage: ephyra complete <bash|zsh|fish|powershell>\nRun `ephyra help complete` for details.");
	}
}

function addOption(command: Command, option: CommandOption): void {
	const names = option.flags.filter((flag) => flag.startsWith("--"));
	const alias = option.flags.find((flag) => /^-[^-]$/.test(flag))?.slice(1);
	// Passing a handler (even an empty one) tells tab to consume the value. Otherwise it is a boolean flag.
	const values = option.value === undefined ? undefined : (complete: Complete) => {
		for (const value of option.values ?? []) complete(value, "");
	};
	for (const [index, name] of names.entries()) {
		if (values) command.option(name.slice(2), option.description, values, index === 0 ? alias : undefined);
		else command.option(name.slice(2), option.description, index === 0 ? alias : undefined);
	}
}

function addArgument(command: Command, argument: CommandArgument): void {
	command.argument(argument.name, (complete) => {
		if (argument.catalog === "commands") {
			for (const entry of COMMANDS)
				for (const name of [entry.name, ...(entry.aliases ?? [])]) complete(name, entry.summary);
		} else if (argument.catalog === "docs") {
			complete("index", "Documentation overview");
			for (const [topic, description] of Object.entries(DOCS_TOPICS)) complete(topic, description);
		} else {
			for (const value of argument.values ?? []) complete(value, "");
		}
	});
}

/** One fresh catalog per request: tab's default export is a mutable process-wide singleton. */
export function createCompletion(): RootCommand {
	const root = new RootCommand();
	for (const option of GLOBAL_OPTIONS) addOption(root, option);
	for (const entry of COMMANDS) {
		for (const name of [entry.name, ...(entry.aliases ?? [])]) {
			const command = root.command(name, entry.summary);
			for (const option of GLOBAL_OPTIONS) {
				// `complete` prints a shell protocol, never JSON. --version applies only at the root.
				if (!option.rootOnly && !(entry.name === "complete" && option.flags.includes("--json")))
					addOption(command, option);
			}
			for (const option of entry.options ?? []) addOption(command, option);
			for (const argument of entry.arguments ?? []) addArgument(command, argument);
		}
	}
	return root;
}

/**
 * Print either a shell script or the tab completion protocol. No credentials, repository reads or API calls.
 * Pass arguments after `complete`. Dispatch `complete -- ...` before the CLI consumes global flags.
 */
export function complete(args: readonly string[]): void {
	const root = createCompletion();
	if (args[0] === "--") {
		// tab consumes its argument array; preserve the caller's copy, including the final empty word.
		root.parse(args.slice(1));
		return;
	}
	if (args.length !== 1 || !COMPLETION_SHELLS.some((shell) => shell === args[0])) throw new CompletionUsageError();
	root.setup("ephyra", "ephyra", args[0]!);
}
