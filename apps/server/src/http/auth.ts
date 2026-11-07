import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

export type PrincipalKind = "service" | "human";
export type AuthEnv = { Variables: { principal: string; principalKind: PrincipalKind } };

/** Resolves a Not Organic session token to a DID (present when sign-in is configured). */
export type SessionResolver = (token: string) => Promise<{ did: string; handle?: string } | null>;

function tokenMatches(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  const comparable = providedBytes.length === expectedBytes.length ? providedBytes : Buffer.alloc(expectedBytes.length);
  return timingSafeEqual(expectedBytes, comparable) && providedBytes.length === expectedBytes.length;
}

/**
 * Two ways in:
 * - the service token (machines, OTLP, local dev), which must name its principal in X-Ephyra-Principal;
 * - a Not Organic session token, whose principal is the account's DID (never a caller-supplied header).
 */
export function auth(token: string, sessions?: SessionResolver) {
  if (!token) throw new Error("API token is required");
  return createMiddleware<AuthEnv>(async (context, next) => {
    const authorization = context.req.header("Authorization") ?? "";
    const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (tokenMatches(token, provided)) {
      const principal = context.req.header("X-Ephyra-Principal")?.trim();
      if (!principal || principal.length > 200) return context.json({ error: "unauthorized" }, 401);
      context.set("principal", principal);
      context.set("principalKind", "service");
      return next();
    }
    const human = provided && sessions ? await sessions(provided) : null;
    if (!human) return context.json({ error: "unauthorized" }, 401);
    context.set("principal", human.did);
    context.set("principalKind", "human");
    return next();
  });
}
