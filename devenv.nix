{ pkgs, ... }:
{
  packages = [ pkgs.git pkgs.bun pkgs.jq ];

  profiles.forge.module.packages = [ pkgs.radicle-node ];

  # Durable state uses Convex; without CONVEX_URL the API uses ephemeral memory.
  processes.server.exec = "bun run dev:server";
  processes.console.exec = "bun run dev:console";
  processes.storybook.exec = "bun run storybook --no-open --host 127.0.0.1";
  processes.textbook.exec = "bun run --cwd apps/cli textbook";

  scripts = {
    ephyra-check.exec = "bun run check";
    ephyra-check-package.exec = ''bun run check:package "$@"'';
    ephyra-test.exec = ''bun test "$@"'';
    ephyra-smoke.exec = "bun run test:smoke";
    ephyra-interactions.exec = "bun run test:interactions";
  };

  enterTest = ''
    bun install
    bun run typecheck
    bun test
  '';
}
