import { join } from "node:path";
import { createSite, HOME_CUTS, type HomeCut } from "./site.ts";

const port = Number(process.env.PORT ?? 3000);
const origin = process.env.EPHYRA_SITE_ORIGIN ?? `http://127.0.0.1:${port}`;
// Cut E is the main site. EPHYRA_HOME_CUT can put an earlier cut at "/" instead.
const home = (process.env.EPHYRA_HOME_CUT || "e") as HomeCut;
if (!HOME_CUTS.includes(home)) throw new Error(`EPHYRA_HOME_CUT must be one of ${HOME_CUTS.join(", ")}`);
const handler = createSite({
  origin, home, root: process.env.EPHYRA_SITE_ROOT ?? join(import.meta.dir, "../../../site"),
  redirectOrigins: (process.env.EPHYRA_SITE_REDIRECT_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ...(process.env.EPHYRA_BLOG_PUBLICATION_URI ? { publicationUri: process.env.EPHYRA_BLOG_PUBLICATION_URI } : {}),
  ...(process.env.EPHYRA_API_ORIGIN ? { apiOrigin: process.env.EPHYRA_API_ORIGIN } : {}),
});
const server = Bun.serve({ hostname: "0.0.0.0", port, fetch: handler });
const blog = Boolean(process.env.EPHYRA_BLOG_PUBLICATION_URI);
console.log(JSON.stringify({ msg: "ephyra site listening", port: server.port, origin, home, blog }));
// As PID 1 in a container, Bun only exits on SIGTERM if it handles it.
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
