{ pkgs, ... }:
{
  packages = [ pkgs.git pkgs.bun pkgs.jq ];

  profiles.forge.module.packages = [ pkgs.radicle-node ];

  # Postgres for DBOS workflows and projections (apps/server).
  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    listen_addresses = "127.0.0.1";
    port = 54329;
    initialDatabases = [ { name = "ephyra"; } ];
  };
  env.DATABASE_URL = "postgres://127.0.0.1:54329/ephyra";

  processes.server.exec = "bun run apps/server/src/main.ts";
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
