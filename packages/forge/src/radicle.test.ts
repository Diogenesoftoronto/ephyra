import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { RadicleAdapter } from "./radicle";

// Recorded upstream radicle-cli 0.17 examples/rad-cob-show.md (not a live Radicle run).
test("COB list and show produce stable resumable revision events", async () => {
  const list = await readFile(
    new URL("./fixtures/rad-cob-list.txt", import.meta.url),
    "utf8",
  );
  const show = await readFile(
    new URL("./fixtures/rad-cob-show.json", import.meta.url),
    "utf8",
  );
  const commands: string[][] = [];
  const run = async (args: string[]) => {
    commands.push(args);
    return { code: 0, stdout: args[2] === "list" ? list : show, stderr: "" };
  };
  const adapter = new RadicleAdapter(".", "rad:example", run);
  const events = [];
  for await (const event of adapter.events(null)) events.push(event);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "proposal.opened",
    occurredAt: "2022-12-15T17:28:04.000Z",
  });
  const resumed = [];
  for await (const event of adapter.events(events[0]!.cursor))
    resumed.push(event);
  expect(resumed).toHaveLength(0);
  expect(commands[0]?.slice(0, 3)).toEqual(["rad", "cob", "list"]);
});
