import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BootstrapReport, SetupRequest } from "@ephyra/core";
import { AgentAuthError, type AgentAccess } from "../auth/agent-service.ts";
import type { AgentPrincipal, AgentScope } from "../auth/agent-store.ts";
import type { Composed } from "../compose.ts";
import { SetupConflict } from "../setup/automation.ts";

type AgentEnv = { Variables: { agent: AgentPrincipal; agentToken: string } };
type Options = { access: AgentAccess; runtime: (agent: AgentPrincipal) => Promise<Composed> };

/** A terminal API namespace: agent credentials never enter the human account/checkpoint router. */
export function agentSetupRoutes({ access, runtime }: Options) {
  const app = new Hono<AgentEnv>();
  app.use("/v1/agent/*", bodyLimit({ maxSize: 24_000 }));
  app.use("/v1/agent/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const authorization = c.req.header("Authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const agent = await access.authenticate(token);
    if (!agent) return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": access.challenge() });
    c.set("agent", agent); c.set("agentToken", token);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof SetupConflict) return c.json({ error: error.message }, 409);
    if (error instanceof AgentAuthError) return c.json({ error: error.code, error_description: error.message }, error.status);
    return c.json({ error: "The setup outcome is unconfirmed. Read the recorded state before doing more work." }, 503);
  });
  const allowed = (agent: AgentPrincipal, scope: AgentScope) => agent.scopes.includes(scope);
  const owned = async <T>(token: string, scope: AgentScope, fn: (composed: Composed, agent: AgentPrincipal) => Promise<T>) => {
    const principal = await access.authenticate(token, scope);
    if (!principal) throw new SetupConflict("The agent grant or repository changed. Obtain a new owner claim.");
    const composed = await runtime(principal);
    return composed.withOwner(async () => {
      const fresh = await access.authenticate(token, scope);
      if (!fresh) throw new SetupConflict("The agent grant or repository changed. Obtain a new owner claim.");
      return fn(composed, fresh);
    });
  };
  app.get("/v1/agent/setup", async (c) => {
    if (!allowed(c.get("agent"), "bootstrap:read")) return c.json({ error: "insufficient_scope" }, 403);
    const key = c.req.query("operationKey");
    if (key && !/^[A-Za-z0-9:._-]{8,160}$/.test(key)) return c.json({ error: "Invalid setup operation key." }, 400);
    const result = await (await runtime(c.get("agent"))).setup.current(key);
    if (!await access.authenticate(c.get("agentToken"), "bootstrap:read")) return c.json({ error: "invalid_token" }, 401);
    return c.json(result);
  });
  app.post("/v1/agent/setup", async (c) => {
    if (!allowed(c.get("agent"), "bootstrap:run")) return c.json({ error: "insufficient_scope" }, 403);
    const parsed = SetupRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data.mode !== "supervised") return c.json({ error: "Only supervised setup is delegated to agents." }, 400);
    return c.json(await owned(c.get("agentToken"), "bootstrap:run", async (composed) =>
      composed.setup.start("supervised", await access.setupOperation(c.get("agentToken"), c.req.header("Idempotency-Key") ?? ""))), 202);
  });
  app.post("/v1/agent/bootstrap/report", async (c) => {
    if (!allowed(c.get("agent"), "bootstrap:context")) return c.json({ error: "insufficient_scope" }, 403);
    const input = BootstrapReport.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Supply a bounded report tied to the current setup and commit." }, 400);
    return c.json(await owned(c.get("agentToken"), "bootstrap:context", (composed, principal) =>
      composed.setup.report(input.data, { id: principal.registrationId, kind: "agent" }, c.req.header("Idempotency-Key") ?? "")));
  });
  app.post("/v1/agent/bootstrap/reassess", async (c) => {
    if (!allowed(c.get("agent"), "bootstrap:run")) return c.json({ error: "insufficient_scope" }, 403);
    if (!/^[A-Za-z0-9:._-]{8,160}$/.test(c.req.header("Idempotency-Key") ?? ""))
      return c.json({ error: "A stable operation key is required." }, 400);
    return c.json(await owned(c.get("agentToken"), "bootstrap:run", (composed) => composed.setup.reassess()));
  });
  app.all("/v1/agent/*", (c) => c.json({ error: "Agent capability unavailable." }, 404));
  return app;
}
