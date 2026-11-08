import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AMP_REPORT_MAX_BYTES, type AmpReportInbox } from "@ephyra/agent";

/** Mount outside browser/service-token auth: this route verifies short-lived executor identity through the inbox. */
export function ampReportRoutes(inbox: AmpReportInbox): Hono {
  const app = new Hono();
  app.post("/amp/reports/:nonce", bodyLimit({ maxSize: AMP_REPORT_MAX_BYTES }), async (c) => {
    c.header("Cache-Control", "no-store");
    const authorization = c.req.header("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return c.json({ error: "Executor authentication required." }, 401);
    try {
      const receipt = await inbox.accept(c.req.param("nonce"), authorization.slice(7), await c.req.json());
      return c.json(receipt, 201);
    } catch {
      return c.json({ error: "The executor report could not be authenticated or bound to current work." }, 422);
    }
  });
  return app;
}
