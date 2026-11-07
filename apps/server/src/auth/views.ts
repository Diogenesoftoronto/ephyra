// The browser pages used by the sign-in routes. Inputs are text, never trusted markup.
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

const role = (approver: boolean) => approver
  ? "This account can approve trail checkpoints."
  : "This account is signed in but is not on this deployment's approver list.";

export function signedInView(who: string, approver: boolean): string {
  return page("Signed in", `<h1>Signed in as ${escape(who)}</h1><p>${role(approver)}</p>
<p>To approve trails from your terminal, run <code>ephyra login</code>.</p>`);
}

export function cliApprovalView(input: { who: string; approver: boolean; code: string; challenge: string; csrf: string }): string {
  return page("Approve terminal sign-in", `<h1>Sign in to the Ephyra CLI?</h1>
<p>Signed in as ${escape(input.who)}. Only approve if your terminal shows this code:</p><p class="code">${escape(input.code)}</p>
<form method="post" action="/auth/cli/approve">
<input type="hidden" name="challenge" value="${escape(input.challenge)}">
<input type="hidden" name="csrf" value="${escape(input.csrf)}">
<button type="submit">Approve</button></form><p>${role(input.approver)}</p>`);
}

export const cliApprovedView = () => page("Approved", "<h1>Approved</h1><p>Return to your terminal. You can close this tab.</p>");
export const cliExpiredView = () => page("Not approved", "<h1>This sign-in request expired</h1><p>Run <code>ephyra login</code> again.</p>");
export const signInFailedView = (message: string) => page("Sign-in failed",
  `<h1>Sign-in failed</h1><p>${escape(message)}</p><p><a href="/auth/login">Try signing in again</a></p>`);
