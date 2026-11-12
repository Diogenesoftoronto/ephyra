// Investigation questions on a self-hosted server: what a quest is asking, of whom, and a way for that person to answer.
// The hosted application has its own account-scoped routes for the same paths (application.ts); these are mounted only
// when there is no workspace account in front of the server.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { InvestigationAnswer, ReconciliationRequired, Unverified } from "@ephyra/core";
import type { InvestigationQuestions } from "../setup/questions.ts";
import type { AuthEnv } from "./auth.ts";

/**
 * Reading is open to any authenticated principal: a question is part of the quest it belongs to. Answering is not. Only
 * the principal the question was addressed to may answer it, and the answer is still checked before the quest resumes.
 */
export function questionRoutes(questions: InvestigationQuestions): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const fresh = { "Cache-Control": "no-store" };
  app.get("/v1/questions", async (c) => c.json(await questions.list(), 200, fresh));
  app.get("/v1/questions/:trail/:question", async (c) =>
    c.json(await questions.get(c.req.param("trail"), c.req.param("question")) ?? null, 200, fresh));
  app.post("/v1/questions/:trail/:question/answer", bodyLimit({ maxSize: 20_000 }), async (c) => {
    const value = InvestigationAnswer.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Enter a concise factual answer." }, 400);
    const question = await questions.get(c.req.param("trail"), c.req.param("question"));
    if (!question || !question.recipient?.did || question.recipient.did !== c.get("principal")) {
      return c.json({ error: "This question is for another recipient." }, 403);
    }
    try {
      return c.json(await questions.answer(question.trailId, question.id, question.recipient.id, value.data.text));
    } catch (error) {
      if (error instanceof ReconciliationRequired) {
        return c.json({ error: "The answer's outcome is uncertain. Reload before retrying." }, 409);
      }
      if (error instanceof Unverified) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  return app;
}
