import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { VoiceAudioInput, VoiceReplyInput, VoiceSpeechInput, ReconciliationRequired } from "@ephyra/core";
import type { AuthEnv } from "./auth.ts";
import type { VoiceService } from "../voice.ts";
import { VoiceError } from "../voice-provider.ts";

/** Mounted inside /v1 authentication and its approver gate: voice spends the deployment's account. */
export function voiceRoutes(service: VoiceService) {
  const app = new Hono<AuthEnv>();
  app.use("/v1/voice/transcribe", bodyLimit({ maxSize: 5_400_000 }));
  app.use("/v1/voice/reply", bodyLimit({ maxSize: 150_000 }));
  app.use("/v1/voice/speak", bodyLimit({ maxSize: 20_000 }));
  app.onError((e, c) => {
    if (e instanceof ReconciliationRequired)
      return c.json(
        { error: e.message, code: "reconciliation_required", operationKey: c.req.header("Idempotency-Key") },
        504,
      );
    if (e instanceof VoiceError)
      return c.json({ error: e.message, code: e.code, operationKey: c.req.header("Idempotency-Key") }, e.status);
    return c.json(
      { error: "Voice could not finish. Check Usage before trying again.", code: "reconciliation_required" },
      504,
    );
  });
  app.get("/v1/voice", (c) => c.json(service.capabilities()));
  const body = async <T extends z.ZodTypeAny>(
    c: { req: { json(): Promise<unknown> } },
    schema: T,
  ): Promise<z.infer<T>> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new VoiceError(400, "Invalid voice request.");
    return parsed.data;
  };
  app.post("/v1/voice/transcribe", async (c) =>
    c.json(
      await service.transcribe(
        c.get("principal"),
        c.req.header("Idempotency-Key") ?? "",
        await body(c, VoiceAudioInput),
        c.req.raw.signal,
      ),
    ),
  );
  app.post("/v1/voice/speak", async (c) =>
    c.json(
      await service.speak(
        c.get("principal"),
        c.req.header("Idempotency-Key") ?? "",
        (await body(c, VoiceSpeechInput)).text,
        c.req.raw.signal,
      ),
    ),
  );
  app.post("/v1/voice/reply", async (c) =>
    c.json(
      await service.reply(
        c.get("principal"),
        c.req.header("Idempotency-Key") ?? "",
        await body(c, VoiceReplyInput),
        c.req.raw.signal,
      ),
    ),
  );
  return app;
}
