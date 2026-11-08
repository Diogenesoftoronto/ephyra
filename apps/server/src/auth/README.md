# Agent access

Ephyra's `/auth.md` describes an auth.md-inspired claim profile bound to a
Not Organic DID. It supports anonymous registration with **no private access
before approval**. The agent supplies an intended owner DID and an exact HTTPS
repository URL and branch. A signed-in owner enters the agent's six-digit code
and reviews the repository and requested bootstrap permissions.

This is the `ephyra:notorganic-did-v1` profile. Ephyra's sign-in currently verifies
a DID, not an email address. Email-based `service_auth`, external provider
ID-JAG assertions and provider security-event revocation are unsupported and are
not advertised in discovery metadata.

## Authority and lifetime

Agent registrations, renewal assertions and access tokens are separate from
human sessions and CLI login grants. Agent credentials enter only the terminal
`/v1/agent/*` namespace. The supported scopes are `bootstrap:read`,
`bootstrap:context` and `bootstrap:run`; running setup is limited to supervised
mode and existing workspace grants. Read access is required for additional scopes.
Each owner claim permits one setup operation; another key cannot repeat baseline
spending. Reusing the original key returns the recorded run. They grant no human checkpoint, account
configuration, new spending, landing or arbitrary messaging authority.

Approval binds access to the owner DID, workspace ID, repository URL, branch and
the server-owned repository verification revision. Authentication and renewal
recheck that binding. Reconnecting a repository does not revive a previous
connection's grant. Approval can connect a repository when none is selected;
it never replaces a different selected repository. Private repository
credentials must be configured by the owner.

The claim secret lasts thirty minutes; a claim attempt lasts ten minutes.
The verification URL contains a random attempt secret, not the human code.
Five incorrect codes lock the registration, including across restarted attempts.
Polling begins at five seconds and increases when polled too quickly. Browser
approval requires the intended signed-in DID, exact Origin and a short-lived
CSRF receipt bound to the browser session and attempt.

Claimed registrations last thirty days. Access tokens last five minutes and are
stored only as hashes. Service-owned renewal assertions are standard HS256 JWTs
with `oauth-id-jag+jwt` type and an origin-bound HKDF-derived signing key. They
are not external provider identity claims. Assertions last up to one day;
successful exchanges return a renewed assertion within the registration's
remaining lifetime. Claiming changes the registration version and invalidates
preclaim credentials. Revocation invalidates all its access and renewal
credentials immediately. Owners can revoke access in `/agent/access` or the
authenticated account API; agents can revoke their registration through
`/oauth2/revoke`.

Claim materials are hashed at rest. The repository connection callback has one
durable owner; an ambiguous outcome requires reconciliation with saved account
settings rather than another blind connection attempt.

## Storage and operating limits

Memory and Convex stores share the same compare-and-swap contract. Convex makes
registrations, attempt counters, polling state and revocation durable across
server replicas and restarts. Memory mode loses those records on restart.
Registration admission is bounded to sixty requests per minute **per replica**;
it is not a distributed admission limit. The wrong-code and polling limits are
durable per registration when using Convex.

Owner listings return the **newest 100 historical registrations**, including
expired or revoked entries. Older registrations remain subject to their expiry
and binding checks and can be revoked by their known registration ID. The
listing does not currently expose pagination.

## Verification

Offline tests drive registration, browser approval, token exchange and
revocation against both Memory and `convex-test` using the actual Convex
functions. They check intended-owner and scope isolation, Origin/CSRF checks,
code and polling limits, expiry, signature/resource validation, preclaim
invalidation, repository revision changes, concurrent approval and ambiguous
connection reconciliation. Existing fake-issuer tests cover the bounded login
return target and human-session separation.

These tests do not establish live Not Organic sign-in, production repository
access, external provider identity support or deployed infrastructure behavior.
Those remain unverified until separately exercised with the configured service.
