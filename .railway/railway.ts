// Ephyra on Railway: control plane + self-hosted Convex (durable state) + volumes.
// Preview: `railway config plan`. Apply: `railway config apply`. See design/02-platform.md §6.
//
// Convex keeps its database (SQLite) on its own volume. Convex functions are deployed separately with
// `bun run convex:deploy` in apps/server, using the admin key derived from the instance secret.
// Secrets are set out of band and preserved here: EPHYRA_API_TOKEN, EPHYRA_CONVEX_SECRET, INSTANCE_SECRET.
import { defineRailway, image, postgres, preserve, project, service, volume } from "railway/iac";

const CONVEX_IMAGE =
  "ghcr.io/convex/convex-backend@sha256:e9c084e8bd6c1f249012c672193f0988c748824f55a24cdad45f6185a8462f9a";

export default defineRailway(() => {
  const region = "us-east4-eqdc4a";
  // Superseded by Convex; kept so applying this file is never destructive. Remove once its data is not needed.
  const db = postgres("postgres", { region });
  const journal = volume("journal-data", { region, sizeMB: 5000 });
  const convexData = volume("convex-data", { region, sizeMB: 5000 });

  const convex = service("convex", {
    source: image(CONVEX_IMAGE),
    healthcheck: "/version",
    healthcheckTimeout: 60,
    replicas: { [region]: 1 },
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    volumeMounts: { "/convex/data": convexData },
    networking: { serviceDomains: { "ephyra-convex": { port: 3210 } } },
    env: {
      PORT: "3210",
      INSTANCE_NAME: "ephyra",
      INSTANCE_SECRET: preserve(),
      CONVEX_CLOUD_ORIGIN: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      CONVEX_SITE_ORIGIN: "https://${{RAILWAY_PUBLIC_DOMAIN}}/http",
      DISABLE_BEACON: "true",
      RUST_LOG: "info",
    },
  });

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
      CONVEX_URL: "https://${{convex.RAILWAY_PUBLIC_DOMAIN}}",
      EPHYRA_CONVEX_SECRET: preserve(),
      EPHYRA_API_TOKEN: preserve(),
    },
  });

  return project("ephyra", { resources: [db, journal, convexData, convex, server] });
});
