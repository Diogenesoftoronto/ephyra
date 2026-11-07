import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

export type AuthEnv = { Variables: { principal: string } };

export function auth(token: string) {
  if (!token) throw new Error("API token is required");
  return createMiddleware<AuthEnv>(async (context, next) => {
    const authorization = context.req.header("Authorization") ?? "";
    const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expectedBytes = Buffer.from(token);
    const providedBytes = Buffer.from(provided);
    const comparable = providedBytes.length === expectedBytes.length ? providedBytes : Buffer.alloc(expectedBytes.length);
    const valid = timingSafeEqual(expectedBytes, comparable) && providedBytes.length === expectedBytes.length;
    const principal = context.req.header("X-Ephyra-Principal")?.trim();
    if (!valid || !principal || principal.length > 200) return context.json({ error: "unauthorized" }, 401);
    context.set("principal", principal);
    await next();
  });
}
