// /auth/* routes: browser login and callback, CLI approval and collection, whoami, logout.
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomToken } from "./crypto.ts";
import { SignInError, userCode, type NotOrganicSignIn } from "./notorganic.ts";
import { cliApprovalView, cliApprovedView, cliExpiredView, signInFailedView } from "./views.ts";
import { browserRequestAllowed, browserSessionToken, sessionCookieName, sessionCookieOptions } from "./browser-session.ts";

const LOGIN_COOKIE = "ephyra_login";

const secure = (origin: string) => origin.startsWith("https://");

function fail(c: Context, error: unknown) {
  const status = error instanceof SignInError ? error.status : 502;
  const message = error instanceof SignInError ? error.message : "Sign-in failed. Try again.";
  if (!(error instanceof SignInError)) console.log(JSON.stringify({ msg: "sign-in error", error: String(error).slice(0, 300) }));
  return c.html(signInFailedView(message), status);
}

export function authRoutes(signIn: NotOrganicSignIn, approvers: ReadonlySet<string>, setupScopes?: (did: string) => Promise<string[]>): Hono {
  const app = new Hono();
  const origin = signIn.config.publicOrigin;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });

  app.get("/session", async (c) => {
    const principal = await signIn.authenticate(browserSessionToken(c, origin) ?? "");
    return c.json({ signIn: true, identity: principal ? {
      principal: principal.did, ...(principal.handle ? { alias: principal.handle } : {}), kind: "human", approver: approvers.has(principal.did),
    } : null });
  });

  // Browser entry point. `?cli=<challenge>` binds this login to an `ephyra login` waiting in a terminal.
  app.get("/login", async (c) => {
    try {
      const browser = randomToken();
      const cli = c.req.query("cli");
      const principal = c.req.query("setup") === "1" ? await signIn.authenticate(browserSessionToken(c, origin) ?? "") : null;
      const scopes = principal && setupScopes ? await setupScopes(principal.did) : [];
      const url = await signIn.begin(browser, cli || undefined, scopes);
      setCookie(c, LOGIN_COOKIE, browser, { httpOnly: true, secure: secure(origin), sameSite: "Lax", path: "/auth", maxAge: 600 });
      return c.redirect(url, 302);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/callback", async (c) => {
    const browser = getCookie(c, LOGIN_COOKIE);
    deleteCookie(c, LOGIN_COOKIE, { path: "/auth" });
    try {
      const result = await signIn.complete(new URL(c.req.url).searchParams, browser);
      const who = result.principal.handle ?? result.principal.did;
      const approver = approvers.has(result.principal.did);
      if (!result.cli) {
        setCookie(c, sessionCookieName(origin), result.token, sessionCookieOptions(origin));
        return c.redirect("/app/", 303);
      }
      const code = userCode(result.cli.challenge);
      return c.html(cliApprovalView({ who, approver, code, challenge: result.cli.challenge, csrf: result.cli.csrf }));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/cli/approve", async (c) => {
    const form = await c.req.parseBody();
    const ok = await signIn.approveCli(String(form.challenge ?? ""), String(form.csrf ?? ""));
    if (!ok) return c.html(cliExpiredView(), 400);
    return c.html(cliApprovedView());
  });

  // The CLI polls with the preimage of its challenge: 428 while waiting, 200 with the session once approved.
  app.post("/cli/token", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { verifier?: unknown };
    const result = await signIn.collectCli(typeof body.verifier === "string" ? body.verifier : "");
    if (result === "pending") return c.json({ status: "pending" }, 428);
    if (!result) return c.json({ error: "unknown or expired sign-in" }, 404);
    return c.json({ token: result.token, did: result.principal.did, handle: result.principal.handle ?? null,
      approver: approvers.has(result.principal.did) }, 200, { "cache-control": "no-store" });
  });

  app.get("/me", async (c) => {
    const authorization = c.req.header("Authorization");
    const token = authorization === undefined ? browserSessionToken(c, origin) ?? "" : authorization.replace(/^Bearer /, "");
    const principal = await signIn.authenticate(token);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    return c.json({ ...principal, approver: approvers.has(principal.did) });
  });

  app.post("/logout", async (c) => {
    const authorization = c.req.header("Authorization");
    if (authorization === undefined && !browserRequestAllowed(c, origin)) {
      return c.json({ error: "browser requests must come from this application" }, 403);
    }
    const token = authorization === undefined ? browserSessionToken(c, origin) ?? "" : authorization.replace(/^Bearer /, "");
    if (await signIn.authenticate(token)) await signIn.logout(token);
    if (authorization === undefined) deleteCookie(c, sessionCookieName(origin), sessionCookieOptions(origin));
    return c.json({ ok: true });
  });

  return app;
}
