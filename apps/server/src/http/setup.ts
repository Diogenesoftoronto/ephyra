import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SetupRequest } from "@ephyra/core";
import type { AuthEnv } from "./auth.ts";
import { AutomaticSetup, SetupConflict } from "../setup/automation.ts";

/** Mounted behind the workspace authentication and mutation policy. */
export function setupRoutes(setup: AutomaticSetup): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/v1/setup", bodyLimit({ maxSize: 1024 }));
  app.get("/v1/setup", async (c) => {
    c.header("Cache-Control", "no-store");
    const key = c.req.query("operationKey");
    if (key && !/^[A-Za-z0-9:._-]{8,160}$/.test(key)) return c.json({ error: "Invalid setup operation key." }, 400);
    return c.json(await setup.current(key));
  });
  app.post("/v1/setup", async (c) => {
    c.header("Cache-Control", "no-store");
    const input = SetupRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Choose autonomous or supervised setup." }, 400);
    try {
      return c.json(await setup.start(input.data.mode, c.req.header("Idempotency-Key") ?? ""), 202);
    } catch (error) {
      if (error instanceof SetupConflict) return c.json({ error: error.message }, 409);
      return c.json({ error: "Setup could not be confirmed. Refresh its recorded status before starting again." }, 503);
    }
  });
  return app;
}
