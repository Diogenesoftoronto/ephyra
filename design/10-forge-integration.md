# 10. Forge integration: GitHub, GitLab, Forgejo, Tangled and Radicle

Status: building (2026-11-12). Owner: lead. Read `AGENTS.md`, `design/02-platform.md` §1 (forge adapters) and §7
(security) first.

## Why

Ephyra lands fixes. Today a personal workspace can only push branches over HTTPS (`RemoteGitAdapter`), Tangled pulls need
service auth that no workspace has, and a Radicle workspace is read-only. Ephyra itself is published on Tangled, Radicle
and GitHub at once, and a fix that lands on one of them must reach the others. Codeberg is excluded on purpose: its terms
disallow AI-generated contributions, so Ephyra refuses `codeberg.org` as a landing or mirror target. Other Forgejo
instances are allowed.

## Contract already in place (commit 875520d)

- `LandingMode` has `pull_request`: open a reviewable proposal on the workspace's own forge.
- `adapterForMode(mode, adapters)` in `packages/forge/src/landing.ts` maps `pull_request` to the first adapter named in
  `PROPOSAL_FORGES = ["github", "gitlab", "forgejo", "tangled", "radicle"]`. There is never a fallback to a plain push.

## Lane F (packages/forge only): hosted pull requests

`packages/forge/src/hosted.ts`, exported from `src/index.ts`:

```ts
export type HostedProvider = "github" | "gitlab" | "forgejo";
export type HostedPullOptions = {
  provider: HostedProvider;
  /** API root: https://api.github.com, https://gitlab.com/api/v4, https://<forgejo>/api/v1. GitHub Enterprise allowed. */
  apiBase: string;
  /** "owner/name" (GitHub, Forgejo) or the full project path (GitLab, may contain subgroups). */
  repository: string;
  baseBranch: string;
  /** Called per request; never stored, logged or put in a URL. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
  repoDir: string;          // the workspace mirror
  remote: string;           // HTTPS clone URL without credentials
  run?: CommandRunner;      // git push of the head branch goes through RemoteGitAdapter semantics
  ledger: OperationLedger;
  scope: string;
  authorize: () => Promise<void>;
};
export class HostedPullAdapter implements ForgeAdapter { readonly name: HostedProvider; ... }
export function hostedProviderFor(cloneUrl: string): { provider: HostedProvider; apiBase: string; repository: string } | null;
```

Behavior:
1. `capabilities`: landing modes `trail_ref`, `pull_request`, `auto_land`; `proposals: true`; `events: true`.
2. `prepareLanding(trail, "pull_request", base, proofDigest)`: same plan shape as the other adapters, head branch
   `ephyra/<trailId>`, title and body from the trail and proof digest. The body is plain text that never includes signal
   text, logs or any other untrusted content beyond the trail's own summary fields.
3. `land`: push the head branch (force-with-lease against the recorded expected value), then create the PR/MR.
   Idempotent by operation key and by head branch: before creating, look up an open PR/MR for that head and reuse it.
   A create that times out or returns an ambiguous status throws `ReconciliationRequired`; it is never retried blindly.
   The receipt records the PR/MR number and web URL exactly as the API returned them.
4. `revert`: open a revert PR/MR for a merged one; for an unmerged one, close it.
5. `events(cursor)`: poll for review state, review comments, check/pipeline status and merged/closed, as `ForgeEvent`s.
   The cursor is opaque base64url JSON. Comment bodies are untrusted data.
6. `auto_land` keeps `RemoteGitAdapter` semantics (fast-forward push to the base branch).
7. `hostedProviderFor`: github.com and GitHub Enterprise (`/api/v3`), gitlab.com and self-hosted GitLab (only when told the
   host is GitLab), Forgejo/Gitea hosts. `codeberg.org` returns null and the constructor throws for it.
8. Every API call: HTTPS only, `Authorization` header only, bounded response size, 15 s timeout, no redirects to another
   host, rate-limit responses (403/429 with retry headers) surface as `Unverified` with the reset time.

Tests (recorded fixtures under `src/fixtures/hosted/`, no network): create, reuse an existing PR, ambiguous create →
`ReconciliationRequired`, revert, events paging and cursor round trip, Codeberg refused, token never in a URL or error,
property tests for cursor round trips and head-branch naming. Live tests behind `EPHYRA_LIVE=1`.

## Lane S (apps/server, apps/console): wiring, mirrors and Radicle writes

Depends on lane F's exported names above; code against them and stub until F lands.

1. **Personal landing** (`apps/server/src/setup/personal-landing.ts`): when the workspace repository's forge is github,
   gitlab or forgejo, add a `HostedPullAdapter` built from `hostedProviderFor(cloneUrl)` and the workspace's stored token,
   next to the existing `RemoteGitAdapter`. Authority checks are unchanged: every write re-reads the account and refuses if
   the repository changed.
2. **Radicle writes**: a Radicle workspace can open patches (`radicle_patch` and `pull_request`). The deployment has its
   own Radicle identity (`EPHYRA_RADICLE_HOME`, passphrase from `EPHYRA_RADICLE_PASSPHRASE`, never logged); patches come
   from that identity, so it never needs the owner's key. Lift `repository_write_unavailable` in
   `setup/forge-repository.ts` only for patch pushes (`refs/patches`), never for the default branch. Without the env vars
   the workspace stays read-only and says why.
3. **Mirrors**: workspace settings gain `mirrors: { url, token? }[]` (max 5, same address rules as the repository,
   Codeberg refused, tokens sealed with `SecretBox` like `repoToken`). After a landing that moved the base branch
   (`auto_land`, or a proposal the forge reports merged), push the same commit to each mirror's base branch with
   force-with-lease. A mirror failure never fails the landing: it is recorded on the trail as a `mirror_failed` event with
   the mirror host only, and retried once on the next landing. Radicle mirrors are refused with a clear reason (only the
   owner's key can move their Radicle branches; the owner's own `git push` handles that).
4. **Console** (Settings → Repository): a Mirrors list (add, remove, last result per mirror) and, on the repository card,
   which proposal forge `pull_request` will use. No fictional data; unknown is shown as unknown.
5. Server README section, tests for each of the above (offline fixtures), and `bun run typecheck` in both apps.

Core changes beyond 875520d need the lead.
