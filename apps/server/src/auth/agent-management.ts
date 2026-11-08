import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { browserRequestAllowed, browserSessionToken } from "./browser-session.ts";
import { sha256b64url, type SecretBox } from "./crypto.ts";
import type { AgentAccess } from "./agent-service.ts";

const escape = (text: string) => text.replace(/[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const headers = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
function page(body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent access · Ephyra</title><style>
:root{color-scheme:light dark;--bg:#f6efe1;--fg:#2b2117;--muted:#6b5a48;--accent:#e8a33c}
@media(prefers-color-scheme:dark){:root{--bg:#121822;--fg:#f2ead9;--muted:#bba98f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:46rem;margin:5vh auto;padding:1.5rem}h1{line-height:1.2}p,small{color:var(--muted)}
a{color:inherit}code{overflow-wrap:anywhere}article{border-top:1px solid var(--muted);padding:1rem 0}
button,.button{display:inline-block;font:inherit;font-weight:600;padding:.65em 1.2em;border:0;border-radius:999px;
background:var(--accent);color:#22180c;cursor:pointer;text-decoration:none}:focus-visible{outline:3px solid currentColor;outline-offset:4px}
</style></head><body><main><a href="/app/#/settings">← Settings</a><h1>Agent access</h1>${body}</main></body></html>`;
}

/** Owner-only management. The CSRF receipt is sealed, short lived and tied to this browser session. */
export function agentManagementRoutes(access: AgentAccess, box: SecretBox) {
  const app = new Hono();
  app.get("/agent/access", async (c) => {
    const session = browserSessionToken(c, access.origin) ?? "";
    const principal = await access.signIn.authenticate(session);
    if (!principal) return c.html(page(`<p>Sign in to view your repository grants and the DID your agent needs.</p>
<a class="button" href="/auth/login?returnTo=%2Fagent%2Faccess">Sign in with Not Organic</a>`), 200, headers);
    const csrf = await box.seal({ kind: "agent-management-v1", did: principal.did,
      sessionHash: await sha256b64url(session), expiresMs: Date.now() + 10 * 60_000 });
    const grants = await access.list(principal.did);
    const records = grants.map(grant => `<article><h2>${escape(grant.repository.url)}</h2>
<p>Branch <code>${escape(grant.repository.branch)}</code> · expires ${escape(grant.expiresAt)}</p>
<p>Scopes: ${grant.scopes.map(escape).join(", ")}</p><p>Registration <code>${escape(grant.id)}</code></p>
${grant.revokedAt ? `<p>Revoked ${escape(grant.revokedAt)}</p>` : `<form method="post" action="/agent/access">
<input type="hidden" name="registration" value="${escape(grant.id)}"><input type="hidden" name="csrf" value="${escape(csrf)}">
<button type="submit">Revoke this agent</button></form>`}</article>`).join("");
    return c.html(page(`<p>Give your agent this Not Organic DID and <a href="/auth.md">the setup instructions</a>.</p>
<p><code>${escape(principal.did)}</code></p><p>Each grant belongs to one repository, branch and workspace.
Changing the workspace invalidates access. Agents cannot approve human checkpoints or grant spending.</p>
${records || "<p>No agent has been granted repository access.</p>"}`), 200, headers);
  });
  app.post("/agent/access", bodyLimit({ maxSize: 8_000 }), async (c) => {
    if (!browserRequestAllowed(c, access.origin)) return c.html(page("<p>Open this page in Ephyra before revoking access.</p>"), 403, headers);
    const session = browserSessionToken(c, access.origin) ?? "";
    const principal = await access.signIn.authenticate(session);
    if (!principal) return c.html(page("<p>Sign in to revoke agent access.</p>"), 401, headers);
    const form = await c.req.parseBody();
    try {
      const ticket = await box.open<{ kind: string; did: string; sessionHash: string; expiresMs: number }>(String(form.csrf ?? ""));
      if (ticket.kind !== "agent-management-v1" || ticket.did !== principal.did || ticket.expiresMs <= Date.now()
        || ticket.sessionHash !== await sha256b64url(session)) throw new Error("Invalid receipt");
    } catch { return c.html(page("<p>This page expired. <a href=\"/agent/access\">Reload agent access</a>.</p>"), 403, headers); }
    const revoked = await access.revokeOwned(principal.did, String(form.registration ?? ""));
    if (!revoked) return c.html(page("<p>This registration does not belong to your account.</p>"), 404, headers);
    return c.redirect("/agent/access", 303);
  });
  return app;
}
