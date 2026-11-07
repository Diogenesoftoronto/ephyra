import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TutorInput, ReconciliationRequired } from "@ephyra/core";
import type { AuthEnv } from "./auth.ts";
import type { TutorService } from "../tutor.ts";
import { VoiceError } from "../voice-provider.ts";

export function tutorRoutes(service: TutorService) {
  const app = new Hono<AuthEnv>();
  app.use("/v1/tutor/explain", bodyLimit({ maxSize: 40_000 }));
  app.onError((e, c) => {
    if (e instanceof VoiceError) return c.json({ error: e.message, code: e.code }, e.status);
    return c.json(
      {
        error: e instanceof ReconciliationRequired ? e.message : "The Tutor outcome is uncertain. Check Usage.",
        code: "reconciliation_required",
      },
      504,
    );
  });
  app.get("/v1/tutor", (c) => c.json(service.capabilities()));
  app.post("/v1/tutor/explain", async (c) => {
    const parsed = TutorInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new VoiceError(400, "Invalid Tutor question.");
    return c.json(
      await service.explain(c.get("principal"), c.req.header("Idempotency-Key") ?? "", parsed.data, c.req.raw.signal),
    );
  });
  return app;
}
