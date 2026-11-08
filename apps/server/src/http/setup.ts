import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BootstrapResponse, SetupRequest } from "@ephyra/core";
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
  app.get("/v1/setup/runs/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("id");
    if (!/^[a-f0-9]{32}$/.test(id)) return c.json({ error: "Invalid setup record." }, 400);
    return c.json(await setup.record(id));
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
  app.use("/v1/setup/bootstrap/*", bodyLimit({ maxSize: 20_000 }));
  app.post("/v1/setup/bootstrap/answer", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.get("principalKind") !== "human") return c.json({ error: "Sign in to answer setup questions." }, 403);
    const input = BootstrapResponse.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Enter a factual answer for the current setup request." }, 400);
    try { return c.json(await setup.respond(input.data, { id: c.get("principal"), kind: "human" }, c.req.header("Idempotency-Key") ?? "")); }
    catch (error) {
      if (error instanceof SetupConflict) return c.json({ error: error.message }, 409);
      return c.json({ error: "The answer is unconfirmed. Refresh the recorded request before answering again." }, 503);
    }
  });
  app.post("/v1/setup/bootstrap/reassess", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!/^[A-Za-z0-9:._-]{8,160}$/.test(c.req.header("Idempotency-Key") ?? ""))
      return c.json({ error: "A stable operation key is required." }, 400);
    try { return c.json(await setup.reassess()); }
    catch { return c.json({ error: "Coverage could not be refreshed. Read the recorded setup state." }, 503); }
  });
  return app;
}
