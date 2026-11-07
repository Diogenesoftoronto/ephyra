import type { Context } from "hono";
import { getCookie } from "hono/cookie";

/** Host-only, HTTP-only browser credentials. Plain HTTP is supported for local self-hosting. */
export const sessionCookieName = (origin: string) => origin.startsWith("https://") ? "__Host-ephyra_session" : "ephyra_session";
export const sessionCookieOptions = (origin: string) => ({
  httpOnly: true, secure: origin.startsWith("https://"), sameSite: "Lax" as const, path: "/",
});

export const browserSessionToken = (c: Context, origin: string) => getCookie(c, sessionCookieName(origin));

/** SameSite alone does not protect against another application on the same site. */
export const browserRequestAllowed = (c: Context, origin: string) =>
  ["GET", "HEAD", "OPTIONS"].includes(c.req.method) || c.req.header("Origin") === origin;
