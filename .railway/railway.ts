// Ephyra on Railway: the control plane plus a volume for the git trail journal.
// Durable state lives in hosted Convex (team Tungsten-Cube, project ephyra, prod deployment loyal-bass-393).
// Preview: `railway config plan`. Apply: `railway config apply`. See apps/server/README.md.
//
// Secrets are set out of band and preserved here: EPHYRA_API_TOKEN, EPHYRA_CONVEX_SECRET, EPHYRA_SESSION_KEY.
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
      // Sign in with Not Organic. The origin is registered in Not Organic's gateway
      // PUBLIC_CLIENT_PRODUCT_CATALOG (product "notorganic").
      EPHYRA_PUBLIC_ORIGIN: "https://server-production-932f.up.railway.app",
      EPHYRA_SESSION_KEY: preserve(),
      NOTORGANIC_PRODUCT: "notorganic",
      // dio.pds.notorganic.info and interleave.love (the owner's identities in Not Organic's admin list).
      EPHYRA_APPROVER_DIDS: "did:plc:45dp424mncijxohc4ba2eiyz,did:plc:vmbmkls2n72cmi66y7igy2ew",
    },
  });

  // Public site: landing, journal (Standard.site on AT Protocol), pricing, legal, robots/sitemap/llms.txt.
  const web = service("web", {
    build: { builder: "DOCKERFILE", dockerfilePath: "infra/docker/Dockerfile.web" },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    replicas: { [region]: 1 },
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    networking: { serviceDomains: { web: { port: 3000 } } },
    env: {
      PORT: "3000",
      // Renamed from the generated web-production-a088f domain. The journal's publication record must name this origin.
      EPHYRA_SITE_ORIGIN: "https://ephyra-site.up.railway.app",
      EPHYRA_HOME_CUT: "e",
      // Standard.site publication on the Ephyra PDS identity (ephyra.pds.notorganic.info).
      EPHYRA_BLOG_PUBLICATION_URI: "at://did:plc:soeyznq6axxxa7tarbdxccun/site.standard.publication/self",
      EPHYRA_API_ORIGIN: "https://server-production-932f.up.railway.app",
    },
  });

  return project("ephyra", { resources: [db, journal, server, web] });
});
