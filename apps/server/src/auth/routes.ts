// /auth/* routes: browser login and callback, CLI approval and collection, whoami, logout.
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomToken } from "./crypto.ts";
import { SignInError, userCode, type NotOrganicSignIn } from "./notorganic.ts";

const LOGIN_COOKIE = "ephyra_login";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6efe1;--fg:#2b2117;--muted:#6b5a48;--accent:#e8a33c}
@media (prefers-color-scheme:dark){:root{--bg:#121822;--fg:#f2ead9;--muted:#bba98f}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;padding:2rem 1.25rem}h1{font-size:1.5rem;margin:0 0 .75rem}p{color:var(--muted)}
.code{font:600 1.6rem ui-monospace,monospace;letter-spacing:.08em;color:var(--fg)}
button{font:inherit;font-weight:600;padding:.7em 1.3em;border:0;border-radius:999px;background:var(--accent);color:#22180c;cursor:pointer}
</style></head><body><main>${body}</main></body></html>`;
}

const secure = (origin: string) => origin.startsWith("https://");

function fail(c: Context, error: unknown) {
  const status = error instanceof SignInError ? error.status : 502;
  const message = error instanceof SignInError ? error.message : "Sign-in failed. Try again.";
  if (!(error instanceof SignInError)) console.log(JSON.stringify({ msg: "sign-in error", error: String(error).slice(0, 300) }));
  return c.html(page("Sign-in failed", `<h1>Sign-in failed</h1><p>${escape(message)}</p>`), status);
}

export function authRoutes(signIn: NotOrganicSignIn, approvers: ReadonlySet<string>): Hono {
  const app = new Hono();
  const origin = signIn.config.publicOrigin;

  // Browser entry point. `?cli=<challenge>` binds this login to an `ephyra login` waiting in a terminal.
  app.get("/login", async (c) => {
    try {
      const browser = randomToken();
      const cli = c.req.query("cli");
      const url = await signIn.begin(browser, cli || undefined);
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
      const who = escape(result.principal.handle ?? result.principal.did);
      const role = approvers.has(result.principal.did)
        ? "This account can approve trail checkpoints."
        : "This account is signed in but is not on this deployment's approver list.";
      if (!result.cli) {
        return c.html(page("Signed in", `<h1>Signed in as ${who}</h1><p>${role}</p>
<p>To approve trails from your terminal, run <code>ephyra login</code>.</p>`));
      }
      const code = userCode(result.cli.challenge);
      return c.html(page("Approve terminal sign-in", `<h1>Sign in to the Ephyra CLI?</h1>
<p>Signed in as ${who}. Only approve if your terminal shows this code:</p><p class="code">${escape(code)}</p>
<form method="post" action="/auth/cli/approve">
<input type="hidden" name="challenge" value="${escape(result.cli.challenge)}">
<input type="hidden" name="csrf" value="${escape(result.cli.csrf)}">
<button type="submit">Approve</button></form><p>${role}</p>`));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/cli/approve", async (c) => {
    const form = await c.req.parseBody();
    const ok = await signIn.approveCli(String(form.challenge ?? ""), String(form.csrf ?? ""));
    if (!ok) return c.html(page("Not approved", "<h1>This sign-in request expired</h1><p>Run <code>ephyra login</code> again.</p>"), 400);
    return c.html(page("Approved", "<h1>Approved</h1><p>Return to your terminal. You can close this tab.</p>"));
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
    const token = (c.req.header("Authorization") ?? "").replace(/^Bearer /, "");
    const principal = await signIn.authenticate(token);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    return c.json({ ...principal, approver: approvers.has(principal.did) });
  });

  app.post("/logout", async (c) => {
    const token = (c.req.header("Authorization") ?? "").replace(/^Bearer /, "");
    if (await signIn.authenticate(token)) await signIn.logout(token);
    return c.json({ ok: true });
  });

  return app;
}
