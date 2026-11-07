#!/usr/bin/env bun
import { main } from "./commands/cli";

const args = process.argv.slice(2);
main(args).catch((error) => {
	const message = error instanceof Error ? error.message : "Command failed";
	console.error(
		args.includes("--json") ? JSON.stringify({ error: message }) : message,
	);
	process.exitCode = 1;
});
