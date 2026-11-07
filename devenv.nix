{ pkgs, ... }:
{
  packages = [ pkgs.git pkgs.bun pkgs.jq ];

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

  enterTest = ''
    bun install
    bun run typecheck
    bun test
  '';
}
