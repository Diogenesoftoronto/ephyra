import { expect, test } from "bun:test";
import { COMMANDS, searchCommands } from "./CommandMenu.tsx";

test("page names rank ahead of incidental description matches", () => {
  expect(searchCommands("workspace").map(command => command.id)).toEqual(["workspace", "overview", "team"]);
  expect(searchCommands("  WORKSPACE  ")[0]?.id).toBe("workspace");
  expect(searchCommands("personas")[0]?.id).toBe("personas");
  expect(searchCommands("OPEN").map(command => command.id)).toEqual(["inbox", "runs", "workspace", "team", "settings"]);
  expect(searchCommands("draft")[0]?.id).toBe("workspace");
  expect(searchCommands("no such command")).toEqual([]);
  expect(searchCommands("")).toEqual([...COMMANDS]);
});
