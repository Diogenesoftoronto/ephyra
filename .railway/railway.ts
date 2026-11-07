// Ephyra on Railway: control plane + Postgres + a volume for the git trail journal.
// Preview: `railway config plan`. Apply: `railway config apply`. See design/02-platform.md §6.
import { defineRailway, postgres, preserve, ref, service, volume } from "railway/iac";

export default defineRailway(() => {
  const region = "us-east4-eqdc4a";
  const db = postgres("postgres", { region });
  const journal = volume("journal-data", { region, sizeMB: 5000 });

  const server = service("server", {
    build: { builder: "DOCKERFILE", dockerfilePath: "infra/docker/Dockerfile.server" },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    replicas: { [region]: 1 },
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    volumeMounts: { "/data": journal },
    networking: { serviceDomains: { ephyra: { port: 3000 } } },
    env: {
      PORT: "3000",
      DATABASE_URL: ref(db, "DATABASE_URL"),
      EPHYRA_JOURNAL_DIR: "/data/journal.git",
      // Set once with `railway variables --set`; never committed.
      EPHYRA_API_TOKEN: preserve(),
    },
  });

  return [db, journal, server];
});
