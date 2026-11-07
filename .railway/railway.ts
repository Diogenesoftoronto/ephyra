// Ephyra on Railway: the control plane plus a volume for the git trail journal.
// Durable state lives in hosted Convex (team Tungsten-Cube, project ephyra, prod deployment loyal-bass-393).
// Preview: `railway config plan`. Apply: `railway config apply`. See apps/server/README.md.
//
// Secrets are set out of band and preserved here: EPHYRA_API_TOKEN, EPHYRA_CONVEX_SECRET.
import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const region = "us-east4-eqdc4a";
  // Superseded by Convex; kept so applying this file is never destructive. Remove once its data is not needed.
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
      EPHYRA_DATA_DIR: "/data",
      CONVEX_URL: "https://loyal-bass-393.convex.cloud",
      EPHYRA_CONVEX_SECRET: preserve(),
      EPHYRA_API_TOKEN: preserve(),
    },
  });

  return project("ephyra", { resources: [db, journal, server] });
});
