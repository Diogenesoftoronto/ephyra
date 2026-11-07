import { join } from "node:path";
import { createSite } from "./site.ts";

const port = Number(process.env.PORT ?? 3000);
const origin = process.env.EPHYRA_SITE_ORIGIN ?? `http://127.0.0.1:${port}`;
const home = (process.env.EPHYRA_HOME_CUT ?? "") as "" | "b" | "c";
if (!["", "b", "c"].includes(home)) throw new Error("EPHYRA_HOME_CUT must be empty, b or c");
const handler = createSite({
  origin, home, root: process.env.EPHYRA_SITE_ROOT ?? join(import.meta.dir, "../../../site"),
  ...(process.env.EPHYRA_BLOG_PUBLICATION_URI ? { publicationUri: process.env.EPHYRA_BLOG_PUBLICATION_URI } : {}),
  ...(process.env.EPHYRA_API_ORIGIN ? { apiOrigin: process.env.EPHYRA_API_ORIGIN } : {}),
});
const server = Bun.serve({ hostname: "0.0.0.0", port, fetch: handler });
const blog = Boolean(process.env.EPHYRA_BLOG_PUBLICATION_URI);
console.log(JSON.stringify({ msg: "ephyra site listening", port: server.port, origin, home: home || "a", blog }));
// As PID 1 in a container, Bun only exits on SIGTERM if it handles it.
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
