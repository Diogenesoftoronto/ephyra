#!/usr/bin/env bun
import { runCli } from "./commands/cli";

await runCli(process.argv.slice(2));
