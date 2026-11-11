import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ReconciliationRequired, UsageForecastCapability, UsageForecastInput } from "@ephyra/core";
import type { AuthEnv } from "./auth.ts";
import { ForecastError, type UsageForecastService } from "../usage-forecast.ts";

/** GET is free and describes the route. POST is the only call that can spend, and it needs an Idempotency-Key. */
export function usageForecastRoutes(service: UsageForecastService) {
  const app = new Hono<AuthEnv>();
  app.use("/v1/usage/forecast", bodyLimit({ maxSize: 2_000 }));
  app.onError((e, c) => {
    const operationKey = c.req.header("Idempotency-Key");
    if (e instanceof ReconciliationRequired) return c.json({ error: e.message, code: "reconciliation_required", operationKey }, 504);
    if (e instanceof ForecastError) {
      if (e.retryAfterSeconds !== undefined) c.header("Retry-After", String(e.retryAfterSeconds));
      return c.json(
        {
          error: e.message,
          code: e.code,
          operationKey,
          ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
        },
        e.status,
      );
    }
    return c.json({ error: "The forecast could not finish. Check Usage before asking again.", code: "reconciliation_required", operationKey }, 502);
  });
  app.get("/v1/usage/forecast", (c) => c.json(UsageForecastCapability.parse(service.capability())));
  app.post("/v1/usage/forecast", async (c) => {
    const parsed = UsageForecastInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ForecastError(400, "Choose a complete history window and a horizon of 1 to 30 days.", "invalid_request");
    c.header("Cache-Control", "no-store");
    return c.json(await service.forecast(c.get("principal"), c.req.header("X-Ephyra-Workspace") ?? "deployment",
      c.req.header("Idempotency-Key") ?? "", parsed.data, c.req.raw.signal));
  });
  return app;
}
